import { build as esbuild } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * 判定批次核心逻辑的无头验证：
 * 用内存版 localStorage 模拟浏览器，打包纯服务层后在 Node 中执行。
 */

const workspace = "/workspace";
const entry = `
export { readDatabase, resetDatabase, armWriteCrash, disarmWriteCrash } from ${JSON.stringify(join(workspace, "src/services/mockStorage.ts"))};
export { runBatch, recoverInterruptedBatches, getInterruptedBatches } from ${JSON.stringify(join(workspace, "src/services/decisionBatches.ts"))};
export { getCaseDecisionState, buildConclusionView, currentEvidence } from ${JSON.stringify(join(workspace, "src/services/decisionModel.ts"))};
`;

const dir = mkdtempSync(join(tmpdir(), "decision-batch-"));
const entryPath = join(dir, "entry.ts");
const outPath = join(dir, "bundle.mjs");
writeFileSync(entryPath, entry);

await esbuild({
  entryPoints: [entryPath],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: outPath,
  logLevel: "silent",
});

// ---- 内存 localStorage + window 桩 ----
const memory = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
};
globalThis.localStorage = globalThis.window.localStorage;

const mod = await import(pathToFileURL(outPath).href);
const {
  readDatabase,
  resetDatabase,
  armWriteCrash,
  runBatch,
  recoverInterruptedBatches,
  getInterruptedBatches,
  getCaseDecisionState,
  buildConclusionView,
  currentEvidence,
} = mod;

let passed = 0;
let failed = 0;
const assert = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const reqId = () => `REQ-TEST-${Math.random().toString(36).slice(2, 9)}`;
const case17 = "CASE-2026-017";
const case16 = "CASE-2026-016";
const case15 = "CASE-2026-015";

/* ================= 1. 旧结论回填 ================= */
console.log("\n[1] 旧结论按提交时间回填证据版本，回填不上标待补证");
resetDatabase();
let db = readDatabase();
const cv017 = db.conclusions.find((c) => c.id === "CV-017-001");
const cv016 = db.conclusions.find((c) => c.id === "CV-016-001");
const cv015 = db.conclusions.find((c) => c.id === "CV-015-001");
assert("CV-017-001 草稿回填 3 份证据", cv017.evidenceBasis.length === 3, `实际 ${cv017.evidenceBasis.length}`);
assert("CV-017-001 回填冻结告警 3 条", cv017.alertBasis.length === 3, `实际 ${cv017.alertBasis.length}`);
assert("CV-016-001 无可用证据标 missing", cv016.basisState === "missing", cv016.basisState);
assert("CV-015-001 回填到 1 份证据", cv015.evidenceBasis.length === 1, `实际 ${cv015.evidenceBasis.length}`);
const case16Row = db.cases.find((c) => c.id === case16);
assert("回填不上的案件转待补证", case16Row.status === "supplement", case16Row.status);
const backfillLogs = db.auditLogs.filter((l) => l.action.includes("回填"));
assert("三份旧结论各回填一条审计（3 条）", backfillLogs.length === 3, `实际 ${backfillLogs.length}`);
assert("含 1 条回填失败转待补证", backfillLogs.some((l) => l.action === "依据回填失败转待补证"));
// 再次读取不应重复回填审计
db = readDatabase();
assert("重复读取不重复回填审计", db.auditLogs.filter((l) => l.action.includes("回填")).length === 3);

/* ================= 2. 提交冻结依据 + 证据新版本失效 ================= */
console.log("\n[2] 提交冻结依据；证据新版本后草稿/待复核失效，已通过保留快照");
resetDatabase();
// 案件017：林澜提交
runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "freeze",
    rationale: "设备与资金链路一致，建议冻结。", riskControls: ["止付"],
    submit: true, requestId: reqId(),
  },
});
db = readDatabase();
let submitted = db.conclusions.find((c) => c.caseId === case17 && c.status === "submitted");
assert("提交结论存在", Boolean(submitted));
assert("提交冻结 3 份证据", submitted.evidenceBasis.length === 3);
assert("提交冻结 3 条告警", submitted.alertBasis.length === 3);
const frozenRef = submitted.evidenceBasis.find((r) => r.seriesId === "EV-017-001");
assert("冻结的是 V1", frozenRef.version === 1);

// 同案再保存一个草稿（也引用 EV-017-001）
runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "observe",
    rationale: "先存一份草稿观察后续材料补充情况再说。", riskControls: [],
    submit: false, requestId: reqId(),
  },
});
db = readDatabase();
let draft = db.conclusions.find((c) => c.caseId === case17 && c.status === "draft");
assert("草稿存在", Boolean(draft));

