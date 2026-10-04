import {
  seedAlerts,
  seedAuditLogs,
  seedBatches,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
} from "../data/seed";
import type {
  Alert,
  AuditLog,
  ConclusionVersion,
  DecisionBatch,
  Evidence,
  FrozenAlertRef,
  FrozenEvidenceRef,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
} from "../models/types";

export interface MockDatabase {
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  auditLogs: AuditLog[];
  batches: DecisionBatch[];
}

const LEGACY_STORAGE_KEY = "bank-fraud-investigation-db-v1";
const STORAGE_KEY = "bank-fraud-investigation-db-v2";

const createSeedDatabase = (): MockDatabase => ({
  alerts: structuredClone(seedAlerts),
  cases: structuredClone(seedCases),
  nodes: structuredClone(seedNodes),
  edges: structuredClone(seedEdges),
  evidence: structuredClone(seedEvidence),
  conclusions: structuredClone(seedConclusions),
  auditLogs: structuredClone(seedAuditLogs),
  batches: structuredClone(seedBatches),
});

type LegacyEvidence = Omit<Evidence, "versions">;

interface LegacyDatabase {
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: LegacyEvidence[];
  conclusions: Array<Omit<ConclusionVersion, "evidenceRefs" | "alertRefs" | "basisStatus">>;
  auditLogs: AuditLog[];
}

const isVersionedEvidence = (item: unknown): item is Evidence =>
  typeof item === "object" &&
  item !== null &&
  Array.isArray((item as Evidence).versions);

const hasBasis = (
  item: unknown,
): item is ConclusionVersion =>
  typeof item === "object" &&
  item !== null &&
  Array.isArray((item as ConclusionVersion).evidenceRefs) &&
  Array.isArray((item as ConclusionVersion).alertRefs) &&
  typeof (item as ConclusionVersion).basisStatus === "string";

/**
 * 旧结论回填：按结论提交时间回放该案件的证据台账，
 * 取提交时已经入库（submittedAt <= createdAt）的最新证据版本。
 * 若结论提交时案件没有任何证据，无法试出版本，则标记为待补证。
 */
const backfillBasis = (
  conclusion: Pick<ConclusionVersion, "caseId" | "createdAt" | "status">,
  evidence: Evidence[],
  alerts: Alert[],
): Pick<
  ConclusionVersion,
  "evidenceRefs" | "alertRefs" | "basisStatus"
> => {
  const submittedAtMs = Date.parse(conclusion.createdAt);

  // 每份证据取结论提交时刻已经入库的最高版本
  const evidenceRefs: FrozenEvidenceRef[] = [];
  evidence
    .filter((item) => item.caseId === conclusion.caseId)
    .forEach((item) => {
      const candidate = item.versions
        .filter((version) => Date.parse(version.submittedAt) <= submittedAtMs)
        .reduce<Evidence["versions"][number] | null>(
          (best, version) =>
            best === null || version.version > best.version ? version : best,
          null,
        );
      if (candidate) {
        evidenceRefs.push({
          evidenceId: item.id,
          version: candidate.version,
          title: candidate.title,
          source: candidate.source,
          strength: candidate.strength,
          occurredAt: candidate.occurredAt,
          mode: "backfilled",
        });
      }
    });

  const alertRefs: FrozenAlertRef[] = alerts
    .filter((item) => item.caseId === conclusion.caseId)
    .map((item) => ({
      alertId: item.id,
      mode: "backfilled",
      snapshot: structuredClone(item),
    }));

  // 草稿是未提交的编辑态，不强制回填依据
  const needsBasis = conclusion.status !== "draft";
  const basisStatus = needsBasis
    ? evidenceRefs.length > 0
      ? "backfilled"
      : "evidence_pending"
    : "frozen";

  return { evidenceRefs, alertRefs, basisStatus };
};

const normalizeDatabase = (raw: unknown): MockDatabase => {
  const database = raw as Partial<LegacyDatabase & MockDatabase>;

  const evidence: Evidence[] = (database.evidence ?? []).map((item) => {
    if (isVersionedEvidence(item)) {
      return item;
    }
    const legacy = item as LegacyEvidence;
    return {
      ...legacy,
      versions: [
        {
          version: legacy.version,
          title: legacy.title,
          source: legacy.source,
          strength: legacy.strength,
          occurredAt: legacy.occurredAt,
          submittedAt: legacy.submittedAt,
          submittedBy: legacy.submittedBy,
          attachment: legacy.attachment,
          note: legacy.note,
        },
      ],
    };
  });

  const alerts = database.alerts ?? [];

  const conclusions: ConclusionVersion[] = (database.conclusions ?? []).map(
    (item) => {
      if (hasBasis(item)) {
        return item;
      }
      const legacy = item as Omit<
        ConclusionVersion,
        "evidenceRefs" | "alertRefs" | "basisStatus"
      >;
      return {
        ...legacy,
        ...backfillBasis(legacy, evidence, alerts),
      };
    },
  );

  return {
    alerts,
    cases: database.cases ?? [],
    nodes: database.nodes ?? [],
    edges: database.edges ?? [],
    evidence,
    conclusions,
    auditLogs: database.auditLogs ?? [],
    batches: database.batches ?? [],
  };
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return createSeedDatabase();
  }

  const storedV2 = window.localStorage.getItem(STORAGE_KEY);
  if (storedV2) {
    try {
      return normalizeDatabase(JSON.parse(storedV2));
    } catch {
      // 数据损坏时回退到迁移流程
    }
  }

  const storedV1 = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (storedV1) {
    let migrated: MockDatabase;
    try {
      migrated = normalizeDatabase(JSON.parse(storedV1));
    } catch {
      migrated = createSeedDatabase();
    }
    writeDatabase(migrated);
    // v2 已落库，删除旧键，避免之后再次触发迁移
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    return migrated;
  }

  const seeded = createSeedDatabase();
  writeDatabase(seeded);
  return seeded;
};

export const writeDatabase = (database: MockDatabase): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  }
};

export const resetDatabase = (): MockDatabase => {
  const seeded = createSeedDatabase();
  writeDatabase(seeded);
  return seeded;
};

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const nowIso = (): string => new Date().toISOString();

export const appendAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at">,
): AuditLog => {
  // 同一批次步骤重放时不重复留痕
  if (log.dedupKey) {
    const existing = database.auditLogs.find(
      (item) => item.dedupKey === log.dedupKey,
    );
    if (existing) {
      return existing;
    }
  }
  const record: AuditLog = {
    id: createId("LOG"),
    at: nowIso(),
    ...log,
  };
  database.auditLogs.unshift(record);
  return record;
};
