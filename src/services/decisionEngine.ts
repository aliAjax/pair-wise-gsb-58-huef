import type {
  Alert,
  ConclusionVersion,
  DecisionBatch,
  Evidence,
  FrozenAlertRef,
  FrozenEvidenceRef,
  LinkBatchPayload,
  ReviewBatchPayload,
  SubmitBatchPayload,
  SupplementBatchPayload,
} from "../models/types";
import {
  appendAudit,
  createId,
  nowIso,
  type MockDatabase,
  readDatabase,
  writeDatabase,
} from "./mockStorage";

/** 批次执行在某一步持久化之后抛出，模拟写库中断 */
export class BatchInterrupted extends Error {
  constructor(
    public batchId: string,
    public afterStep: string,
  ) {
    super(`批次 ${batchId} 在步骤 ${afterStep} 后写库中断`);
    this.name = "BatchInterrupted";
  }
}

export class BatchRejected extends Error {}

export interface CrashPoint {
  batchKind: DecisionBatch["kind"];
  afterStep: string;
}

const CRASH_FLAG = "bank-fraud-decision-crash-next";

/** 安排下一次对应批次在指定步骤落盘后中断（仅生效一次），用于演示与测试 */
export const armCrashAfterStep = (
  batchKind: DecisionBatch["kind"],
  afterStep: string,
): void => {
  if (typeof window === "undefined") {
    return;
  }
  const point: CrashPoint = { batchKind, afterStep };
  window.localStorage.setItem(CRASH_FLAG, JSON.stringify(point));
};

export const clearCrash = (): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(CRASH_FLAG);
};

const consumeCrash = (batch: DecisionBatch, step: string): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  const raw = window.localStorage.getItem(CRASH_FLAG);
  if (!raw) {
    return false;
  }
  try {
    const point = JSON.parse(raw) as CrashPoint;
    if (point.batchKind === batch.kind && point.afterStep === step) {
      window.localStorage.removeItem(CRASH_FLAG);
      return true;
    }
  } catch {
    window.localStorage.removeItem(CRASH_FLAG);
  }
  return false;
};