// 先复核通过 submitted（在补证据之前）——通过的版本稍后验证保留
runBatch({
  kind: "review_conclusion",
  input: {
    caseId: case17, actor: "赵平", conclusionId: submitted.id,
    decision: "approve", reviewerNote: "证据链完整，同意冻结。", requestId: reqId(),
  },
});
db = readDatabase();
const approved = db.conclusions.find((c) => c.id === submitted.id);
assert("复核通过", approved.status === "approved");
assert("案件关闭", db.cases.find((c) => c.id === case17).status === "closed");

// 给 EV-017-001 补 V2
runBatch({
  kind: "supplement_evidence",
  input: {
    caseId: case17, actor: "周明", seriesId: "EV-017-001",
    title: "交易明细提取单", source: "核心交易系统", strength: "strong",
    occurredAt: "2026-09-30T10:00:00+08:00", attachment: "trade-detail-v2.csv",
    note: "补充缺失的对手行流水。", requestId: reqId(),
  },
});
db = readDatabase();
const v2 = db.evidence.find((e) => e.seriesId === "EV-017-001" && e.version === 2);
assert("证据 V2 存在", Boolean(v2));
assert("V2 为当前版本", v2.versionState === "current");
const v1 = db.evidence.find((e) => e.seriesId === "EV-017-001" && e.version === 1);
assert("V1 被标记替代", v1.versionState === "superseded" && v1.supersededBy === v2.id);
const draftAfter = db.conclusions.find((c) => c.id === draft.id);
assert("草稿失效待重算", draftAfter.status === "invalidated");
assert("失效原因包含新版本", draftAfter.staleReason.includes("V2"));
const approvedAfter = db.conclusions.find((c) => c.id === approved.id);
assert("已通过版本状态不变", approvedAfter.status === "approved");
assert("已通过版本仍冻结 V1", approvedAfter.evidenceBasis.find((r) => r.seriesId === "EV-017-001").version === 1);
const approvedView = buildConclusionView(approvedAfter, db);
assert("已通过视图依据保持冻结", approvedView.basisState === "frozen");
const invalidatedView = buildConclusionView(draftAfter, db);
assert("失效结论视图为 stale", invalidatedView.basisState === "stale");

/* ================= 3. 并发提交 ================= */
console.log("\n[3] 两位调查员同时提交：先到入库，后到保留冲突草稿并看到两边依据");
resetDatabase();
// 案件017 现在有一个历史草稿；直接制造两笔提交
const first = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "freeze",
    rationale: "林澜的判定：资金往返证据充分建议冻结账户处理。", riskControls: ["止付"],
    submit: true, requestId: "REQ-FIRST",
  },
});
const second = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "周明", disposition: "observe",
    rationale: "周明的判定：控制关系仍有疑点建议先继续观察再决定。", riskControls: [],
    submit: true, requestId: "REQ-SECOND",
  },
});
db = readDatabase();
assert("先到返回结论", Boolean(first.conclusion) && first.conclusion.status === "submitted");
assert("后到返回冲突标记", Boolean(second.conflict), JSON.stringify(second.batch.status));
const winner = db.conclusions.find((c) => c.id === first.conclusion.id);
const conflict = db.conclusions.find((c) => c.status === "conflict");
assert("先到版本为待复核", winner.status === "submitted");
assert("后到版本为冲突草稿", Boolean(conflict));
assert("冲突草稿指向先到批次", conflict.conflictsWithBatchId === winner.batchId);
assert("案件只保留一个待复核结论", db.conclusions.filter((c) => c.caseId === case17 && c.status === "submitted").length === 1);
const conflictView = buildConclusionView(conflict, db);
assert("冲突草稿可见先到版本", conflictView.winner?.id === winner.id);
assert("两边证据依据都可见", conflictView.winnerEvidenceBasis.length === 3 && conflictView.evidenceBasis.length === 3);
const conflictAudits = db.auditLogs.filter((l) => l.action === "并发提交冲突");
assert("冲突只写一条审计", conflictAudits.length === 1);
assert("先到版本仍可复核通过", (() => {
  runBatch({
    kind: "review_conclusion",
    input: { caseId: case17, actor: "赵平", conclusionId: winner.id, decision: "approve", reviewerNote: "同意先到版本意见。", requestId: reqId() },
  });
  const after = readDatabase().conclusions.find((c) => c.id === winner.id);
  return after.status === "approved";
})());

