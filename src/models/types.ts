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
  // 依据的证据发布新版本后，草稿与待复核结论失效，需要重算
  | "stale";
export type BasisStatus = "frozen" | "backfilled" | "evidence_pending";
export type BasisRefMode = "frozen" | "backfilled";

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

export interface EvidenceVersion {
  version: number;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  submittedAt: string;
  submittedBy: string;
  attachment: string;
  note: string;
  supersededAt?: string;
}

export interface Evidence {
  // 稳定标识，证据补充新版本时保持不变
  id: string;
  caseId: string;
  // 以下为当前版本（head）的镜像，便于台账与时间轴直接展示
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  submittedAt: string;
  submittedBy: string;
  attachment: string;
  note: string;
  version: number;
  versions: EvidenceVersion[];
}

export interface FrozenEvidenceRef {
  evidenceId: string;
  version: number;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  mode: BasisRefMode;
}

export interface FrozenAlertRef {
  alertId: string;
  mode: BasisRefMode;
  snapshot: Alert;
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
  // 提交时冻结的依据：证据版本 + 告警快照
  evidenceRefs: FrozenEvidenceRef[];
  alertRefs: FrozenAlertRef[];
  basisStatus: BasisStatus;
  // 产生或处理该结论的判定批次
  batchId?: string;
  reviewerBatchId?: string;
  // 依据失效（证据发布新版本）
  staleReason?: string;
  invalidatedByBatchId?: string;
  // 并发提交时落败：指向先入库的结论 / 批次
  conflictWith?: string;
  conflictBatchId?: string;
  // 落败草稿中保留的另一方（先到者）依据，便于两边对照后重算
  conflictBasis?: {
    conclusionId?: string;
    batchId: string;
    createdBy: string;
    evidenceRefs: FrozenEvidenceRef[];
    alertRefs: FrozenAlertRef[];
  };
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
  // 判定批次步骤的幂等键，重试不会重复留痕
  dedupKey?: string;
  batchId?: string;
}

export type BatchKind =
  | "submit_conclusion"
  | "review_conclusion"
  | "supplement_evidence"
  | "link_alerts";

export interface SubmitBatchPayload {
  caseId: string;
  actor: string;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  submit: boolean;
  arrivalAt: string;
  attemptId: string;
  frozen?: {
    evidenceRefs: FrozenEvidenceRef[];
    alertRefs: FrozenAlertRef[];
  };
  invalidatedIds?: string[];
}

export interface ReviewBatchPayload {
  caseId: string;
  conclusionId: string;
  decision: "approve" | "return";
  reviewerNote: string;
  actor: string;
}

export interface SupplementBatchPayload {
  caseId: string;
  evidenceId: string;
  actor: string;
  patch: {
    title: string;
    source: string;
    strength: EvidenceStrength;
    occurredAt: string;
    attachment: string;
    note: string;
  };
  newVersion?: number;
  invalidatedIds?: string[];
}

export interface LinkBatchPayload {
  caseId: string;
  alertIds: string[];
  actor: string;
}

export type BatchPayload =
  | SubmitBatchPayload
  | ReviewBatchPayload
  | SupplementBatchPayload
  | LinkBatchPayload;

export interface DecisionBatch {
  id: string;
  caseId: string;
  kind: BatchKind;
  status: "interrupted" | "completed";
  role?: "winner" | "loser";
  conflictBatchId?: string;
  assignedVersion?: number;
  createdAt: string;
  completedAt?: string;
  stepsCompleted: string[];
  payloadHash: string;
  payload: BatchPayload;
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

export interface DashboardSummary {
  newAlerts: number;
  highRiskAlerts: number;
  activeCases: number;
  pendingReview: number;
  staleRecompute: number;
  totalExposure: number;
  caseStatusCounts: Record<CaseStatus, number>;
  riskCounts: Record<RiskLevel, number>;
}
