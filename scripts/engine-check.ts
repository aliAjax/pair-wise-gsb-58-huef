/* eslint-disable no-console */
// 判定批次引擎的端到端校验：用内存 localStorage 驱动真实代码路径。
// 运行：npx esbuild scripts/engine-check.ts --bundle --platform=node --format=cjs | node
import {
  armCrashAfterStep,
  basisCurrent,
  completeSubmit,
  completeSupplementEvidence,
  completeReview,
  recoverInterruptedBatches,
} from "../src/services/decisionEngine";
import { readDatabase, resetDatabase } from "../src/services/mockStorage";
import { buildCaseOutcome, buildDashboardSummary } from "../src/services/caseView";

let failures = 0;
const check = (name: string, condition: boolean, detail = ""): void => {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const freshMemoryStorage = (): void => {
  const map = new Map<string, string>();
  const store = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };
  (globalThis as Record<string, unknown>).localStorage = store;
  (globalThis as Record<string, unknown>).window = { localStorage: store };
};

const scenarioOne = (): void => {
  console.log("场景 1：提交冻结依据 → 证据补版 → 草稿/待复核失效、已通过保留快照");
  freshMemoryStorage();
  resetDatabase();

  const before = readDatabase().conclusions.filter(
    (item) => item.caseId === "CASE-2026-017",
  );
  check("初始案件 017 有一份草稿", before.length === 1 && before[0].status === "draft");
  check(
    "草稿冻结 V2 设备日志",
    before[0].evidenceRefs.some((r) => r.evidenceId === "EV-017-002" && r.version === 2),
  );

  // 调查员提交新结论（冻结当前 3 份证据）
  const submitted = completeSubmit({
    caseId: "CASE-2026-017",
    actor: "林澜",
    disposition: "freeze",
    rationale: "资金快进快出且设备共用证据充分，建议冻结。",
    riskControls: ["暂停非柜面支付"],
    submit: true,
    arrivalAt: "2026-10-04T09:00:00+08:00",
  });
  check("提交成功入库", !submitted.lostRace && submitted.conclusion.status === "submitted");
  check(
    "提交冻结 3 份证据 + 3 条告警",
    submitted.conclusion.evidenceRefs.length === 3 &&
      submitted.conclusion.alertRefs.length === 3,
  );

  // 复核通过，保留快照
  const approved = completeReview({
    caseId: "CASE-2026-017",
    conclusionId: submitted.conclusion.id,
    decision: "approve",
    reviewerNote: "证据链完整，同意冻结。",
    actor: "赵平",
  });
  check("复核通过", approved.status === "approved");

  // 再产生一份草稿，引用旧证据版本
  const draft = completeSubmit({
    caseId: "CASE-2026-017",
    actor: "周明",
    disposition: "observe",
    rationale: "另一名调查员的补充观察意见草稿内容。",
    riskControls: [],
    submit: false,
    arrivalAt: "2026-10-04T10:00:00+08:00",
  });

  // 证据 EV-017-001 补 V2
  const result = completeSupplementEvidence({
    caseId: "CASE-2026-017",
    evidenceId: "EV-017-001",
    actor: "林澜",
    patch: {
      title: "交易明细提取单（补充对账）",
      source: "核心交易系统",
      strength: "strong",
      occurredAt: "2026-09-29T00:18:00+08:00",
      attachment: "trade-detail-20261004-v2.csv",
      note: "补充银企对账单据。",
    },
  });
  check("证据发布 V2", result.evidence.version === 2);
  check(
    "草稿被标记失效",
    draft.conclusion.status === "stale" ||
      readDatabase().conclusions.find((c) => c.id === draft.conclusion.id)?.status === "stale",
  );
  const approvedAfter = readDatabase().conclusions.find(
    (c) => c.id === approved.id,
  )!;
  check("已通过版本保持 approved 且快照保留", approvedAfter.status === "approved");
  check(
    "通过版本仍冻结旧证据 V1",
    approvedAfter.evidenceRefs.some((r) => r.evidenceId === "EV-017-001" && r.version === 1),
  );
  check("通过版本依据判定为历史快照（与台账不一致）", !basisCurrent(approvedAfter, readDatabase().evidence));

  const db = readDatabase();
  const outcome = buildCaseOutcome(
    db.cases.find((c) => c.id === "CASE-2026-017")!,
    db.conclusions,
    db.evidence,
  );
  check("统一出口锚定已通过版本", outcome.kind === "approved");
  check("统一出口统计到 1 份失效", outcome.staleCount >= 1);
};