/* ================= 4. 写库中断与恢复 ================= */
console.log("\n[4] 写库中断后从最近完整批次继续，重试只补未完成项，不多版本/审计");
resetDatabase();
armWriteCrash("create-version");
let interruptedError = null;
try {
  runBatch({
    kind: "submit_conclusion",
    input: {
      caseId: case17, actor: "林澜", disposition: "freeze",
      rationale: "中断演练的结论提交内容需要足够长才能通过校验。", riskControls: ["止付"],
      submit: true, requestId: "REQ-CRASH-1",
    },
  });
} catch (e) {
  interruptedError = e;
}
assert("中断抛出异常", interruptedError !== null);
db = readDatabase();
assert("存在 1 个中断批次", getInterruptedBatches(db).length === 1);
const partialBatch = getInterruptedBatches(db)[0];
assert("freeze-basis 已完成", partialBatch.steps[0].status === "done");
assert("create-version 未完成", partialBatch.steps[1].status === "pending");
assert("中断时结论尚未写入", !db.conclusions.some((c) => c.batchId === partialBatch.id));
const auditBefore = db.auditLogs.length;

// 用同一 requestId 恢复
const recovered = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "freeze",
    rationale: "中断演练的结论提交内容需要足够长才能通过校验。", riskControls: ["止付"],
    submit: true, requestId: "REQ-CRASH-1",
  },
});
db = readDatabase();
assert("恢复后批次已完成", recovered.batch.status === "committed");
const conclusionsForBatch = db.conclusions.filter((c) => c.batchId === partialBatch.id);
assert("恢复只产生 1 个结论版本", conclusionsForBatch.length === 1, `实际 ${conclusionsForBatch.length}`);
const auditsForBatch = db.auditLogs.filter((l) => l.batchId === partialBatch.id);
assert("恢复只产生 1 条批次审计", auditsForBatch.length === 1, `实际 ${auditsForBatch.length}`);
assert("审计总数只增加 1", db.auditLogs.length === auditBefore + 1, `${db.auditLogs.length} vs ${auditBefore + 1}`);
assert("无中断批次残留", getInterruptedBatches(db).length === 0);

// 再用同一 requestId 调一次：纯幂等，什么都不新增
const auditCountAfter = db.auditLogs.length;
const again = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "freeze",
    rationale: "中断演练的结论提交内容需要足够长才能通过校验。", riskControls: ["止付"],
    submit: true, requestId: "REQ-CRASH-1",
  },
});
db = readDatabase();
assert("重复请求幂等返回已提交批次", again.batch.status === "committed");
assert("重复请求不新增审计", db.auditLogs.length === auditCountAfter);

// 多批次中断后按时间恢复：在 audit 步骤中断的证据补充
armWriteCrash("audit");
let crashed2 = false;
try {
  runBatch({
    kind: "supplement_evidence",
    input: {
      caseId: case17, actor: "周明", seriesId: "EV-017-002",
      title: "设备指纹登录日志", source: "风控日志平台", strength: "strong",
      occurredAt: "2026-09-30T11:00:00+08:00", attachment: "device-v2.json",
      note: "补传认证方式明细。", requestId: "REQ-CRASH-2",
    },
  });
} catch {
  crashed2 = true;
}
assert("第二次中断发生", crashed2);
db = readDatabase();
assert("证据 V2 在审计前已落盘", db.evidence.some((e) => e.seriesId === "EV-017-002" && e.version === 2));
const resumedList = recoverInterruptedBatches();
assert("恢复接口恢复 1 个批次", resumedList.length === 1);
db = readDatabase();
assert("恢复后无中断批次", getInterruptedBatches(db).length === 0);
const v2EvidenceCount = db.evidence.filter((e) => e.seriesId === "EV-017-002" && e.version === 2).length;
assert("恢复不重复出证据版本", v2EvidenceCount === 1, `实际 ${v2EvidenceCount}`);
const resumeAuditCount = db.auditLogs.filter((l) => l.action === "证据补充新版本").length;
assert("恢复不重复审计", resumeAuditCount === 1, `实际 ${resumeAuditCount}`);

