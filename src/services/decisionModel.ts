import type {
  Alert,
  AlertSnapshot,
  CaseStatus,
  ConclusionVersion,
  ConclusionView,
  Evidence,
  EvidenceRef,
} from "../models/types";
import type { MockDatabase } from "./mockStorage";

/* -------------------------------------------------------------------------- */
/* 证据台账                                                                    */
/* -------------------------------------------------------------------------- */

/** 同一逻辑证据的最新版本行。 */
export const latestEvidenceOfSeries = (
  seriesId: string,
  evidence: Evidence[],
): Evidence | undefined =>
  evidence
    .filter((item) => item.seriesId === seriesId)
    .sort((a, b) => b.version - a.version)[0];

/** 案件的当前证据清单（每个系列只取最新版本），按提交时间倒序。 */
export const currentEvidence = (caseId: string, evidence: Evidence[]): Evidence[] =>
  evidence
    .filter((item) => item.caseId === caseId)
    .filter(
      (item) =>
        item.id === latestEvidenceOfSeries(item.seriesId, evidence)?.id,
    )
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));

export const evidenceToRef = (evidence: Evidence): EvidenceRef => ({
  evidenceId: evidence.id,
  seriesId: evidence.seriesId,
  title: evidence.title,
  version: evidence.version,
  strength: evidence.strength,
  submittedAt: evidence.submittedAt,
});

export const alertToSnapshot = (alert: Alert): AlertSnapshot => ({
  id: alert.id,
  version: alert.version,
  title: alert.title,
  status: alert.status,
  riskLevel: alert.riskLevel,
  score: alert.score,
  amount: alert.amount,
  caseId: alert.caseId,
});

/* -------------------------------------------------------------------------- */
/* 依据新鲜度                                                                  */
/* -------------------------------------------------------------------------- */

const snapshotChangedFields = (
  snapshot: AlertSnapshot,
  current?: Alert,
): string[] => {
  if (!current) {
    return ["告警已删除"];
  }
  const changed: string[] = [];
  if (current.version !== snapshot.version) changed.push("版本");
  if (current.status !== snapshot.status) changed.push("状态");
  if (current.riskLevel !== snapshot.riskLevel) changed.push("风险等级");
  if (current.score !== snapshot.score) changed.push("风险分");
  if (current.caseId !== snapshot.caseId) changed.push("案件归属");
  return changed;
};

/** 判定视图计算所需的最小数据集合（完整库或工作区子集均可）。 */
export interface DecisionData {
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  alerts: Alert[];
}

/** 实时计算结论的依据状态：已通过/已退回版本保留提交快照。 */
export const buildConclusionView = (
  conclusion: ConclusionVersion,
  data: DecisionData,
): ConclusionView => {
  const staleEvidence = conclusion.evidenceBasis.flatMap((ref) => {
    const frozen = data.evidence.find((item) => item.id === ref.evidenceId);
    const latest = latestEvidenceOfSeries(ref.seriesId, data.evidence);
    if (frozen && latest && latest.id !== frozen.id) {
      return [{ ref, latest }];
    }
    return [];
  });

  const changedAlerts = conclusion.alertBasis.map((snapshot) => ({
    snapshot,
    current: data.alerts.find((item) => item.id === snapshot.id),
    changed: snapshotChangedFields(
      snapshot,
      data.alerts.find((item) => item.id === snapshot.id),
    ),
  }));

  const isTerminal =
    conclusion.status === "approved" ||
    conclusion.status === "returned" ||
    conclusion.status === "conflict";

  let basisState = conclusion.basisState;
  if (conclusion.status === "invalidated") {
    basisState = "stale";
  } else if (basisState === "missing") {
    basisState = "missing";
  } else if (isTerminal) {
    // 已通过/退回/冲突草稿保留冻结快照，不随证据新版本漂移
    basisState = "frozen";
  } else if (staleEvidence.length > 0) {
    basisState = "stale";
  } else if (
    changedAlerts.some((item) => item.changed.length > 0) &&
    (conclusion.status === "submitted" || conclusion.status === "draft")
  ) {
    basisState = "stale";
  } else {
    basisState = "current";
  }

  let winner: ConclusionVersion | undefined;
  let winnerEvidenceBasis: EvidenceRef[] | undefined;
  let winnerAlertBasis: AlertSnapshot[] | undefined;
  if (conclusion.conflictsWithBatchId) {
    winner = data.conclusions.find(
      (item) => item.batchId === conclusion.conflictsWithBatchId,
    );
    winnerEvidenceBasis = winner?.evidenceBasis;
    winnerAlertBasis = winner?.alertBasis;
  }

  return {
    conclusion,
    evidenceBasis: conclusion.evidenceBasis,
    alertBasis: conclusion.alertBasis,
    basisState,
    staleEvidence,
    changedAlerts: changedAlerts.filter((item) => item.changed.length > 0),
    winner,
    winnerEvidenceBasis,
    winnerAlertBasis,
  };
};

