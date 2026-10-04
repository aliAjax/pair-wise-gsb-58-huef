import {
  seedAlerts,
  seedAuditLogs,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
} from "../data/seed";
import type {
  Alert,
  AlertSnapshot,
  AuditLog,
  ConclusionVersion,
  DecisionBatch,
  Evidence,
  EvidenceRef,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
} from "../models/types";
import { getCaseDecisionState } from "./decisionModel";

export interface MockDatabase {
  schemaVersion: number;
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  auditLogs: AuditLog[];
  batches: DecisionBatch[];
}

export const CURRENT_SCHEMA_VERSION = 2;

const STORAGE_KEY = "bank-fraud-investigation-db-v2";
const LEGACY_STORAGE_KEY = "bank-fraud-investigation-db-v1";
const CRASH_KEY = "bank-fraud-investigation-crash-v2";

const createSeedDatabase = (): MockDatabase => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  alerts: structuredClone(seedAlerts),
  cases: structuredClone(seedCases),
  nodes: structuredClone(seedNodes),
  edges: structuredClone(seedEdges),
  evidence: structuredClone(seedEvidence),
  conclusions: structuredClone(seedConclusions),
  auditLogs: structuredClone(seedAuditLogs),
  batches: [],
});

/* -------------------------------------------------------------------------- */
/* 旧数据迁移与依据回填                                                        */
/* -------------------------------------------------------------------------- */

const toEvidenceRef = (evidence: Evidence): EvidenceRef => ({
  evidenceId: evidence.id,
  seriesId: evidence.seriesId,
  title: evidence.title,
  version: evidence.version,
  strength: evidence.strength,
  submittedAt: evidence.submittedAt,
});

const toAlertSnapshot = (alert: Alert): AlertSnapshot => ({
  id: alert.id,
  version: alert.version,
  title: alert.title,
  status: alert.status,
  riskLevel: alert.riskLevel,
  score: alert.score,
  amount: alert.amount,
  caseId: alert.caseId,
});

/**
 * 按提交时间回填旧结论依据：选取提交时刻之前已登记、
 * 且属于同一案件的证据（以其当前版本号回填）。
 * 告警则取结论提交时已关联到案件的告警（无法精确回放状态，按现状冻结）。
 * 试不出任何证据时标记 missing，案件转待补证。
 */
const backfillConclusionBasis = (
  conclusion: ConclusionVersion,
  database: MockDatabase,
): { changed: boolean; missing: boolean } => {
  if (conclusion.basisState) {
    return { changed: false, missing: conclusion.basisState === "missing" };
  }

  const submittedAt = Date.parse(conclusion.createdAt);
  const basisEvidence = database.evidence
    .filter(
      (item) =>
        item.caseId === conclusion.caseId &&
        Date.parse(item.submittedAt) <= submittedAt,
    )
    .sort(
      (a, b) =>
        Date.parse(a.submittedAt) - Date.parse(b.submittedAt) ||
        a.id.localeCompare(b.id),
    );
  const basisAlerts = database.alerts
    .filter(
      (item) =>
        item.caseId === conclusion.caseId &&
        Date.parse(item.detectedAt) <= submittedAt,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  conclusion.evidenceBasis = basisEvidence.map(toEvidenceRef);
  conclusion.alertBasis = basisAlerts.map(toAlertSnapshot);

  const missing = basisEvidence.length === 0;
  conclusion.basisState = missing ? "missing" : "frozen";

  if (missing) {
    conclusion.staleReason =
      "旧结论未携带证据版本，按提交时间回填时未找到在提交前登记的证据，需补证后重新提交。";
    const targetCase = database.cases.find(
      (item) => item.id === conclusion.caseId,
    );
    if (
      targetCase &&
      targetCase.status !== "closed" &&
      conclusion.status !== "approved"
    ) {
      targetCase.status = "supplement";
    }
  }

  return { changed: true, missing };
};

const appendBackfillAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at"> & { id: string; at: string },
): void => {
  if (database.auditLogs.some((item) => item.id === log.id)) {
    return;
  }
  database.auditLogs.unshift(log);
};

