export type RiskLevel = "high" | "medium" | "low";
export type AlertStatus = "new" | "triage" | "linked" | "dismissed";
export type CaseStatus =
  | "investigating"
  | "pending_review"
  | "supplement"
  | "closed";
export type EvidenceStrength = "strong" | "medium" | "weak";
export type NodeKind = "account" | "device" | "ip" | "merchant";
export type EdgeKind = "transfer" | "shared_device" | "shared_ip" | "payee";
export type CaseDisposition = "freeze" | "release" | "observe";
export type ConclusionStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "returned"
  | "invalidated"
  | "conflict";
export type BasisState = "frozen" | "current" | "stale" | "missing";
export type EvidenceVersionState = "current" | "superseded";
export type BatchKind =
  | "submit_conclusion"
  | "supplement_evidence"
  | "review_conclusion"
  | "register_evidence"
  | "link_alerts"
  | "update_alert_status";
export type BatchStatus =
  | "interrupted"
  | "committed"
  | "conflict"
  | "failed";
export type BatchStepStatus = "done" | "pending";

export interface Alert {
  id: string;
  title: string;
  account: string;
  counterparty: string;
  channel: string;
  amount: number;
  riskLevel: RiskLevel;
  score: number;
  status: AlertStatus;
  detectedAt: string;
  tags: string[];
  deviceId: string;
  ip: string;
  caseId?: string;
  /** 告警内容版本，内容或归属变化时递增；冻结时记录具体版本。 */
  version: number;
}

/** 冻结在判定批次中的告警快照。 */
export interface AlertSnapshot {
  id: string;
  version: number;
  title: string;
  status: AlertStatus;
  riskLevel: RiskLevel;
  score: number;
  amount: number;
  caseId?: string;
}

export interface GraphNodeData {
  label: string;
  kind: NodeKind;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  occurredAt: string;
}

export interface InvestigationNode {
  id: string;
  caseId: string;
  position: { x: number; y: number };
  data: GraphNodeData;
}

export interface InvestigationEdge {
  id: string;
  caseId: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
}

/**
 * 证据台账中的一个版本行。同一份逻辑证据（seriesId 相同）可以有多个版本，
 * 旧版本在新版本提交后置为 superseded 但永久保留。
 */
export interface Evidence {
  /** 版本行 ID，全局唯一、永久不变。 */
  id: string;
  /** 逻辑证据系列 ID，补充版本时沿用。 */
  seriesId: string;
  caseId: string;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  submittedAt: string;
  submittedBy: string;
  attachment: string;
  note: string;
  version: number;
  versionState: EvidenceVersionState;
  /** 新版本行 ID（被补充时回填）。 */
  supersededBy?: string;
}

/** 结论冻结的证据引用（证据行级别，含版本）。 */
export interface EvidenceRef {
  evidenceId: string;
  seriesId: string;
  title: string;
  version: number;
  strength: EvidenceStrength;
  submittedAt: string;
}

export interface ConclusionVersion {
  id: string;
  caseId: string;
  version: number;
  status: ConclusionStatus;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  createdBy: string;
  createdAt: string;
  reviewer: string;
  reviewerNote?: string;
  /** 产出该结论的判定批次。 */
  batchId?: string;
  /** 冻结的证据版本引用。 */
  evidenceBasis: EvidenceRef[];
  /** 冻结的告警快照。 */
  alertBasis: AlertSnapshot[];
  /** 依据回填/校验状态。 */
  basisState: BasisState;
  /** 依据失效说明（被哪些证据新版本替代）。 */
  staleReason?: string;
  /** 冲突草稿对应的先入库结论批次。 */
  conflictsWithBatchId?: string;
  /** 复核通过时冻结的最终快照标记。 */
  approvedAt?: string;
}

export interface InvestigationCase {
  id: string;
  title: string;
  status: CaseStatus;
  riskLevel: RiskLevel;
  owner: string;
  openedAt: string;
  updatedAt: string;
  summary: string;
  alertIds: string[];
  nextReviewAt: string;
}

export interface AuditLog {
  id: string;
  caseId?: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  /** 归属的判定批次，恢复重试时按此判重，绝不重复写入。 */
  batchId?: string;
}

/** 判定批次的单个步骤，逐步落盘，写库中断后从未完成步骤继续。 */
export interface BatchStep {
  key: string;
  label: string;
  status: BatchStepStatus;
  at?: string;
}

/**
 * 可恢复判定批次：证据台账、结论复核、告警关联与审计记录
 * 在一个批次内原子地推进，步骤级持久化保证可恢复且不重复。
 */
export interface DecisionBatch {
  id: string;
  requestId: string;
  caseId?: string;
  kind: BatchKind;
  actor: string;
  status: BatchStatus;
  createdAt: string;
  committedAt?: string;
  /** 幂等输入（JSON），同一 requestId 的重试只补未完成步骤。 */
  payload: string;
  steps: BatchStep[];
  /** 产出的结论 ID（提交批次）。 */
  resultConclusionId?: string;
  /** 冲突时先入库的结论 ID（后到者保留草稿时使用）。 */
  winnerConclusionId?: string;
  /** 冲突时先入库的批次 ID。 */
  winnerBatchId?: string;
  note?: string;
}

export interface AlertFilters {
  keyword: string;
  riskLevel: RiskLevel | "all";
  status: AlertStatus | "all";
  channel: string;
}

export interface CaseWorkspace {
  case: InvestigationCase;
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
}

/** 概览/案件页/导出统一使用的结论判定视图。 */
export interface ConclusionView {
  conclusion: ConclusionVersion;
  evidenceBasis: EvidenceRef[];
  alertBasis: AlertSnapshot[];
  basisState: BasisState;
  /** 冻结证据中已有新版本的引用。 */
  staleEvidence: Array<{ ref: EvidenceRef; latest: Evidence }>;
  /** 冻结告警与当前告警的差异。 */
  changedAlerts: Array<{
    snapshot: AlertSnapshot;
    current?: Alert;
    changed: string[];
  }>;
  /** 冲突时先入库的结论（后到者可见两边依据）。 */
  winner?: ConclusionVersion;
  winnerEvidenceBasis?: EvidenceRef[];
  winnerAlertBasis?: AlertSnapshot[];
}

export interface DashboardSummary {
  newAlerts: number;
  highRiskAlerts: number;
  activeCases: number;
  pendingReview: number;
  staleBasisCases: number;
  missingBasisCases: number;
  interruptedBatches: number;
  totalExposure: number;
  caseStatusCounts: Record<CaseStatus, number>;
  riskCounts: Record<RiskLevel, number>;
}