/* -------------------------------------------------------------------------- */
/* 案件状态与统一视图                                                          */
/* -------------------------------------------------------------------------- */

export interface CaseDecisionState {
  caseId: string;
  effectiveStatus: CaseStatus;
  /** 当前应被复核/展示的结论（待复核、失效、缺失依据等）。 */
  activeConclusion?: ConclusionVersion;
  approvedConclusion?: ConclusionVersion;
  hasStaleBasis: boolean;
  hasMissingBasis: boolean;
  views: ConclusionView[];
}

/**
 * 统一判定状态：案件页、概览与导出都走这里，保证看到同一结果。
 * 存储的案件状态仅作为基线，结论依据状态会实时校正对外状态。
 */
export const getCaseDecisionState = (
  caseId: string,
  database: MockDatabase,
): CaseDecisionState => {
  const conclusions = database.conclusions
    .filter((item) => item.caseId === caseId)
    .sort((a, b) => b.version - a.version);
  const views = conclusions.map((item) =>
    buildConclusionView(item, database),
  );

  const approved = conclusions.find((item) => item.status === "approved");
  const submitted = conclusions.find(
    (item) => item.status === "submitted",
  );
  const latestDraft = conclusions.find((item) => item.status === "draft");
  const invalidated = conclusions.find(
    (item) => item.status === "invalidated",
  );
  const missing = conclusions.find((item) => item.basisState === "missing");

  const storedCase = database.cases.find((item) => item.id === caseId);
  let effectiveStatus: CaseStatus = storedCase?.status ?? "investigating";

  if (approved && effectiveStatus !== "closed") {
    effectiveStatus = "closed";
  } else if (missing && effectiveStatus !== "closed") {
    effectiveStatus = "supplement";
  } else if (invalidated && !submitted) {
    effectiveStatus = "investigating";
  } else if (submitted) {
    effectiveStatus = "pending_review";
  }

  const hasStaleBasis = views.some(
    (view) =>
      view.basisState === "stale" &&
      view.conclusion.status !== "approved" &&
      view.conclusion.status !== "returned",
  );
  const hasMissingBasis = conclusions.some(
    (item) =>
      item.basisState === "missing" && item.status !== "approved",
  );

  return {
    caseId,
    effectiveStatus,
    activeConclusion: submitted ?? invalidated ?? latestDraft,
    approvedConclusion: approved,
    hasStaleBasis,
    hasMissingBasis,
    views,
  };
};

export const basisStateLabel: Record<string, string> = {
  frozen: "依据已冻结",
  current: "依据为最新",
  stale: "依据已更新待重算",
  missing: "待补证",
};

/**
 * 把统一判定视图推导出的有效状态回写到案件行（不新增审计），
 * 保证案件页、概览以及直接读取案件状态的导出看到同一结果。
 * 返回是否发生了回写。
 */
export const reconcileCaseStatuses = (
  database: MockDatabase,
): boolean => {
  let changed = false;
  database.cases.forEach((item) => {
    const { effectiveStatus } = getCaseDecisionState(item.id, database);
    if (item.status !== effectiveStatus) {
      item.status = effectiveStatus;
      changed = true;
    }
  });
  return changed;
};