/** 业务负载指纹：同一逻辑请求重试时可识别并续跑 */
export const payloadHash = (value: unknown): string => {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const freezeBasis = (
  database: MockDatabase,
  caseId: string,
  mode: "frozen" | "backfilled" = "frozen",
): { evidenceRefs: FrozenEvidenceRef[]; alertRefs: FrozenAlertRef[] } => {
  const evidenceRefs: FrozenEvidenceRef[] = database.evidence
    .filter((item) => item.caseId === caseId)
    .map((item) => ({
      evidenceId: item.id,
      version: item.version,
      title: item.title,
      source: item.source,
      strength: item.strength,
      occurredAt: item.occurredAt,
      mode,
    }));
  const alertRefs: FrozenAlertRef[] = database.alerts
    .filter((item) => item.caseId === caseId)
    .map((item) => ({
      alertId: item.id,
      mode,
      snapshot: structuredClone(item),
    }));
  return { evidenceRefs, alertRefs };
};

const nextConclusionVersion = (
  database: MockDatabase,
  caseId: string,
): number =>
  database.conclusions.reduce(
    (max, item) => (item.caseId === caseId ? Math.max(max, item.version) : max),
    0,
  ) + 1;

interface BatchStep {
  name: string;
  run: (database: MockDatabase, batch: DecisionBatch) => void;
}

/**
 * 执行判定批次的固定步骤序列：每完成一步立即落盘并记录 stepsCompleted。
 * 续跑时跳过已完成步骤；所有步骤自身幂等，因此不会多出版本或审计。
 */
export const runBatchSteps = (
  initialBatch: DecisionBatch,
  steps: BatchStep[],
): DecisionBatch => {
  let batch = initialBatch;

  for (const step of steps) {
    if (batch.stepsCompleted.includes(step.name)) {
      continue;
    }
    const database = readDatabase();
    const stored = database.batches.find((item) => item.id === batch.id);
    if (stored) {
      batch = stored;
    }
    if (batch.stepsCompleted.includes(step.name)) {
      continue;
    }
    step.run(database, batch);
    batch.stepsCompleted.push(step.name);
    const isLast = batch.stepsCompleted.length === steps.length;
    batch.status = isLast ? "completed" : "interrupted";
    if (isLast) {
      batch.completedAt = nowIso();
    }
    const index = database.batches.findIndex((item) => item.id === batch.id);
    if (index >= 0) {
      database.batches[index] = batch;
    } else {
      database.batches.push(batch);
    }
    writeDatabase(database);
    if (consumeCrash(batch, step.name)) {
      throw new BatchInterrupted(batch.id, step.name);
    }
  }

  return batch;
};

const persistReservation = (batch: DecisionBatch): void => {
  const database = readDatabase();
  database.batches.push(batch);
  writeDatabase(database);
  if (consumeCrash(batch, "reserve")) {
    throw new BatchInterrupted(batch.id, "reserve");
  }
};

// ---------------------------------------------------------------------------
// 提交结论
// ---------------------------------------------------------------------------

export interface SubmitInput {
  caseId: string;
  actor: string;
  disposition: ConclusionVersion["disposition"];
  rationale: string;
  riskControls: string[];
  submit: boolean;
  arrivalAt?: string;
  attemptId?: string;
}

export interface SubmitOutcome {
  batch: DecisionBatch;
  conclusion: ConclusionVersion;
  lostRace: boolean;
  winnerConclusionId?: string;
}

export const completeSubmit = (input: SubmitInput): SubmitOutcome => {
  const arrivalAt = input.arrivalAt ?? nowIso();
  const payload: SubmitBatchPayload = {
    caseId: input.caseId,
    actor: input.actor,
    disposition: input.disposition,
    rationale: input.rationale,
    riskControls: input.riskControls,
    submit: input.submit,
    arrivalAt,
    attemptId: input.attemptId ?? createId("ATT"),
  };

  // 同一逻辑请求（相同 attemptId）重试：续跑自己未完成的占座批次，绝不产生第二个版本
  const database = readDatabase();
  const ownInterrupted =
    input.attemptId !== undefined
      ? database.batches.find(
          (item) =>
            item.kind === "submit_conclusion" &&
            item.status === "interrupted" &&
            (item.payload as SubmitBatchPayload).attemptId === input.attemptId,
        )
      : database.batches.find(
          (item) =>
            item.kind === "submit_conclusion" &&
            item.status === "interrupted" &&
            (item.payload as SubmitBatchPayload).caseId === input.caseId &&
            (item.payload as SubmitBatchPayload).actor === input.actor &&
            (item.payload as SubmitBatchPayload).submit === input.submit &&
            (item.payload as SubmitBatchPayload).rationale ===
              input.rationale,
        );
  if (ownInterrupted) {
    return resumeSubmit(ownInterrupted);
  }

  // 先到先得：在任何业务步骤之前“占座”，占座顺序即到达顺序。
  // 胜负在占座落盘的同一次读-改-写里原子决定，保证两位调查员同时提交时：
  // 先到者唯一入库，后到者唯一保留草稿。
  const database0 = readDatabase();
  const batch: DecisionBatch = {
    id: createId("BAT"),
    caseId: input.caseId,
    kind: "submit_conclusion",
    status: "interrupted",
    createdAt: arrivalAt,
    stepsCompleted: [],
    payloadHash: payloadHash(payload),
    payload,
  };
  const winner = database0.batches.find(
    (item) =>
      item.caseId === input.caseId &&
      item.kind === "submit_conclusion" &&
      (item.payload as SubmitBatchPayload).submit &&
      item.role === "winner" &&
      database0.conclusions.some(
        (c) => c.batchId === item.id && c.status === "submitted",
      ) &&
      batchEarlierThan(item, batch),
  );
  batch.role = input.submit ? (winner ? "loser" : "winner") : undefined;
  batch.conflictBatchId = winner?.id;
  database0.batches.push(batch);
  writeDatabase(database0);
  if (consumeCrash(batch, "reserve")) {
    throw new BatchInterrupted(batch.id, "reserve");
  }
  return resumeSubmit(batch);
};

const batchEarlierThan = (
  candidate: DecisionBatch,
  self: DecisionBatch,
): boolean =>
  Date.parse(candidate.createdAt) < Date.parse(self.createdAt) ||
  (Date.parse(candidate.createdAt) === Date.parse(self.createdAt) &&
    candidate.id < self.id);

/**
 * 找出同一案件并发提交中的先到批次：
 * - 仍中断、可能成为赢家的提交批次；或
 * - 其结论当前仍是“待复核”的赢家批次。
 * 已落败（loser）批次、其结论已被通过/退回/失效的批次不算竞争对手，
 * 因此复核退回后的下一轮重新提交不会被误判为并发落败。
 */
const findCompetingWinner = (
  database: MockDatabase,
  self: DecisionBatch,
): DecisionBatch | undefined =>
  database.batches
    .filter(
      (item) =>
        item.id !== self.id &&
        item.caseId === self.caseId &&
        item.kind === "submit_conclusion" &&
        item.role !== "loser" &&
        (item.payload as SubmitBatchPayload).submit &&
        batchEarlierThan(item, self),
    )
    .filter((item) => {
      // 明确是赢家提交（历史批次或已决出胜负的批次）
      if (item.role === "winner") {
        const conclusion = database.conclusions.find(
          (c) => c.batchId === item.id,
        );
        return conclusion?.status === "submitted";
      }
      // 角色未定的占座批次：仅当其结论已存在且待复核才算竞争赢家；
      // 纯草稿批次、尚未执行的批次不阻塞新提交
      const conclusion = database.conclusions.find(
        (c) => c.batchId === item.id,
      );
      return conclusion?.status === "submitted";
    })
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    )[0];

