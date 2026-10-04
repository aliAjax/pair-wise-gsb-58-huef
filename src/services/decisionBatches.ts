import type {
  Alert,
  AlertSnapshot,
  AuditLog,
  BatchKind,
  BatchStep,
  CaseDisposition,
  ConclusionVersion,
  DecisionBatch,
  Evidence,
} from "../models/types";
import {
  createId,
  nowIso,
  readDatabase,
  simulateWriteFailure,
  writeDatabase,
  type MockDatabase,
} from "./mockStorage";
import {
  alertToSnapshot,
  currentEvidence,
  evidenceToRef,
  getCaseDecisionState,
} from "./decisionModel";

/* -------------------------------------------------------------------------- */
/* 批次输入                                                                    */
/* -------------------------------------------------------------------------- */

export interface SubmitConclusionInput {
  caseId: string;
  actor: string;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  submit: boolean;
  requestId: string;
}

export interface SupplementEvidenceInput {
  caseId: string;
  actor: string;
  seriesId: string;
  title: string;
  source: string;
  strength: Evidence["strength"];
  occurredAt: string;
  attachment: string;
  note: string;
  requestId: string;
}

export interface RegisterEvidenceInput extends Omit<SupplementEvidenceInput, "seriesId"> {}

export interface ReviewConclusionInput {
  caseId: string;
  actor: string;
  conclusionId: string;
  decision: "approve" | "return";
  reviewerNote: string;
  requestId: string;
}

export interface LinkAlertsInput {
  caseId: string;
  actor: string;
  alertIds: string[];
  requestId: string;
}

export interface UpdateAlertStatusInput {
  actor: string;
  alertId: string;
  status: Alert["status"];
  requestId: string;
}

export type BatchInput =
  | { kind: "submit_conclusion"; input: SubmitConclusionInput }
  | { kind: "supplement_evidence"; input: SupplementEvidenceInput }
  | { kind: "register_evidence"; input: RegisterEvidenceInput }
  | { kind: "review_conclusion"; input: ReviewConclusionInput }
  | { kind: "link_alerts"; input: LinkAlertsInput }
  | { kind: "update_alert_status"; input: UpdateAlertStatusInput };

export interface BatchOutcome {
  batch: DecisionBatch;
  conclusion?: ConclusionVersion;
  conflict?: {
    winnerConclusionId: string;
    winnerBatchId: string;
  };
}

export class BatchValidationError extends Error {}
export class BatchConflictError extends Error {
  constructor(
    public readonly outcome: BatchOutcome,
  ) {
    super("同一案件已有先到的待复核结论");
    this.name = "BatchConflictError";
  }
}
export class BatchInterruptedError extends Error {
  constructor(
    public readonly batch: DecisionBatch,
    public readonly stepKey: string,
  ) {
    super(`判定批次在步骤 ${stepKey} 中断`);
    this.name = "BatchInterruptedError";
  }
}

/* -------------------------------------------------------------------------- */
/* 确定性 ID                                                                   */
/* -------------------------------------------------------------------------- */

const deterministic = (requestId: string, suffix: string): string =>
  `${requestId}__${suffix}`;

const persist = (database: MockDatabase): void => {
  writeDatabase(database);
};

/** 依据结论/证据的最新状态校正案件状态，保证各页面与导出一致。 */
const reconcileCases = (database: MockDatabase): void => {
  if (database.cases.length === 0) {
    return;
  }
  database.cases.forEach((item) => {
    const { effectiveStatus } = getCaseDecisionState(item.id, database);
    if (item.status !== effectiveStatus) {
      item.status = effectiveStatus;
    }
  });
};

/* -------------------------------------------------------------------------- */
/* 各批次的步骤定义                                                            */
/* -------------------------------------------------------------------------- */

interface StepContext {
  database: MockDatabase;
  batch: DecisionBatch;
  input: BatchInput;
}

type StepExecutor = (context: StepContext) => void;

interface StepDefinition {
  key: string;
  label: string;
  run: StepExecutor;
}

const stepList = (definitions: Array<[string, string, StepExecutor]>): StepDefinition[] =>
  definitions.map(([key, label, run]) => ({ key, label, run }));

const touchCase = (database: MockDatabase, caseId: string): void => {
  const target = database.cases.find((item) => item.id === caseId);
  if (target) {
    target.updatedAt = nowIso();
  }
};