const scenarioTwo = (): void => {
  console.log("场景 2：两位调查员并发提交，先到入库，后到保留草稿并看到两边依据");
  freshMemoryStorage();
  resetDatabase();

  const first = completeSubmit({
    caseId: "CASE-2026-017",
    actor: "林澜",
    disposition: "freeze",
    rationale: "林澜的冻结意见，超过十二个字的结论说明。",
    riskControls: ["冻结"],
    submit: true,
    arrivalAt: "2026-10-04T09:00:00+08:00",
  });
  const second = completeSubmit({
    caseId: "CASE-2026-017",
    actor: "周明",
    disposition: "observe",
    rationale: "周明的观察意见，与林澜同时提交的说明。",
    riskControls: [],
    submit: true,
    arrivalAt: "2026-10-04T09:00:01+08:00",
  });

  check("先到者入库为待复核", first.conclusion.status === "submitted" && !first.lostRace);
  check("后到者落败", second.lostRace && second.conclusion.status === "draft");
  check("后到者记录冲突批次", second.conclusion.conflictBatchId === first.batch.id);
  check(
    "后到者能看到先到者依据",
    (second.conclusion.conflictBasis?.evidenceRefs.length ?? 0) === 3 &&
      second.conclusion.conflictBasis?.createdBy === "林澜",
  );
  check(
    "后到者保留自己的依据",
    second.conclusion.evidenceRefs.length === 3,
  );
  check(
    "案件只有一份待复核结论",
    readDatabase().conclusions.filter(
      (c) => c.caseId === "CASE-2026-017" && c.status === "submitted",
    ).length === 1,
  );
  const audit = readDatabase().auditLogs;
  check(
    "审计记录并发落败动作",
    audit.some((log) => log.action === "并发提交保留草稿"),
  );
};

const scenarioThree = (): void => {
  console.log("场景 3：写库中断后续跑，只补未完成项，不多版本不多审计");
  freshMemoryStorage();
  resetDatabase();

  armCrashAfterStep("submit_conclusion", "insert_conclusion");
  let crashed = false;
  try {
    completeSubmit({
      caseId: "CASE-2026-017",
      actor: "林澜",
      disposition: "freeze",
      rationale: "中断演练：这是一份会在写入结论后崩溃的提交。",
      riskControls: ["冻结"],
      submit: true,
      arrivalAt: "2026-10-04T09:00:00+08:00",
    });
  } catch (error) {
    crashed = (error as Error).name === "BatchInterrupted";
  }
  check("在 insert_conclusion 后中断", crashed);

  const midDb = readDatabase();
  const interruptedBatch = midDb.batches.find(
    (b) => b.status === "interrupted" && b.kind === "submit_conclusion",
  );
  check("中断批次已落盘且步骤记录到 insert_conclusion", !!interruptedBatch);
  const conclusionCountMid = midDb.conclusions.filter(
    (c) => c.batchId === interruptedBatch?.id,
  ).length;
  check("中断时只写入 1 条结论", conclusionCountMid === 1);

  // 相同请求重试：应命中自己的中断批次续跑
  const retried = completeSubmit({
    caseId: "CASE-2026-017",
    actor: "林澜",
    disposition: "freeze",
    rationale: "中断演练：这是一份会在写入结论后崩溃的提交。",
    riskControls: ["冻结"],
    submit: true,
    arrivalAt: "2026-10-04T09:00:00+08:00",
  });
  check("重试后成功", retried.conclusion.status === "submitted");

  const finalDb = readDatabase();
  check(
    "没有多出版本（仍只有 1 条该批次结论）",
    finalDb.conclusions.filter((c) => c.batchId === interruptedBatch?.id).length === 1,
  );
  const batchAudit = finalDb.auditLogs.filter(
    (log) => log.batchId === interruptedBatch?.id,
  );
  check("该批次只有 1 条审计", batchAudit.length === 1);
  check(
    "批次状态已完成",
    finalDb.batches.find((b) => b.id === interruptedBatch?.id)?.status === "completed",
  );

  // 启动恢复对已完成数据是幂等的
  const report = recoverInterruptedBatches();
  check("再次恢复无中断批次", report.resumed === 0);
};