const resumeSubmit = (reserved: DecisionBatch): SubmitOutcome => {
  const payload = reserved.payload as SubmitBatchPayload;
  if (!payload.submit) {
    return runDraft(reserved);
  }
  if (reserved.role === "loser") {
    const winnerBatch =
      readDatabase().batches.find(
        (item) => item.id === reserved.conflictBatchId,
      ) ?? findCompetingWinner(readDatabase(), reserved);
    if (winnerBatch) {
      return runLoserSubmit(reserved, winnerBatch);
    }
  }
  return runWinnerSubmit(reserved);
};

const buildConclusion = (
  database: MockDatabase,
  batch: DecisionBatch,
  status: ConclusionVersion["status"],
  extras: Partial<ConclusionVersion> = {},
): ConclusionVersion => {
  const p = batch.payload as SubmitBatchPayload;
  return {
    id: createId("CV"),
    caseId: p.caseId,
    version: nextConclusionVersion(database, p.caseId),
    status,
    disposition: p.disposition,
    rationale: p.rationale,
    riskControls: [...p.riskControls],
    createdBy: p.actor,
    createdAt: p.arrivalAt,
    reviewer: "赵平",
    evidenceRefs: p.frozen!.evidenceRefs,
    alertRefs: p.frozen!.alertRefs,
    basisStatus: "frozen",
    batchId: batch.id,
    ...extras,
  };
};