const audit = (
  database: MockDatabase,
  batch: DecisionBatch,
  stepKey: string,
  log: Omit<AuditLog, "id" | "at" | "batchId">,
): void => {
  const id = deterministic(batch.requestId, `audit-${stepKey}`);
  if (database.auditLogs.some((item) => item.id === id)) {
    return;
  }
  database.auditLogs.unshift({
    id,
    at: nowIso(),
    batchId: batch.id,
    ...log,
  });
};

/* ----- 提交结论 ----- */

const computeFrozenBasis = (
  database: MockDatabase,
  caseId: string,
): { evidenceBasis: ConclusionVersion["evidenceBasis"]; alertBasis: AlertSnapshot[] } => {
  const targetCase = database.cases.find((item) => item.id === caseId);
  return {
    evidenceBasis: currentEvidence(caseId, database.evidence).map(evidenceToRef),
    alertBasis: database.alerts
      .filter((item) => targetCase?.alertIds.includes(item.id))
      .map(alertToSnapshot),
  };
};

const submitConclusionSteps = (
  input: SubmitConclusionInput,
): StepDefinition[] =>
  stepList([
    [
      "freeze-basis",
      "冻结证据版本与告警快照",
      ({ database }) => {
        // 冻结动作通过后续结论行中的快照持久化，这里只做提交前校验
        if (
          input.submit &&
          currentEvidence(input.caseId, database.evidence).length === 0
        ) {
          throw new BatchValidationError("案件尚无证据，不能提交复核，请先登记证据。");
        }
      },
    ],
    [
      "create-version",
      "写入结论版本",
      ({ database, batch }) => {
        // 幂等：恢复重试时结论已在库
        const existing = database.conclusions.find(
          (item) => item.batchId === batch.id,
        );
        if (existing) {
          return;
        }
        const nextVersion =
          database.conclusions
            .filter((item) => item.caseId === input.caseId)
            .reduce((max, item) => Math.max(max, item.version), 0) + 1;
        const { evidenceBasis, alertBasis } = computeFrozenBasis(
          database,
          input.caseId,
        );
        const conclusion: ConclusionVersion = {
          id: deterministic(input.requestId, "conclusion"),
          caseId: input.caseId,
          version: nextVersion,
          status: input.submit ? "submitted" : "draft",
          disposition: input.disposition,
          rationale: input.rationale,
          riskControls: input.riskControls,
          createdBy: input.actor,
          createdAt: nowIso(),
          reviewer: "赵平",
          batchId: batch.id,
          evidenceBasis,
          alertBasis,
          basisState: "current",
        };
        database.conclusions.unshift(conclusion);
      },
    ],
    [
      "transition-case",
      "流转案件状态",
      ({ database }) => {
        const target = database.cases.find((item) => item.id === input.caseId);
        if (target) {
          target.status = input.submit ? "pending_review" : "investigating";
        }
      },
    ],
    [
      "audit",
      "写入审计记录",
      ({ database, batch }) => {
        audit(database, batch, "audit", {
          caseId: input.caseId,
          actor: input.actor,
          action: input.submit ? "提交复核" : "保存结论草稿",
          detail: input.submit
            ? "结论已冻结当前证据版本与告警快照，进入待复核。"
            : "草稿已冻结当时的证据版本与告警快照，证据更新后草稿将失效重算。",
        });
      },
    ],
  ]);

/* ----- 证据补充版本 / 首次登记 ----- */

const newEvidenceId = (requestId: string): string =>
  deterministic(requestId, "evidence");