const scenarioFour = (): void => {
  console.log("场景 4：证据补版中断续跑，不重复追加版本");
  freshMemoryStorage();
  resetDatabase();

  armCrashAfterStep("supplement_evidence", "append_evidence_version");
  let crashed = false;
  const input = {
    caseId: "CASE-2026-017",
    evidenceId: "EV-017-003",
    actor: "林澜",
    patch: {
      title: "收款商户登记材料（电话核实）",
      source: "商户管理系统",
      strength: "strong" as const,
      occurredAt: "2026-10-04T08:00:00+08:00",
      attachment: "merchant-7791-v2.pdf",
      note: "已完成法人电话核实。",
    },
  };
  try {
    completeSupplementEvidence(input);
  } catch (error) {
    crashed = (error as Error).name === "BatchInterrupted";
  }
  check("补版在追加版本后中断", crashed);

  const retry = completeSupplementEvidence(input);
  check("续跑后证据为 V2", retry.evidence.version === 2);
  check("版本链只有 2 个版本", retry.evidence.versions.length === 2);
  const batch = readDatabase().batches.find(
    (b) => b.kind === "supplement_evidence",
  );
  check(
    "补版审计只有 1 条",
    readDatabase().auditLogs.filter((log) => log.batchId === batch?.id).length === 1,
  );
};

const scenarioFive = (): void => {
  console.log("场景 5：旧结论无证据版本时回填，无法回填标待补证，且不能复核通过");
  freshMemoryStorage();
  // 构造一个 v1 旧库：证据无 versions，结论无依据
  const legacy = {
    alerts: [
      {
        id: "AL-X1",
        title: "旧告警",
        account: "a",
        counterparty: "b",
        channel: "手机银行",
        amount: 100,
        riskLevel: "high",
        score: 90,
        status: "linked",
        detectedAt: "2026-09-01T00:00:00+08:00",
        tags: [],
        deviceId: "D",
        ip: "1.1.1.1",
        caseId: "CASE-X",
      },
    ],
    cases: [
      {
        id: "CASE-X",
        title: "旧案件",
        status: "pending_review",
        riskLevel: "high",
        owner: "林澜",
        openedAt: "2026-09-01T00:00:00+08:00",
        updatedAt: "2026-09-03T00:00:00+08:00",
        summary: "",
        alertIds: ["AL-X1"],
        nextReviewAt: "2026-09-04T00:00:00+08:00",
      },
    ],
    nodes: [],
    edges: [],
    evidence: [],
    conclusions: [
      {
        id: "CV-X1",
        caseId: "CASE-X",
        version: 1,
        status: "submitted",
        disposition: "freeze",
        rationale: "旧结论",
        riskControls: [],
        createdBy: "林澜",
        createdAt: "2026-09-03T00:00:00+08:00",
        reviewer: "赵平",
      },
    ],
    auditLogs: [],
  };
  const store = {
    getItem: (key: string) =>
      key === "bank-fraud-investigation-db-v1"
        ? JSON.stringify(legacy)
        : null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  };
  (globalThis as Record<string, unknown>).localStorage = store;
  (globalThis as Record<string, unknown>).window = { localStorage: store };

  const db = readDatabase();
  const migrated = db.conclusions.find((c) => c.id === "CV-X1")!;
  check("旧结论标记为待补证", migrated.basisStatus === "evidence_pending");
  check("旧告警仍可回填快照", migrated.alertRefs.length === 1 && migrated.alertRefs[0].mode === "backfilled");

  let blocked = false;
  try {
    completeReview({
      caseId: "CASE-X",
      conclusionId: "CV-X1",
      decision: "approve",
      reviewerNote: "尝试通过",
      actor: "赵平",
    });
  } catch (error) {
    blocked = /待补证|缺少证据/.test((error as Error).message);
  }
  check("待补证结论不能通过复核", blocked);

  const summary = buildDashboardSummary(readDatabase());
  check("概览不把待补证计入待复核", summary.pendingReview === 0);
};

const run = (): void => {
  scenarioOne();
  scenarioTwo();
  scenarioThree();
  scenarioFour();
  scenarioFive();
  if (failures > 0) {
    console.error(`\n${failures} 项校验失败`);
    process.exit(1);
  }
  console.log("\n全部引擎校验通过");
};

run();