/* ================= 5. 统一判定视图一致性 ================= */
console.log("\n[5] 案件页/概览/导出共用同一判定状态");
resetDatabase();
runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "freeze",
    rationale: "提交后证据将更新，概览与案件页都应看到待重算。", riskControls: [],
    submit: true, requestId: reqId(),
  },
});
runBatch({
  kind: "supplement_evidence",
  input: {
    caseId: case17, actor: "周明", seriesId: "EV-017-003",
    title: "收款商户登记材料", source: "商户管理系统", strength: "strong",
    occurredAt: "2026-09-30T12:00:00+08:00", attachment: "merchant-v2.pdf",
    note: "现场核实材料补齐。", requestId: reqId(),
  },
});
db = readDatabase();
const state17 = getCaseDecisionState(case17, db);
assert("待复核结论失效后案件回到调查中", state17.effectiveStatus === "investigating", state17.effectiveStatus);
assert("案件被识别为依据过期", state17.hasStaleBasis === true);
const state16 = getCaseDecisionState(case16, db);
assert("016 案件识别为缺依据", state16.hasMissingBasis === true && state16.effectiveStatus === "supplement");

/* ================= 6. 告警关联与冻结/版本 ================= */
console.log("\n[6] 告警关联版本递增，提交时冻结，告警更新后快照保留差异");
resetDatabase();
runBatch({
  kind: "link_alerts",
  input: { caseId: case16, actor: "林澜", alertIds: ["AL-20260928-014"], requestId: reqId() },
});
db = readDatabase();
const linkedAlert = db.alerts.find((a) => a.id === "AL-20260928-014");
assert("新关联告警版本升到 v2", linkedAlert.version === 2, `实际 v${linkedAlert.version}`);
assert("告警已挂到 016", linkedAlert.caseId === case16);
// 016 原本缺证据，先补登记一份新证据再提交
runBatch({
  kind: "register_evidence",
  input: {
    caseId: case16, actor: "周明", title: "ATM 监控截图", source: "监控平台",
    strength: "medium", occurredAt: "2026-09-29T09:00:00+08:00",
    attachment: "atm-016.jpg", note: "提现人脸截图。", requestId: reqId(),
  },
});
const submitOutcome = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case16, actor: "周明", disposition: "freeze",
    rationale: "补证后提交：监控与设备信息一致，建议冻结。", riskControls: [],
    submit: true, requestId: reqId(),
  },
});
db = readDatabase();
const newConclusion = db.conclusions.find((c) => c.id === submitOutcome.conclusion.id);
const frozenAlert014 = newConclusion.alertBasis.find((a) => a.id === "AL-20260928-014");
assert("提交冻结告警 v2", frozenAlert014.version === 2);
// 之后告警被排除，版本再升
runBatch({
  kind: "update_alert_status",
  input: { alertId: "AL-20260928-014", status: "dismissed", actor: "林澜", requestId: reqId() },
});
db = readDatabase();
const alertNow = db.alerts.find((a) => a.id === "AL-20260928-014");
assert("排除后告警版本 v3", alertNow.version === 3);
const view = buildConclusionView(newConclusion, db);
const changed = view.changedAlerts.find((x) => x.snapshot.id === "AL-20260928-014");
assert("视图识别冻结告警已变化", Boolean(changed) && changed.changed.includes("版本") && changed.changed.includes("状态"));
assert("待复核结论告警变化后依据为 stale", view.basisState === "stale", view.basisState);
// 但冻结快照本身不变
assert("快照仍保留 v2", frozenAlert014.version === 2);

/* ================= 7. 台账当前版本视图 ================= */
console.log("\n[7] currentEvidence 每系列只返回最新版本");
resetDatabase();
runBatch({
  kind: "supplement_evidence",
  input: {
    caseId: case17, actor: "周明", seriesId: "EV-017-001",
    title: "交易明细提取单", source: "核心交易系统", strength: "strong",
    occurredAt: "2026-09-30T10:00:00+08:00", attachment: "v2.csv",
    note: "补版本。", requestId: reqId(),
  },
});
runBatch({
  kind: "supplement_evidence",
  input: {
    caseId: case17, actor: "周明", seriesId: "EV-017-001",
    title: "交易明细提取单", source: "核心交易系统", strength: "strong",
    occurredAt: "2026-09-30T12:00:00+08:00", attachment: "v3.csv",
    note: "再补版本。", requestId: reqId(),
  },
});
db = readDatabase();
const current = currentEvidence(case17, db.evidence);
const seriesRows = current.filter((e) => e.seriesId === "EV-017-001");
assert("当前清单每系列仅 1 行", seriesRows.length === 1);
assert("当前清单返回 V3", seriesRows[0]?.version === 3);
const allRows = db.evidence.filter((e) => e.seriesId === "EV-017-001");
assert("台账保留全部 3 个历史版本", allRows.length === 3);