const supplementEvidenceSteps = (
  input: SupplementEvidenceInput,
  isNewSeries: boolean,
): StepDefinition[] =>
  stepList([
    [
      "write-version",
      "写入证据新版本",
      ({ database }) => {
        const evidenceId = newEvidenceId(input.requestId);
        if (database.evidence.some((item) => item.id === evidenceId)) {
          return;
        }
        const series = database.evidence.filter(
          (item) => item.seriesId === input.seriesId,
        );
        const nextVersion = isNewSeries
          ? 1
          : series.reduce((max, item) => Math.max(max, item.version), 0) + 1;
        const evidence: Evidence = {
          id: evidenceId,
          seriesId: input.seriesId,
          caseId: input.caseId,
          title: input.title,
          source: input.source,
          strength: input.strength,
          occurredAt: input.occurredAt,
          submittedAt: nowIso(),
          submittedBy: input.actor,
          attachment: input.attachment,
          note: input.note,
          version: nextVersion,
          versionState: "current",
        };
        database.evidence.unshift(evidence);
      },
    ],
    [
      "supersede-old",
      "旧版本标记为已替代",
      ({ database }) => {
        const evidence = database.evidence.find(
          (item) => item.id === newEvidenceId(input.requestId),
        );
        if (!evidence) {
          return;
        }
        database.evidence.forEach((item) => {
          if (
            item.seriesId === input.seriesId &&
            item.id !== evidence.id &&
            item.versionState === "current"
          ) {
            item.versionState = "superseded";
            item.supersededBy = evidence.id;
          }
        });
      },
    ],
    [
      "invalidate-conclusions",
      "草稿与待复核结论失效",
      ({ database }) => {
        if (isNewSeries) {
          return;
        }
        const evidence = database.evidence.find(
          (item) => item.id === newEvidenceId(input.requestId),
        );
        if (!evidence) {
          return;
        }
        database.conclusions.forEach((conclusion) => {
          if (
            conclusion.caseId === input.caseId &&
            (conclusion.status === "draft" ||
              conclusion.status === "submitted") &&
            conclusion.evidenceBasis.some(
              (ref) => ref.seriesId === input.seriesId,
            )
          ) {
            conclusion.status = "invalidated";
            conclusion.staleReason = `依据《${evidence.title}》已补充至 V${evidence.version}（${evidence.submittedBy} ${new Date(evidence.submittedAt).toLocaleString("zh-CN", { hour12: false })}），需基于新依据重算。`;
          }
        });
        // 若失效的是当前唯一待复核结论，案件回到调查中
        const hasSubmitted = database.conclusions.some(
          (item) =>
            item.caseId === input.caseId && item.status === "submitted",
        );
        const target = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (target && !hasSubmitted && target.status === "pending_review") {
          target.status = "investigating";
        }
      },
    ],
    [
      "touch-case",
      "更新案件时间",
      ({ database }) => touchCase(database, input.caseId),
    ],
    [
      "audit",
      "写入审计记录",
      ({ database, batch }) => {
        const evidence = database.evidence.find(
          (item) => item.id === newEvidenceId(input.requestId),
        );
        audit(database, batch, "audit", {
          caseId: input.caseId,
          actor: input.actor,
          action: isNewSeries ? "新增证据" : "证据补充新版本",
          detail: isNewSeries
            ? `《${input.title}》V1 已登记，来源 ${input.source}。`
            : `《${input.title}》补充至 V${evidence?.version ?? ""}；引用旧版本的草稿与待复核结论已失效，已通过版本保留提交快照。`,
        });
      },
    ],
  ]);

/* ----- 结论复核 ----- */

const reviewConclusionSteps = (
  input: ReviewConclusionInput,
): StepDefinition[] =>
  stepList([
    [
      "mark-review",
      "写入复核结果",
      ({ database }) => {
        const conclusion = database.conclusions.find(
          (item) => item.id === input.conclusionId,
        );
        if (!conclusion) {
          throw new BatchValidationError("结论不存在。");
        }
        if (conclusion.status !== "submitted") {
          throw new BatchValidationError("仅待复核结论可以执行复核。");
        }
        if (conclusion.basisState === "missing") {
          throw new BatchValidationError("该结论缺少证据版本依据，需先补证。");
        }
        conclusion.status = input.decision === "approve" ? "approved" : "returned";
        conclusion.reviewerNote = input.reviewerNote;
        if (input.decision === "approve") {
          conclusion.approvedAt = nowIso();
        }
      },
    ],
    [
      "transition-case",
      "流转案件状态",
      ({ database }) => {
        const target = database.cases.find((item) => item.id === input.caseId);
        if (target) {
          target.status = input.decision === "approve" ? "closed" : "supplement";
        }
      },
    ],
    [
      "audit",
      "写入审计记录",
      ({ database, batch }) => {
        audit(database, batch, "audit", {
          caseId: input.caseId,
          actor: input.actor,
          action: input.decision === "approve" ? "复核通过" : "退回补证",
          detail: `结论 ${input.conclusionId} ${input.decision === "approve" ? "通过，提交时冻结的证据版本与告警快照永久保留" : "退回，需依据新材料重算"}。${input.reviewerNote}`,
        });
      },
    ],
  ]);

/* ----- 告警关联 ----- */