const runDraft = (batch: DecisionBatch): SubmitOutcome => {
  const steps: BatchStep[] = [
    {
      name: "freeze_basis",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        if (!p.frozen) {
          p.frozen = freezeBasis(database, p.caseId);
        }
      },
    },
    {
      name: "insert_conclusion",
      run: (database, current) => {
        if (!database.conclusions.some((item) => item.batchId === current.id)) {
          database.conclusions.unshift(
            buildConclusion(database, current, "draft"),
          );
        }
      },
    },
    {
      name: "touch_case",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        const targetCase = database.cases.find((item) => item.id === p.caseId);
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
      },
    },
    {
      name: "audit",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        const conclusion = database.conclusions.find(
          (item) => item.batchId === current.id,
        )!;
        appendAudit(database, {
          caseId: p.caseId,
          actor: p.actor,
          action: "保存结论版本",
          detail: `${conclusion.id} V${conclusion.version} 已保存为草稿，冻结 ${p.frozen!.evidenceRefs.length} 份证据版本与 ${p.frozen!.alertRefs.length} 条告警快照。`,
          dedupKey: `${current.id}:audit`,
          batchId: current.id,
        });
      },
    },
  ];
  runBatchSteps(batch, steps);

  const finalDb = readDatabase();
  return {
    batch: finalDb.batches.find((item) => item.id === batch.id)!,
    conclusion: finalDb.conclusions.find((item) => item.batchId === batch.id)!,
    lostRace: false,
  };
};

const runWinnerSubmit = (batch: DecisionBatch): SubmitOutcome => {
  const steps: BatchStep[] = [
    {
      name: "freeze_basis",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        if (!p.frozen) {
          p.frozen = freezeBasis(database, p.caseId);
        }
      },
    },
    {
      name: "insert_conclusion",
      run: (database, current) => {
        if (!database.conclusions.some((item) => item.batchId === current.id)) {
          database.conclusions.unshift(
            buildConclusion(database, current, "submitted"),
          );
        }
      },
    },
    {
      name: "update_case",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        const targetCase = database.cases.find((item) => item.id === p.caseId);
        if (targetCase) {
          targetCase.status = "pending_review";
          targetCase.updatedAt = nowIso();
        }
      },
    },
    {
      name: "resolve_conflicts",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        const winnerConclusion = database.conclusions.find(
          (item) => item.batchId === current.id,
        )!;
        // 落败批次若先于自己完成（先到者中断、后到者先续跑），
        // 其草稿里先到者依据可能暂缺，在此补齐，保证两边依据都可见。
        database.batches
          .filter(
            (item) =>
              item.role === "loser" &&
              item.conflictBatchId === current.id &&
              item.status === "completed",
          )
          .forEach((loserBatch) => {
            const loserConclusion = database.conclusions.find(
              (item) => item.batchId === loserBatch.id,
            );
            if (loserConclusion && !loserConclusion.conflictBasis) {
              loserConclusion.conflictWith = winnerConclusion.id;
              loserConclusion.conflictBasis = {
                conclusionId: winnerConclusion.id,
                batchId: current.id,
                createdBy: p.actor,
                evidenceRefs: winnerConclusion.evidenceRefs,
                alertRefs: winnerConclusion.alertRefs,
              };
            }
          });
      },
    },
    {
      name: "audit",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        const conclusion = database.conclusions.find(
          (item) => item.batchId === current.id,
        )!;
        appendAudit(database, {
          caseId: p.caseId,
          actor: p.actor,
          action: "提交复核",
          detail: `${conclusion.id} V${conclusion.version} 提交，已冻结 ${p.frozen!.evidenceRefs.length} 份证据版本与 ${p.frozen!.alertRefs.length} 条告警快照。`,
          dedupKey: `${current.id}:audit`,
          batchId: current.id,
        });
      },
    },
  ];
  runBatchSteps(batch, steps);

  const finalDb = readDatabase();
  return {
    batch: finalDb.batches.find((item) => item.id === batch.id)!,
    conclusion: finalDb.conclusions.find((item) => item.batchId === batch.id)!,
    lostRace: false,
  };
};