/** 把旧结构（含 v1 本地存储与首次播种的种子）规范化为当前结构并回填依据。 */
const normalizeDatabase = (raw: unknown): MockDatabase => {
  const database = raw as Partial<MockDatabase>;
  const normalized: MockDatabase = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    alerts: Array.isArray(database.alerts) ? database.alerts : [],
    cases: Array.isArray(database.cases) ? database.cases : [],
    nodes: Array.isArray(database.nodes) ? database.nodes : [],
    edges: Array.isArray(database.edges) ? database.edges : [],
    evidence: Array.isArray(database.evidence) ? database.evidence : [],
    conclusions: Array.isArray(database.conclusions)
      ? database.conclusions
      : [],
    auditLogs: Array.isArray(database.auditLogs) ? database.auditLogs : [],
    batches: Array.isArray(database.batches) ? database.batches : [],
  };

  // 告警补版本字段
  normalized.alerts.forEach((alert) => {
    if (typeof alert.version !== "number") {
      alert.version = 1;
    }
  });

  // 证据补系列与版本状态字段
  normalized.evidence.forEach((evidence) => {
    if (!evidence.seriesId) {
      evidence.seriesId = evidence.id;
    }
    if (!evidence.versionState) {
      evidence.versionState = "current";
    }
  });

  // 旧结论按提交时间回填证据版本与告警快照
  normalized.conclusions.forEach((conclusion) => {
    if (conclusion.evidenceBasis === undefined) {
      const result = backfillConclusionBasis(conclusion, normalized);
      const filled: ConclusionVersion = conclusion;
      const evidenceCount = Array.isArray(filled.evidenceBasis)
        ? filled.evidenceBasis.length
        : 0;
      const alertCount = Array.isArray(filled.alertBasis)
        ? filled.alertBasis.length
        : 0;
      if (result.changed) {
        appendBackfillAudit(normalized, {
          id: `LOG-BACKFILL-${conclusion.id}`,
          caseId: conclusion.caseId,
          at: conclusion.createdAt,
          actor: "系统",
          action: result.missing ? "依据回填失败转待补证" : "旧结论依据回填",
          detail: result.missing
            ? `${conclusion.id} 未携带证据版本，按提交时间 ${new Date(conclusion.createdAt).toLocaleString("zh-CN", { hour12: false })} 回填时未找到可用证据，已标记待补证。`
            : `${conclusion.id} 未携带证据版本，已按提交时间 ${new Date(conclusion.createdAt).toLocaleString("zh-CN", { hour12: false })} 回填 ${evidenceCount} 份证据版本与 ${alertCount} 条告警快照。`,
        });
      }
    } else if (!conclusion.basisState) {
      conclusion.basisState = "frozen";
    }
    // 防止意外的 undefined 字段
    if (!Array.isArray(conclusion.evidenceBasis)) {
      conclusion.evidenceBasis = [];
    }
    if (!Array.isArray(conclusion.alertBasis)) {
      conclusion.alertBasis = [];
    }
  });

  normalized.auditLogs.forEach((log) => {
    if (!("batchId" in log)) {
      log.batchId = undefined;
    }
  });

  // 依据状态推导的有效案件状态回写，保证页面、概览与导出一致
  normalized.cases.forEach((item) => {
    const { effectiveStatus } = getCaseDecisionState(item.id, normalized);
    if (item.status !== effectiveStatus) {
      item.status = effectiveStatus;
    }
  });

  return normalized;
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return normalizeDatabase(createSeedDatabase());
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as MockDatabase;
      const normalized = normalizeDatabase(parsed);
      if (!parsed.schemaVersion || parsed.schemaVersion < CURRENT_SCHEMA_VERSION) {
        writeDatabase(normalized);
      }
      return normalized;
    } catch {
      // 落盘损坏时退回种子（仍执行回填）
      const seeded = normalizeDatabase(createSeedDatabase());
      writeDatabase(seeded);
      return seeded;
    }
  }

  // 首次迁移：读取 v1 数据，否则播种
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  let database: MockDatabase;
  if (legacy) {
    try {
      database = normalizeDatabase(JSON.parse(legacy));
    } catch {
      database = normalizeDatabase(createSeedDatabase());
    }
  } else {
    database = normalizeDatabase(createSeedDatabase());
  }
  writeDatabase(database);
  return database;
};

export const writeDatabase = (database: MockDatabase): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  }
};

export const resetDatabase = (): MockDatabase => {
  const seeded = normalizeDatabase(createSeedDatabase());
  writeDatabase(seeded);
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    window.localStorage.removeItem(CRASH_KEY);
  }
  return seeded;
};

/* -------------------------------------------------------------------------- */
/* 写库中断模拟                                                                */
/* -------------------------------------------------------------------------- */

/** 打开后，下一次批次写库会在指定步骤前抛出（仅触发一次）。 */
export const armWriteCrash = (beforeStep: string): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      CRASH_KEY,
      JSON.stringify({ beforeStep, consumed: false }),
    );
  }
};

export const disarmWriteCrash = (): void => {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(CRASH_KEY);
  }
};

export const readCrashSetting = (): {
  beforeStep: string;
  consumed: boolean;
} | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(CRASH_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as { beforeStep: string; consumed: boolean };
  } catch {
    return null;
  }
};

/**
 * 模拟“写库中断”：在指定步骤首次出现时抛出异常并保留中断标记。
 * 恢复重试时直接放行，保证只补未完成项。
 */
export const simulateWriteFailure = (stepKey: string): void => {
  const setting = readCrashSetting();
  if (!setting || setting.consumed || setting.beforeStep !== stepKey) {
    return;
  }
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      CRASH_KEY,
      JSON.stringify({ ...setting, consumed: true }),
    );
  }
  throw new WriteInterruptedError(stepKey);
};

export class WriteInterruptedError extends Error {
  constructor(public readonly stepKey: string) {
    super(`写库在步骤 ${stepKey} 前中断`);
    this.name = "WriteInterruptedError";
  }
}

/* -------------------------------------------------------------------------- */

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const nowIso = (): string => new Date().toISOString();

export const appendAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at"> & { id?: string; at?: string },
): AuditLog => {
  const entry: AuditLog = {
    id: log.id ?? createId("LOG"),
    at: log.at ?? nowIso(),
    caseId: log.caseId,
    actor: log.actor,
    action: log.action,
    detail: log.detail,
    batchId: log.batchId,
  };
  // 批次上下文中使用确定性 ID；恢复重试按 ID 判重，绝不重复写入审计
  if (database.auditLogs.some((item) => item.id === entry.id)) {
    return database.auditLogs.find((item) => item.id === entry.id) ?? entry;
  }
  database.auditLogs.unshift(entry);
  return entry;
};