const linkAlertsSteps = (input: LinkAlertsInput): StepDefinition[] =>
  stepList([
    [
      "link-alerts",
      "关联告警到案件",
      ({ database }) => {
        const target = database.cases.find((item) => item.id === input.caseId);
        if (!target) {
          throw new BatchValidationError("案件不存在。");
        }
        database.alerts.forEach((alert) => {
          if (input.alertIds.includes(alert.id)) {
            if (alert.caseId !== input.caseId) {
              alert.version += 1;
            }
            alert.caseId = input.caseId;
            alert.status = "linked";
          }
        });
        target.alertIds = Array.from(
          new Set([...target.alertIds, ...input.alertIds]),
        );
      },
    ],
    [
      "touch-case",
      "更新案件时间",
      ({ database }) => touchCase(database, input.caseId),
    ],
    [
      "audit",
      "写入审计记录",
      ({ database, batch }) => {
        audit(database, batch, "audit", {
          caseId: input.caseId,
          actor: input.actor,
          action: "批量关联告警",
          detail: `关联告警 ${input.alertIds.join("、")}；后续提交结论将冻结这些告警的当前版本。`,
        });
      },
    ],
  ]);

/* ----- 告警状态更新 ----- */

const updateAlertStatusSteps = (
  input: UpdateAlertStatusInput,
): StepDefinition[] =>
  stepList([
    [
      "update-status",
      "更新告警状态与版本",
      ({ database }) => {
        const alert = database.alerts.find((item) => item.id === input.alertId);
        if (!alert) {
          throw new BatchValidationError("告警不存在。");
        }
        // 幂等：恢复重试时不重复递增版本
        if (alert.status !== input.status) {
          alert.status = input.status;
          alert.version += 1;
        }
      },
    ],
    [
      "audit",
      "写入审计记录",
      ({ database, batch }) => {
        audit(database, batch, "audit", {
          caseId: database.alerts.find((a) => a.id === input.alertId)?.caseId,
          actor: input.actor,
          action: "更新告警状态",
          detail: `${input.alertId} 状态更新为 ${input.status}，告警版本递增。`,
        });
      },
    ],
  ]);

/* -------------------------------------------------------------------------- */
/* 批次执行引擎                                                                */
/* -------------------------------------------------------------------------- */

const buildSteps = (entry: BatchInput): StepDefinition[] => {
  switch (entry.kind) {
    case "submit_conclusion":
      return submitConclusionSteps(entry.input);
    case "supplement_evidence":
      return supplementEvidenceSteps(entry.input, false);
    case "register_evidence":
      return supplementEvidenceSteps(
        { ...entry.input, seriesId: deterministic(entry.input.requestId, "series") },
        true,
      );
    case "review_conclusion":
      return reviewConclusionSteps(entry.input);
    case "link_alerts":
      return linkAlertsSteps(entry.input);
    case "update_alert_status":
      return updateAlertStatusSteps(entry.input);
  }
};

const createBatchRecord = (entry: BatchInput): DecisionBatch => {
  const kind = entry.kind;
  const input = entry.input as { caseId?: string; actor: string; requestId: string };
  const definitions = buildSteps(entry);
  return {
    id: createId("BATCH"),
    requestId: input.requestId,
    caseId: input.caseId,
    kind,
    actor: input.actor,
    status: "interrupted",
    createdAt: nowIso(),
    payload: JSON.stringify(entry),
    steps: definitions.map<BatchStep>((definition) => ({
      key: definition.key,
      label: definition.label,
      status: "pending",
    })),
  };
};

/**
 * 执行（或恢复）一个判定批次。
 * - 步骤逐个执行并立即落盘；写库中断后再次调用只补 pending 步骤。
 * - 所有审计使用确定性 ID，恢复绝不产生重复版本或重复审计。
 */