const runLoserSubmit = (
  batch: DecisionBatch,
  winnerBatch: DecisionBatch,
): SubmitOutcome => {
  batch.role = "loser";
  batch.conflictBatchId = winnerBatch.id;

  const steps: BatchStep[] = [
    {
      name: "freeze_both_basis",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        if (!p.frozen) {
          // 后到者保留自己的依据；先到者依据在落草稿时一并快照
          p.frozen = freezeBasis(database, p.caseId);
        }
      },
    },
    {
      name: "insert_loser_draft",
      run: (database, current) => {
        if (database.conclusions.some((item) => item.batchId === current.id)) {
          return;
        }
        const winnerConclusion = database.conclusions.find(
          (item) => item.batchId === winnerBatch.id,
        );
        const winnerFrozen = (winnerBatch.payload as SubmitBatchPayload).frozen;
        database.conclusions.unshift(
          buildConclusion(database, current, "draft", {
            conflictWith: winnerConclusion?.id,
            conflictBatchId: winnerBatch.id,
            // 自己的依据在 evidenceRefs；先到者的依据在 conflictBasis，两边都可见
            conflictBasis: {
              conclusionId: winnerConclusion?.id,
              batchId: winnerBatch.id,
              createdBy: (winnerBatch.payload as SubmitBatchPayload).actor,
              evidenceRefs: winnerConclusion
                ? winnerConclusion.evidenceRefs
                : winnerFrozen?.evidenceRefs ?? [],
              alertRefs: winnerConclusion
                ? winnerConclusion.alertRefs
                : winnerFrozen?.alertRefs ?? [],
            },
          }),
        );
      },
    },
    {
      name: "audit",
      run: (database, current) => {
        const p = current.payload as SubmitBatchPayload;
        const conclusion = database.conclusions.find(
          (item) => item.batchId === current.id,
        )!;
        const winnerConclusion = database.conclusions.find(
          (item) => item.batchId === winnerBatch.id,
        );
        appendAudit(database, {
          caseId: p.caseId,
          actor: p.actor,
          action: "并发提交保留草稿",
          detail: `${p.actor} 的提交晚于先到批次 ${winnerBatch.id}${winnerConclusion ? `（${winnerConclusion.id} 已入库）` : ""}，已保留草稿 ${conclusion.id}，可对照双方依据后重算。`,
          dedupKey: `${current.id}:audit`,
          batchId: current.id,
        });
      },
    },
  ];
  runBatchSteps(batch, steps);

  const finalDb = readDatabase();
  const winnerConclusion = finalDb.conclusions.find(
    (item) => item.batchId === winnerBatch.id,
  );
  return {
    batch: finalDb.batches.find((item) => item.id === batch.id)!,
    conclusion: finalDb.conclusions.find((item) => item.batchId === batch.id)!,
    lostRace: true,
    winnerConclusionId: winnerConclusion?.id,
  };
};

// ---------------------------------------------------------------------------
// 复核
// ---------------------------------------------------------------------------

export interface ReviewInput {
  caseId: string;
  conclusionId: string;
  decision: "approve" | "return";
  reviewerNote: string;
  actor: string;
}