/* ================= 8. 审计步骤中断恢复不重复 ================= */
console.log("\n[8] 批次在审计步骤中断：业务已完成，恢复仅补审计");
resetDatabase();
armWriteCrash("audit");
let crash8 = false;
try {
  runBatch({
    kind: "register_evidence",
    input: {
      caseId: case16, actor: "周明", title: "柜面开户凭证", source: "柜面系统",
      strength: "strong", occurredAt: "2026-09-29T10:00:00+08:00",
      attachment: "voucher-016.pdf", note: "开户双录凭证。", requestId: "REQ-CRASH-3",
    },
  });
} catch {
  crash8 = true;
}
assert("审计步骤中断抛出", crash8);
db = readDatabase();
const ev8 = db.evidence.find((e) => e.attachment === "voucher-016.pdf");
assert("证据已落盘", Boolean(ev8));
assert("审计尚未写入", !db.auditLogs.some((l) => l.batchId && l.detail?.includes("柜面开户凭证")));
recoverInterruptedBatches();
db = readDatabase();
assert("恢复后证据仍只有 1 行", db.evidence.filter((e) => e.attachment === "voucher-016.pdf").length === 1);
const audit8 = db.auditLogs.filter((l) => l.action === "新增证据" && l.batchId);
assert("恢复仅补 1 条审计", audit8.length === 1, `实际 ${audit8.length}`);
assert("无残留中断批次", getInterruptedBatches(db).length === 0);

/* ================= 9. 中断恢复期间撞上并发提交 ================= */
console.log("\n[9] 提交在落库结论前中断，另一人先完整入库，恢复者转冲突草稿");
resetDatabase();
// 中断点在结论版本写入之前：慢的一笔尚未把版本送入库
armWriteCrash("create-version");
let crash9 = false;
try {
  runBatch({
    kind: "submit_conclusion",
    input: {
      caseId: case17, actor: "林澜", disposition: "freeze",
      rationale: "林澜先发起但在版本写入前中断的提交内容需要足够长。", riskControls: ["止付"],
      submit: true, requestId: "REQ-SLOW",
    },
  });
} catch {
  crash9 = true;
}
assert("第一笔提交在中断点停下", crash9);
db = readDatabase();
assert("中断批次尚未写入结论版本", !db.conclusions.some((c) => c.id === "REQ-SLOW__conclusion"));
// 另一人完整提交成功，成为先到版本
const fast = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "周明", disposition: "release",
    rationale: "周明的提交在中断窗口内完整入库成为先到版本。", riskControls: [],
    submit: true, requestId: "REQ-FAST-2",
  },
});
db = readDatabase();
assert("窗口内提交成为待复核", fast.conclusion?.status === "submitted");
// 恢复第一笔：发现已有先到者，就地保留为冲突草稿（不新增版本/审计）
const slowResume = runBatch({
  kind: "submit_conclusion",
  input: {
    caseId: case17, actor: "林澜", disposition: "freeze",
    rationale: "林澜先发起但在版本写入前中断的提交内容需要足够长。", riskControls: ["止付"],
    submit: true, requestId: "REQ-SLOW",
  },
});
db = readDatabase();
assert("慢的一笔恢复后判定为冲突", slowResume.batch.status === "conflict", slowResume.batch.status);
assert("仍只有一个待复核结论", db.conclusions.filter((c) => c.caseId === case17 && c.status === "submitted").length === 1);
const slowConclusion = db.conclusions.find((c) => c.id === "REQ-SLOW__conclusion");
assert("后恢复版本为冲突草稿", slowConclusion?.status === "conflict");
assert("冲突草稿指向先到批次", slowConclusion?.conflictsWithBatchId === fast.conclusion.batchId);
const slowAudits = db.auditLogs.filter((l) => l.batchId === slowResume.batch.id);
assert("冲突只产生一条审计", slowAudits.length === 1, `实际 ${slowAudits.length}`);
const slowBatchCount = db.batches.filter((b) => b.requestId === "REQ-SLOW").length;
assert("慢批次只有一条批次记录", slowBatchCount === 1, `实际 ${slowBatchCount}`);
const slowVersionCount = db.conclusions.filter((c) => c.id === "REQ-SLOW__conclusion").length;
assert("慢结论未多出版本", slowVersionCount === 1, `实际 ${slowVersionCount}`);

/* ================= 汇总 ================= */
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