export const runBatch = (entry: BatchInput): BatchOutcome => {
  let database = readDatabase();

  // 幂等：同一 requestId 的重试直接恢复既有批次
  const input = entry.input as { requestId: string };
  const existingBatch = database.batches.find(
    (item) => item.requestId === input.requestId,
  );

  let batch: DecisionBatch;
  if (existingBatch) {
    if (existingBatch.status === "committed") {
      return {
        batch: existingBatch,
        conclusion: database.conclusions.find(
          (item) => item.id === existingBatch.resultConclusionId,
        ),
      };
    }
    if (existingBatch.status === "conflict") {
      return conflictOutcome(existingBatch);
    }
    batch = existingBatch;
    batch.payload = JSON.stringify(entry);

    // 恢复提交批次时以最新库状态重新做并发守门
    if (entry.kind === "submit_conclusion" && entry.input.submit) {
      const winner = findPendingSubmission(
        database,
        entry.input.caseId,
        batch.id,
      );
      if (winner) {
        return rejectAsConflictDraft(database, batch, entry, winner);
      }
    }
  } else {
    batch = createBatchRecord(entry);

    // 并发守门：两位调查员同时提交同一案件
    if (entry.kind === "submit_conclusion" && entry.input.submit) {
      const winner = findPendingSubmission(database, entry.input.caseId, undefined);
      if (winner) {
        return rejectAsConflictDraft(database, batch, entry, winner);
      }
    }

    database.batches.unshift(batch);
    persist(database);
  }

  const definitions = buildSteps(
    JSON.parse(batch.payload) as BatchInput,
  );
  const parsedEntry = JSON.parse(batch.payload) as BatchInput;
  const context: StepContext = {
    database,
    batch,
    input: parsedEntry,
  };

  // 已完成步骤直接跳过：恢复重试只补未完成项。
  for (const definition of definitions) {
    const stepState = batch.steps.find((s) => s.key === definition.key);
    if (stepState?.status === "done") {
      continue;
    }

    // 在该步骤真正改库前模拟写库中断
    simulateWriteFailure(definition.key);

    try {
      definition.run(context);
    } catch (error) {
      if (error instanceof BatchValidationError) {
        batch.status = "failed";
        batch.note = error.message;
        persist(database);
        throw error;
      }
      throw error;
    }

    stepState!.status = "done";
    stepState!.at = nowIso();
    reconcileCases(database);
    persist(database);
  }

  batch.status = "committed";
  batch.committedAt = nowIso();
  const conclusion = database.conclusions.find(
    (item) => item.batchId === batch.id && item.status !== "conflict",
  );
  if (conclusion) {
    batch.resultConclusionId = conclusion.id;
  }
  reconcileCases(database);
  persist(database);

  return {
    batch,
    conclusion:
      batch.resultConclusionId !== undefined
        ? database.conclusions.find(
            (item) => item.id === batch.resultConclusionId,
          )
        : undefined,
  };
};

const findPendingSubmission = (
  database: MockDatabase,
  caseId: string,
  excludeBatchId: string | undefined,
): ConclusionVersion | undefined => {
  // 已完成的待复核结论
  const submitted = database.conclusions.find(
    (item) =>
      item.caseId === caseId &&
      item.status === "submitted" &&
      item.batchId !== excludeBatchId &&
      item.batchId !== undefined,
  );
  if (submitted) {
    return submitted;
  }
  // 写库中断且结论版本已经落盘的提交批次：恢复时它必然回到待复核，
  // 新提交必须让它先入库（结论行尚不存在的中断批次不算在途竞争者）
  const inFlightBatch = database.batches.find(
    (batch) =>
      batch.status === "interrupted" &&
      batch.kind === "submit_conclusion" &&
      batch.caseId === caseId &&
      batch.id !== excludeBatchId &&
      batch.steps.some(
        (step) => step.key === "create-version" && step.status === "done",
      ),
  );
  if (!inFlightBatch) {
    return undefined;
  }
  return database.conclusions.find(
    (item) => item.batchId === inFlightBatch.id,
  );
};

const conflictOutcome = (batch: DecisionBatch): BatchOutcome => ({
  batch,
  conclusion: undefined,
  conflict: batch.winnerConclusionId
    ? {
        winnerConclusionId: batch.winnerConclusionId,
        winnerBatchId: batch.winnerBatchId ?? "",
      }
    : undefined,
});

/**
 * 后到者：先到版本已入库，后到的提交降级为冲突草稿（保留其内容），
 * 审计只写一条，并记录先入库结论，供页面并排展示两边依据。
 */