export const completeReview = (input: ReviewInput): ConclusionVersion => {
  const probe = readDatabase();
  const target = probe.conclusions.find(
    (item) => item.id === input.conclusionId && item.caseId === input.caseId,
  );
  if (!target) {
    throw new BatchRejected("结论不存在。");
  }
  if (target.status !== "submitted") {
    throw new BatchRejected("该结论不是待复核版本，不能再次复核。");
  }
  if (
    input.decision === "approve" &&
    target.basisStatus === "evidence_pending"
  ) {
    throw new BatchRejected("该结论缺少证据版本（待补证），无法通过，请退回补证后重新提交。");
  }

  // 同结论同判定的未完成复核批次直接续跑
  const interrupted = probe.batches.find(
    (item) =>
      item.kind === "review_conclusion" &&
      item.status === "interrupted" &&
      (item.payload as ReviewBatchPayload).conclusionId ===
        input.conclusionId,
  );
  const batch: DecisionBatch =
    interrupted ??
    ({
      id: createId("BAT"),
      caseId: input.caseId,
      kind: "review_conclusion",
      status: "interrupted",
      createdAt: nowIso(),
      stepsCompleted: [],
      payloadHash: payloadHash(input),
      payload: {
        caseId: input.caseId,
        conclusionId: input.conclusionId,
        decision: input.decision,
        reviewerNote: input.reviewerNote,
        actor: input.actor,
      } satisfies ReviewBatchPayload,
    } as DecisionBatch);
  if (!interrupted) {
    persistReservation(batch);
  }

  const steps: BatchStep[] = [
    {
      name: "update_conclusion",
      run: (database, current) => {
        const p = current.payload as ReviewBatchPayload;
        const conclusion = database.conclusions.find(
          (item) => item.id === p.conclusionId,
        );
        if (conclusion && conclusion.status === "submitted") {
          conclusion.status = p.decision === "approve" ? "approved" : "returned";
          conclusion.reviewerNote = p.reviewerNote;
          conclusion.reviewerBatchId = current.id;
        }
      },
    },
    {
      name: "update_case",
      run: (database, current) => {
        const p = current.payload as ReviewBatchPayload;
        const targetCase = database.cases.find((item) => item.id === p.caseId);
        if (targetCase) {
          targetCase.status = p.decision === "approve" ? "closed" : "supplement";
          targetCase.updatedAt = nowIso();
        }
      },
    },
    {
      name: "audit",
      run: (database, current) => {
        const p = current.payload as ReviewBatchPayload;
        appendAudit(database, {
          caseId: p.caseId,
          actor: p.actor,
          action: p.decision === "approve" ? "复核通过" : "退回补证",
          detail: `${p.conclusionId} 已${p.decision === "approve" ? "通过，提交快照保留" : "退回"}。${p.reviewerNote}`,
          dedupKey: `${current.id}:audit`,
          batchId: current.id,
        });
      },
    },
  ];
  runBatchSteps(batch, steps);

  return readDatabase().conclusions.find(
    (item) => item.id === input.conclusionId,
  )!;
};

// ---------------------------------------------------------------------------
// 证据补充新版本
// ---------------------------------------------------------------------------

export interface SupplementEvidenceInput {
  caseId: string;
  evidenceId: string;
  actor: string;
  patch: SupplementBatchPayload["patch"];
}

