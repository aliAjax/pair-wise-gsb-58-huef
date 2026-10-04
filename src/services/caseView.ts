import type {
  CaseDisposition,
  ConclusionVersion,
  DashboardSummary,
  Evidence,
  InvestigationCase,
  RiskLevel,
} from "../models/types";
import { basisCurrent } from "./decisionEngine";
import type { MockDatabase } from "./mockStorage";

/**
 * 案件当前判定结果。案件页、概览、导出只能从这里取结果，
 * 保证三处看到同一份结论与依据状态。
 */
export type OutcomeKind =
  | "approved"
  | "pending_review"
  | "stale_recompute"
  | "supplement"
  | "evidence_pending"
  | "drafting"
  | "empty";

export interface CaseOutcome {
  kind: OutcomeKind;
  label: string;
  caseId: string;
  /** 当前生效的判定版本（已通过 / 待复核 / 待补证等锚点） */
  anchorConclusion?: ConclusionVersion;
  /** 失效待重算的版本数量 */
  staleCount: number;
  /** 冲突草稿（并发提交落败、保留双方依据） */
  conflictDrafts: ConclusionVersion[];
  /** 依据是否与证据台账当前版本一致 */
  basisCurrent: boolean;
  disposition?: CaseDisposition;
}

const outcomeLabel: Record<OutcomeKind, string> = {
  approved: "已通过（快照保留）",
  pending_review: "待复核",
  stale_recompute: "依据失效 · 待重算",
  supplement: "退回补证",
  evidence_pending: "待补证（缺证据版本）",
  drafting: "草稿编辑中",
  empty: "尚无结论",
};

const selectAnchor = (
  conclusions: ConclusionVersion[],
): ConclusionVersion | undefined => {
  const sorted = [...conclusions].sort(
    (a, b) =>
      b.version - a.version ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  // 1. 最新待复核
  const submitted = sorted.find((item) => item.status === "submitted");
  if (submitted) {
    return submitted;
  }
  // 2. 最高版本的已通过版本（快照保留，不被新证据覆盖）
  const approved = sorted.find((item) => item.status === "approved");
  if (approved) {
    return approved;
  }
  // 3. 最新失效版本
  const stale = sorted.find((item) => item.status === "stale");
  if (stale) {
    return stale;
  }
  // 4. 最新退回版本
  const returned = sorted.find((item) => item.status === "returned");
  if (returned) {
    return returned;
  }
  // 5. 最新草稿（并发落败的冲突草稿也算编辑态）
  return sorted.find((item) => item.status === "draft");
};

export const buildCaseOutcome = (
  investigationCase: InvestigationCase,
  conclusions: ConclusionVersion[],
  evidence: Evidence[],
): CaseOutcome => {
  const caseConclusions = conclusions.filter(
    (item) => item.caseId === investigationCase.id,
  );
  const staleCount = caseConclusions.filter(
    (item) => item.status === "stale",
  ).length;
  const conflictDrafts = caseConclusions.filter(
    (item) => item.status === "draft" && item.conflictBatchId,
  );
  const anchor = selectAnchor(caseConclusions);

  let kind: OutcomeKind;
  if (!anchor) {
    kind = "empty";
  } else if (anchor.status === "submitted") {
    kind =
      anchor.basisStatus === "evidence_pending"
        ? "evidence_pending"
        : "pending_review";
  } else if (anchor.status === "approved") {
    kind = "approved";
  } else if (anchor.status === "stale") {
    kind = "stale_recompute";
  } else if (anchor.status === "returned") {
    kind =
      anchor.basisStatus === "evidence_pending"
        ? "evidence_pending"
        : "supplement";
  } else {
    kind = "drafting";
  }

  return {
    kind,
    label: outcomeLabel[kind],
    caseId: investigationCase.id,
    anchorConclusion: anchor,
    staleCount,
    conflictDrafts,
    basisCurrent: anchor ? basisCurrent(anchor, evidence) : true,
    disposition: anchor?.disposition,
  };
};

export interface CaseOutcomeRow extends CaseOutcome {
  case: InvestigationCase;
  evidenceCount: number;
  alertCount: number;
}

export const buildCaseOutcomes = (
  database: MockDatabase,
): CaseOutcomeRow[] =>
  database.cases.map((investigationCase) => ({
    case: investigationCase,
    evidenceCount: database.evidence.filter(
      (item) => item.caseId === investigationCase.id,
    ).length,
    alertCount: investigationCase.alertIds.length,
    ...buildCaseOutcome(
      investigationCase,
      database.conclusions,
      database.evidence,
    ),
  }));

export const buildDashboardSummary = (
  database: MockDatabase,
): DashboardSummary => {
  const outcomes = buildCaseOutcomes(database);
  const caseStatusCounts: DashboardSummary["caseStatusCounts"] = {
    investigating: 0,
    pending_review: 0,
    supplement: 0,
    closed: 0,
  };
  const riskCounts: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0 };

  database.cases.forEach((item) => {
    caseStatusCounts[item.status] += 1;
    riskCounts[item.riskLevel] += 1;
  });

  return {
    newAlerts: database.alerts.filter((item) => item.status === "new").length,
    highRiskAlerts: database.alerts.filter(
      (item) => item.riskLevel === "high",
    ).length,
    activeCases: database.cases.filter((item) => item.status !== "closed")
      .length,
    // 与案件页同一出口：只有真正待复核的待复核结论计数
    pendingReview: outcomes.filter(
      (item) => item.kind === "pending_review",
    ).length,
    staleRecompute: outcomes.filter(
      (item) => item.kind === "stale_recompute",
    ).length,
    totalExposure: database.alerts.reduce(
      (sum, item) => sum + item.amount,
      0,
    ),
    caseStatusCounts,
    riskCounts,
  };
};
