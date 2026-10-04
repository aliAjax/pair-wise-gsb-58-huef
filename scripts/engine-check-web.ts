/* eslint-disable no-console */
// 浏览器集成校验：模拟 window/localStorage + setTimeout，走 RTK Query 接口层与启动恢复。
// 运行：npm run engine:check:web
import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import { bankApi } from "../src/services/api";
import {
  recoverInterruptedBatches,
  armCrashAfterStep,
} from "../src/services/decisionEngine";
import { readDatabase } from "../src/services/mockStorage";

let failures = 0;
const check = (name: string, condition: boolean, detail = ""): void => {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const flushTimers = (ms = 600): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const setup = (): void => {
  const map = new Map<string, string>();
  const localStorageStub = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };
  (globalThis as Record<string, unknown>).window = {
    localStorage: localStorageStub,
    setTimeout,
    clearTimeout,
  };
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;
};

const makeStore = () => {
  const store = configureStore({
    reducer: { [bankApi.reducerPath]: bankApi.reducer },
    middleware: (getDefault) => getDefault().concat(bankApi.middleware),
  });
  setupListeners(store.dispatch);
  return store;
};

const unwrap = async <T>(
  promise: Promise<{ data?: T; error?: unknown }>,
): Promise<T> => {
  const result = await promise;
  if ("error" in result && result.error) {
    throw result.error;
  }
  return result.data as T;
};

const run = async (): Promise<void> => {
  console.log("Web 场景：接口层并发提交、崩溃恢复、统一结果一致");
  setup();
  const store = makeStore();

  await unwrap(
    store.dispatch(bankApi.endpoints.resetMockData.initiate(undefined)),
  );
  await flushTimers();

  const base = readDatabase();
  check("初始种子包含判定批次", base.batches.length >= 4);

  const trigger = store.dispatch;

  // 两位调查员同时提交同一案件
  const [first, second] = await Promise.all([
    unwrap(
      trigger(
        bankApi.endpoints.saveConclusion.initiate({
          caseId: "CASE-2026-017",
          actor: "林澜",
          disposition: "freeze",
          rationale: "接口层林澜的并发提交结论说明，超过十二个字。",
          riskControls: ["冻结非柜面"],
          submit: true,
          attemptId: "ATT-WEB-1",
        }),
      ),
    ),
    unwrap(
      trigger(
        bankApi.endpoints.saveConclusion.initiate({
          caseId: "CASE-2026-017",
          actor: "周明",
          disposition: "observe",
          rationale: "接口层周明的并发提交结论说明，超过十二个字。",
          riskControls: [],
          submit: true,
          attemptId: "ATT-WEB-2",
        }),
      ),
    ),
  ]);
  check("接口层先到者入库", first.conclusion.status === "submitted" && !first.lostRace);
  check("接口层后到者落败留草稿", second.lostRace && second.conclusion.status === "draft");
  check(
    "落败草稿含双方依据",
    second.conclusion.evidenceRefs.length > 0 &&
      (second.conclusion.conflictBasis?.evidenceRefs.length ?? 0) > 0,
  );

  // 概览、案件工作区、结果列表三个出口同源
  const dashboard = await unwrap(
    store.dispatch(bankApi.endpoints.getDashboard.initiate(undefined)),
  );
  const outcomes = await unwrap(
    store.dispatch(bankApi.endpoints.getCaseOutcomes.initiate(undefined)),
  );
  const workspace = await unwrap(
    store.dispatch(
      bankApi.endpoints.getCaseWorkspace.initiate("CASE-2026-017"),
    ),
  );
  const row = outcomes.find((item) => item.caseId === "CASE-2026-017");
  check(
    "工作区与结果列表判定一致",
    workspace.outcome.kind === row?.kind && row.kind === "pending_review",
  );
  check(
    "概览待复核数量与结果列表一致",
    dashboard.pendingReview ===
      outcomes.filter((item) => item.kind === "pending_review").length,
  );

  // 安排一次补版崩溃，验证重启恢复
  armCrashAfterStep("supplement_evidence", "append_evidence_version");
  let crashMessage = "";
  try {
    await unwrap(
      store.dispatch(
        bankApi.endpoints.supplementEvidence.initiate({
          caseId: "CASE-2026-017",
          evidenceId: "EV-017-003",
          actor: "林澜",
          patch: {
            title: "收款商户登记材料 V2",
            source: "商户管理系统",
            strength: "strong",
            occurredAt: "2026-10-04T08:00:00+08:00",
            attachment: "merchant-v2.pdf",
            note: "电话核实完成。",
          },
        }),
      ),
    );
  } catch (error) {
    crashMessage = (error as { error?: string; message?: string }).error ??
      (error as Error).message;
  }
  check("接口层返回可恢复错误", /中断/.test(crashMessage), crashMessage);
  const interruptedCount = readDatabase().batches.filter(
    (b) => b.status === "interrupted",
  ).length;
  check("崩溃后存在中断批次", interruptedCount >= 1);

  // 模拟应用重启
  const beforeAudit = readDatabase().auditLogs.length;
  const report = recoverInterruptedBatches();
  check("启动恢复处理了中断批次", report.resumed >= 1);
  const after = readDatabase();
  const evidence = after.evidence.find((e) => e.id === "EV-017-003")!;
  check("恢复后证据为 V2", evidence.version === 2 && evidence.versions.length === 2);
  const supplementBatches = after.batches.filter(
    (b) => b.kind === "supplement_evidence",
  );
  check("只产生一个补版批次", supplementBatches.length === 1);
  const supplementAudit = after.auditLogs.filter(
    (log) => log.batchId === supplementBatches[0].id,
  );
  check("补版审计只有 1 条", supplementAudit.length === 1);
  check("恢复没有凭空增加审计条数", after.auditLogs.length === beforeAudit + 1);

  // 再恢复一次应无操作
  const secondReport = recoverInterruptedBatches();
  check("二次恢复为 0", secondReport.resumed === 0);

  if (failures > 0) {
    console.error(`\n${failures} 项 Web 校验失败`);
    process.exit(1);
  }
  console.log("\n全部 Web 校验通过");
  process.exit(0);
};

void run();