export const completeSupplementEvidence = (
  input: SupplementEvidenceInput,
): { evidence: Evidence; invalidated: ConclusionVersion[] } => {
  const probe = readDatabase();
  const targetEvidence = probe.evidence.find(
    (item) => item.id === input.evidenceId && item.caseId === input.caseId,
  );
  if (!targetEvidence) {
    throw new BatchRejected("证据不存在。");
  }

  const interrupted = probe.batches.find(
    (item) =>
      item.kind === "supplement_evidence" &&
      item.status === "interrupted" &&
      (item.payload as SupplementBatchPayload).evidenceId ===
        input.evidenceId,
  );
  const batch: DecisionBatch =
    interrupted ??
    ({
      id: createId("BAT"),
      caseId: input.caseId,
      kind: "supplement_evidence",
      status: "interrupted",
      createdAt: nowIso(),
      stepsCompleted: [],
      payloadHash: payloadHash(input),
      payload: {
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        actor: input.actor,
        patch: input.patch,
      } satisfies SupplementBatchPayload,
    } as DecisionBatch);
  if (!interrupted) {
    persistReservation(batch);
  }

  const steps: BatchStep[] = [
    {
      name: "append_evidence_version",
      run: (database, current) => {
        const p = current.payload as SupplementBatchPayload;
        const evidence = database.evidence.find(
          (item) => item.id === p.evidenceId,
        );
        if (!evidence) {
          throw new BatchRejected("证据不存在。");
        }
        if (p.newVersion === undefined) {
          p.newVersion = evidence.version + 1;
        }
        if (!evidence.versions.some((v) => v.version === p.newVersion)) {
          const submittedAt = nowIso();
          const oldHead = evidence.versions.find(
            (v) => v.version === evidence.version,
          );
          if (oldHead && !oldHead.supersededAt) {
            oldHead.supersededAt = submittedAt;
          }
          evidence.versions.push({
            version: p.newVersion,
            title: p.patch.title,
            source: p.patch.source,
            strength: p.patch.strength,
            occurredAt: p.patch.occurredAt,
            submittedAt,
            submittedBy: p.actor,
            attachment: p.patch.attachment,
            note: p.patch.note,
          });
          evidence.version = p.newVersion;
          evidence.title = p.patch.title;
          evidence.source = p.patch.source;
          evidence.strength = p.patch.strength;
          evidence.occurredAt = p.patch.occurredAt;
          evidence.submittedAt = submittedAt;
          evidence.submittedBy = p.actor;
          evidence.attachment = p.patch.attachment;
          evidence.note = p.patch.note;
        }
      },
    },
    {
      name: "invalidate_conclusions",
      run: (database, current) => {
        const p = current.payload as SupplementBatchPayload;
        if (!p.invalidatedIds) {
          p.invalidatedIds = database.conclusions
            .filter(
              (item) =>
                item.caseId === p.caseId &&
                (item.status === "draft" || item.status === "submitted") &&
                item.evidenceRefs.some(
                  (ref) =>
                    ref.evidenceId === p.evidenceId &&
                    ref.version < (p.newVersion ?? 1),
                ),
            )
            .map((item) => item.id);
        }
        p.invalidatedIds.forEach((conclusionId) => {
          const conclusion = database.conclusions.find(
            (item) => item.id === conclusionId,
          );
          if (
            conclusion &&
            (conclusion.status === "draft" ||
              conclusion.status === "submitted")
          ) {
            const frozenVersion =
              conclusion.evidenceRefs.find(
                (ref) => ref.evidenceId === p.evidenceId,
              )?.version ?? "?";
            conclusion.status = "stale";
            conclusion.staleReason = `依据证据 ${p.evidenceId} 已发布 V${p.newVersion}，冻结依据 V${frozenVersion} 失效，需按新证据重算。`;
            conclusion.invalidatedByBatchId = current.id;
          }
        });
      },
    },
    {
      name: "update_case",
      run: (database, current) => {
        const p = current.payload as SupplementBatchPayload;
        const targetCase = database.cases.find((item) => item.id === p.caseId);
        if (targetCase) {
          const stillPending = database.conclusions.some(
            (item) =>
              item.caseId === p.caseId && item.status === "submitted",
          );
          if (!stillPending && targetCase.status === "pending_review") {
            targetCase.status = "investigating";
          }
          targetCase.updatedAt = nowIso();
        }
      },
    },
    {
      name: "audit",
      run: (database, current) => {
        const p = current.payload as SupplementBatchPayload;
        appendAudit(database, {
          caseId: p.caseId,
          actor: p.actor,
          action: "证据补充新版本",
          detail: `证据 ${p.evidenceId} 发布 V${p.newVersion}；${p.invalidatedIds?.length ?? 0} 份草稿/待复核结论失效重算，已通过版本保留提交快照。`,
          dedupKey: `${current.id}:audit`,
          batchId: current.id,
        });
      },
    },
  ];
  runBatchSteps(batch, steps);

  const finalDb = readDatabase();
  const finished = finalDb.batches.find((item) => item.id === batch.id)!;
  const invalidatedIds =
    (finished.payload as SupplementBatchPayload).invalidatedIds ?? [];
  return {
    evidence: finalDb.evidence.find(
      (item) => item.id === input.evidenceId,
    )!,
    invalidated: finalDb.conclusions.filter((item) =>
      invalidatedIds.includes(item.id),
    ),
  };
};

// ---------------------------------------------------------------------------
// 告警关联（接入同一套可恢复批次）
// ---------------------------------------------------------------------------

export interface LinkAlertsInput {
  caseId: string;
  alertIds: string[];
  actor: string;
}