const rejectAsConflictDraft = (
  database: MockDatabase,
  batch: DecisionBatch,
  entry: BatchInput,
  winner: ConclusionVersion,
): BatchOutcome => {
  if (entry.kind !== "submit_conclusion") {
    throw new BatchValidationError("冲突判定异常。");
  }
  const input = entry.input;
  const draftId = deterministic(input.requestId, "conclusion");
  const conflictAuditId = deterministic(input.requestId, "audit-conflict");

  // 恢复路径上冲突裁决可能已经执行过，保持幂等
  const existingDraft = database.conclusions.find(
    (item) => item.id === draftId,
  );
  if (existingDraft && existingDraft.status === "conflict") {
    batch.status = "conflict";
    batch.committedAt = batch.committedAt ?? nowIso();
    batch.resultConclusionId = existingDraft.id;
    batch.winnerConclusionId = winner.id;
    batch.winnerBatchId = winner.batchId;
    batch.note = "同一案件已有先到的待复核结论，后到提交保留为冲突草稿。";
    database.batches = [
      batch,
      ...database.batches.filter((item) => item.id !== batch.id),
    ];
    reconcileCases(database);
    persist(database);
    return conflictOutcome(batch);
  }

  // 恢复路径：该批次的结论行已按 submitted 写入，需要就地降级为冲突草稿，
  // 不能新增版本。
  const preExisting = database.conclusions.find(
    (item) => item.batchId === batch.id,
  );
  const evidenceBasis =
    preExisting?.evidenceBasis ??
    currentEvidence(input.caseId, database.evidence).map(evidenceToRef);
  const targetCase = database.cases.find((c) => c.id === input.caseId);
  const alertBasis =
    preExisting?.alertBasis ??
    database.alerts
      .filter((item) => targetCase?.alertIds.includes(item.id))
      .map(alertToSnapshot);

  let draft: ConclusionVersion;
  if (preExisting) {
    draft = preExisting;
    draft.status = "conflict";
    draft.basisState = "frozen";
    draft.conflictsWithBatchId = winner.batchId;
    draft.staleReason = `与 ${winner.createdBy} 先提交的 V${winner.version} 冲突，先到版本已入库，本版本保留为草稿。`;
  } else {
    const nextVersion =
      database.conclusions
        .filter((item) => item.caseId === input.caseId)
        .reduce((max, item) => Math.max(max, item.version), 0) + 1;
    draft = {
      id: draftId,
      caseId: input.caseId,
      version: nextVersion,
      status: "conflict",
      disposition: input.disposition,
      rationale: input.rationale,
      riskControls: input.riskControls,
      createdBy: input.actor,
      createdAt: nowIso(),
      reviewer: "赵平",
      batchId: batch.id,
      evidenceBasis,
      alertBasis,
      basisState: "frozen",
      conflictsWithBatchId: winner.batchId,
      staleReason: `与 ${winner.createdBy} 先提交的 V${winner.version} 冲突，先到版本已入库，本版本保留为草稿。`,
    };
    database.conclusions.unshift(draft);
  }

  batch.status = "conflict";
  batch.committedAt = nowIso();
  batch.resultConclusionId = draft.id;
  batch.winnerConclusionId = winner.id;
  batch.winnerBatchId = winner.batchId;
  batch.steps = batch.steps.map((step) => ({ ...step, status: "done" as const, at: nowIso() }));
  batch.note = "同一案件已有先到的待复核结论，后到提交保留为冲突草稿。";

  if (!database.auditLogs.some((item) => item.id === conflictAuditId)) {
    database.auditLogs.unshift({
      id: conflictAuditId,
      at: nowIso(),
      batchId: batch.id,
      caseId: input.caseId,
      actor: input.actor,
      action: "并发提交冲突",
      detail: `${input.actor} 的提交晚于 ${winner.createdBy} 的 V${winner.version}（批次 ${winner.batchId}），先到版本入库；后到版本保留草稿，两边冻结依据均可查看。`,
    });
  }

  database.batches = [
    batch,
    ...database.batches.filter((item) => item.id !== batch.id),
  ];
  reconcileCases(database);
  persist(database);
  return conflictOutcome(batch);
};

/* -------------------------------------------------------------------------- */
/* 中断恢复                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 从最近完整批次继续：找到所有 interrupted 批次，
 * 按创建时间从早到晚重放，只补未完成步骤。
 */
export const recoverInterruptedBatches = (): Array<{
  batch: DecisionBatch;
  resumed: boolean;
}> => {
  const database = readDatabase();
  const interrupted = database.batches
    .filter((item) => item.status === "interrupted")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return interrupted.map((batch) => {
    const entry = JSON.parse(batch.payload) as BatchInput;
    runBatch(entry);
    return { batch, resumed: true };
  });
};

export const getInterruptedBatches = (
  database: MockDatabase = readDatabase(),
): DecisionBatch[] =>
  database.batches.filter((item) => item.status === "interrupted");