export const completeLinkAlerts = (input: LinkAlertsInput): Alert[] => {
  const probe = readDatabase();
  if (!probe.cases.some((item) => item.id === input.caseId)) {
    throw new BatchRejected("案件不存在。");
  }
  const interrupted = probe.batches.find(
    (item) =>
      item.kind === "link_alerts" &&
      item.status === "interrupted" &&
      (item.payload as LinkBatchPayload).caseId === input.caseId,
  );
  const batch: DecisionBatch =
    interrupted ??
    ({
      id: createId("BAT"),
      caseId: input.caseId,
      kind: "link_alerts",
      status: "interrupted",
      createdAt: nowIso(),
      stepsCompleted: [],
      payloadHash: payloadHash(input),
      payload: { ...input } satisfies LinkBatchPayload,
    } as DecisionBatch);
  if (!interrupted) {
    persistReservation(batch);
  }

  const steps: BatchStep[] = [
    {
      name: "link_alerts",
      run: (database, current) => {
        const p = current.payload as LinkBatchPayload;
        database.alerts = database.alerts.map((item) =>
          p.alertIds.includes(item.id)
            ? { ...item, caseId: p.caseId, status: "linked" as const }
            : item,
        );
        const targetCase = database.cases.find(
          (item) => item.id === p.caseId,
        );
        if (targetCase) {
          targetCase.alertIds = Array.from(
            new Set([...targetCase.alertIds, ...p.alertIds]),
          );
          targetCase.updatedAt = nowIso();
        }
      },
    },
    {
      name: "audit",
      run: (database, current) => {
        const p = current.payload as LinkBatchPayload;
        appendAudit(database, {
          caseId: p.caseId,
          actor: p.actor,
          action: "批量关联告警",
          detail: `关联告警 ${p.alertIds.join("、")}。`,
          dedupKey: `${current.id}:audit`,
          batchId: current.id,
        });
      },
    },
  ];
  runBatchSteps(batch, steps);

  return readDatabase().alerts.filter((item) =>
    input.alertIds.includes(item.id),
  );
};

// ---------------------------------------------------------------------------
// 启动恢复：按占座时间从早到晚续跑，只补未完成项
// ---------------------------------------------------------------------------

export interface RecoveryReport {
  resumed: number;
  batches: DecisionBatch[];
}

export const recoverInterruptedBatches = (): RecoveryReport => {
  const interrupted = readDatabase()
    .batches.filter((item) => item.status === "interrupted")
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  interrupted.forEach((batch) => {
    if (batch.kind === "submit_conclusion") {
      resumeSubmit(batch);
    } else if (batch.kind === "review_conclusion") {
      const p = batch.payload as ReviewBatchPayload;
      completeReview({
        caseId: p.caseId,
        conclusionId: p.conclusionId,
        decision: p.decision,
        reviewerNote: p.reviewerNote,
        actor: p.actor,
      });
    } else if (batch.kind === "supplement_evidence") {
      const p = batch.payload as SupplementBatchPayload;
      completeSupplementEvidence({
        caseId: p.caseId,
        evidenceId: p.evidenceId,
        actor: p.actor,
        patch: p.patch,
      });
    } else if (batch.kind === "link_alerts") {
      const p = batch.payload as LinkBatchPayload;
      completeLinkAlerts({
        caseId: p.caseId,
        alertIds: p.alertIds,
        actor: p.actor,
      });
    }
  });

  return { resumed: interrupted.length, batches: interrupted };
};

/** 结论冻结依据是否仍与台账当前版本一致 */
export const basisCurrent = (
  conclusion: ConclusionVersion,
  evidence: Evidence[],
): boolean => {
  if (conclusion.basisStatus === "evidence_pending") {
    return false;
  }
  return conclusion.evidenceRefs.every((ref) => {
    const item = evidence.find((e) => e.id === ref.evidenceId);
    return item ? item.version === ref.version : true;
  });
};
