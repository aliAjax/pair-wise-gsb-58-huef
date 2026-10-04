import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  Alert,
  AlertFilters,
  AlertStatus,
  AuditLog,
  CaseDisposition,
  CaseStatus,
  ConclusionVersion,
  DashboardSummary,
  DecisionBatch,
  Evidence,
  EvidenceStrength,
  InvestigationCase,
  InvestigationNode,
} from "../models/types";
import {
  appendAudit,
  createId,
  nowIso,
  readDatabase,
  resetDatabase,
  writeDatabase,
} from "./mockStorage";
import {
  BatchConflictError,
  BatchInterruptedError,
  BatchValidationError,
  recoverInterruptedBatches,
  runBatch,
  type LinkAlertsInput,
  type RegisterEvidenceInput,
  type ReviewConclusionInput,
  type SubmitConclusionInput,
  type SupplementEvidenceInput,
  type UpdateAlertStatusInput,
} from "./decisionBatches";
import { getCaseDecisionState } from "./decisionModel";

const wait = (milliseconds = 220) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const newRequestId = (): string => createId("REQ");

export interface AddNodeInput {
  caseId: string;
  node: InvestigationNode;
  relation?: {
    sourceId: string;
    kind: "transfer" | "shared_device" | "shared_ip" | "payee";
    label: string;
    explanation: string;
    amount?: number;
  };
}

const toErrorMessage = (error: unknown): { status: string; error: string } => {
  if (error instanceof BatchValidationError) {
    return { status: "CUSTOM_ERROR", error: error.message };
  }
  if (error instanceof BatchInterruptedError) {
    return {
      status: "CUSTOM_ERROR",
      error: `写库中断，判定批次 ${error.batch.id} 已保留进度，可从最近完整批次继续。`,
    };
  }
  if (error instanceof Error && error.name === "WriteInterruptedError") {
    return {
      status: "CUSTOM_ERROR",
      error: "写库中断，操作进度已持久化，可在审计页恢复后继续。",
    };
  }
  if (error instanceof Error) {
    return { status: "CUSTOM_ERROR", error: error.message };
  }
  return { status: "CUSTOM_ERROR", error: "操作失败，请稍后重试。" };
};

export interface CaseWorkspaceData {
  case: InvestigationCase;
  nodes: ReturnType<typeof readDatabase>["nodes"];
  edges: ReturnType<typeof readDatabase>["edges"];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  effectiveStatus: CaseStatus;
  hasStaleBasis: boolean;
  hasMissingBasis: boolean;
}

export const bankApi = createApi({
  reducerPath: "bankApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: [
    "Alerts",
    "Cases",
    "Case",
    "Audit",
    "Dashboard",
    "Batches",
  ],
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        const activeCases = database.cases.filter(
          (item) => item.status !== "closed",
        );
        const caseStatusCounts: DashboardSummary["caseStatusCounts"] = {
          investigating: 0,
          pending_review: 0,
          supplement: 0,
          closed: 0,
        };
        const riskCounts: DashboardSummary["riskCounts"] = {
          high: 0,
          medium: 0,
          low: 0,
        };

        let staleBasisCases = 0;
        let missingBasisCases = 0;
        database.cases.forEach((item) => {
          const state = getCaseDecisionState(item.id, database);
          caseStatusCounts[state.effectiveStatus] += 1;
          riskCounts[item.riskLevel] += 1;
          if (state.hasStaleBasis) staleBasisCases += 1;
          if (state.hasMissingBasis) missingBasisCases += 1;
        });

        return {
          data: {
            newAlerts: database.alerts.filter((item) => item.status === "new")
              .length,
            highRiskAlerts: database.alerts.filter(
              (item) => item.riskLevel === "high",
            ).length,
            activeCases: activeCases.length,
            pendingReview: database.cases.filter((item) => {
              const state = getCaseDecisionState(item.id, database);
              return ["pending_review", "supplement"].includes(
                state.effectiveStatus,
              );
            }).length,
            staleBasisCases,
            missingBasisCases,
            interruptedBatches: database.batches.filter(
              (item) => item.status === "interrupted",
            ).length,
            totalExposure: database.alerts.reduce(
              (sum, item) => sum + item.amount,
              0,
            ),
            caseStatusCounts,
            riskCounts,
          },
        };
      },
      providesTags: ["Dashboard"],
    }),
    getAlerts: builder.query<Alert[], AlertFilters>({
      queryFn: async (filters) => {
        await wait();
        const database = readDatabase();
        const keyword = filters.keyword.trim().toLowerCase();
        const items = database.alerts.filter((item) => {
          const matchesKeyword =
            !keyword ||
            [
              item.id,
              item.title,
              item.account,
              item.counterparty,
              item.deviceId,
              item.ip,
              ...item.tags,
            ]
              .join(" ")
              .toLowerCase()
              .includes(keyword);
          const matchesRisk =
            filters.riskLevel === "all" ||
            item.riskLevel === filters.riskLevel;
          const matchesStatus =
            filters.status === "all" || item.status === filters.status;
          const matchesChannel =
            !filters.channel || item.channel === filters.channel;
          return (
            matchesKeyword && matchesRisk && matchesStatus && matchesChannel
          );
        });
        return { data: items };
      },
      providesTags: ["Alerts"],
    }),
    getCases: builder.query<InvestigationCase[], void>({
      queryFn: async () => {
        await wait();
        // 案件状态已在批次提交与读取迁移时按统一判定视图回写
        return { data: readDatabase().cases };
      },
      providesTags: ["Cases", "Dashboard"],
    }),
    getCaseWorkspace: builder.query<CaseWorkspaceData, string>({
      queryFn: async (caseId) => {
        await wait();
        const database = readDatabase();
        const investigationCase = database.cases.find(
          (item) => item.id === caseId,
        );
        if (!investigationCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const state = getCaseDecisionState(caseId, database);
        return {
          data: {
            case: investigationCase,
            nodes: database.nodes.filter((item) => item.caseId === caseId),
            edges: database.edges.filter((item) => item.caseId === caseId),
            evidence: database.evidence.filter(
              (item) => item.caseId === caseId,
            ),
            conclusions: database.conclusions
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.version - a.version),
            effectiveStatus: state.effectiveStatus,
            hasStaleBasis: state.hasStaleBasis,
            hasMissingBasis: state.hasMissingBasis,
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        "Dashboard",
        "Batches",
      ],
    }),
    getAuditLogs: builder.query<AuditLog[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().auditLogs };
      },
      providesTags: ["Audit", "Batches"],
    }),
    getBatches: builder.query<DecisionBatch[], void>({
      queryFn: async () => {
        await wait(80);
        return {
          data: readDatabase().batches.sort(
            (a, b) =>
              Date.parse(b.createdAt) - Date.parse(a.createdAt),
          ),
        };
      },
      providesTags: ["Batches", "Audit"],
    }),
    /** 案件页、概览与导出共用的判定报告。 */
    getDecisionReport: builder.query<
      {
        generatedAt: string;
        cases: Array<{
          case: InvestigationCase;
          effectiveStatus: CaseStatus;
          conclusions: ReturnType<typeof getCaseDecisionState>["views"];
        }>;
        batches: DecisionBatch[];
      },
      { caseId?: string } | void
    >({
      queryFn: async (filter) => {
        await wait(120);
        const database = readDatabase();
        const cases = database.cases
          .filter((item) => !filter || !filter.caseId || item.id === filter.caseId)
          .map((item) => {
            const state = getCaseDecisionState(item.id, database);
            return {
              case: item,
              effectiveStatus: state.effectiveStatus,
              conclusions: state.views,
            };
          });
        return {
          data: {
            generatedAt: nowIso(),
            cases,
            batches: database.batches,
          },
        };
      },
      providesTags: ["Batches", "Case", "Cases", "Dashboard", "Audit"],
    }),
    linkAlertsToCase: builder.mutation<
      Alert[],
      { alertIds: string[]; caseId: string; actor: string }
    >({
      queryFn: async ({ alertIds, caseId, actor }) => {
        await wait();
        const input: LinkAlertsInput = {
          alertIds,
          caseId,
          actor,
          requestId: newRequestId(),
        };
        try {
          runBatch({ kind: "link_alerts", input });
        } catch (error) {
          return { error: toErrorMessage(error) };
        }
        const selected = readDatabase().alerts.filter((item) =>
          alertIds.includes(item.id),
        );
        return { data: selected };
      },
      invalidatesTags: ["Alerts", "Cases", "Audit", "Dashboard", "Batches"],
    }),
    updateAlertStatus: builder.mutation<
      Alert,
      { alertId: string; status: AlertStatus; actor: string }
    >({
      queryFn: async ({ alertId, status, actor }) => {
        await wait();
        const input: UpdateAlertStatusInput = {
          alertId,
          status,
          actor,
          requestId: newRequestId(),
        };
        try {
          runBatch({ kind: "update_alert_status", input });
        } catch (error) {
          return { error: toErrorMessage(error) };
        }
        const alert = readDatabase().alerts.find((item) => item.id === alertId);
        return alert
          ? { data: alert }
          : { error: { status: "CUSTOM_ERROR", error: "告警不存在" } };
      },
      invalidatesTags: ["Alerts", "Case", "Audit", "Dashboard", "Batches"],
    }),
    addGraphNode: builder.mutation<InvestigationNode, AddNodeInput>({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        database.nodes.push(node);
        if (relation) {
          database.edges.push({
            id: createId("E"),
            caseId,
            source: relation.sourceId,
            target: node.id,
            kind: relation.kind,
            label: relation.label,
            amount: relation.amount,
            occurredAt: node.data.occurredAt,
            explanation: relation.explanation,
          });
        }
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: "林澜",
          action: "加入图谱节点",
          detail: `${node.data.label} 已加入，证据强度 ${node.data.evidenceStrength}。`,
        });
        writeDatabase(database);
        return { data: node };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    updateGraphNode: builder.mutation<
      InvestigationNode,
      { caseId: string; node: InvestigationNode }
    >({
      queryFn: async ({ caseId, node }) => {
        await wait(80);
        const database = readDatabase();
        const index = database.nodes.findIndex((item) => item.id === node.id);
        if (index < 0) {
          return { error: { status: "CUSTOM_ERROR", error: "节点不存在" } };
        }
        database.nodes[index] = { ...database.nodes[index], ...node };
        writeDatabase(database);
        return { data: database.nodes[index] };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
      ],
    }),
    addEvidence: builder.mutation<
      Evidence,
      {
        caseId: string;
        actor: string;
        title: string;
        source: string;
        strength: EvidenceStrength;
        occurredAt: string;
        attachment: string;
        note: string;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const batchInput: RegisterEvidenceInput = {
          caseId: input.caseId,
          actor: input.actor,
          title: input.title,
          source: input.source,
          strength: input.strength,
          occurredAt: input.occurredAt,
          attachment: input.attachment,
          note: input.note,
          requestId: newRequestId(),
        };
        try {
          const outcome = runBatch({
            kind: "register_evidence",
            input: batchInput,
          });
          const evidenceId = `${batchInput.requestId}__evidence`;
          const evidence = readDatabase().evidence.find(
            (item) => item.id === evidenceId,
          );
          if (!evidence) {
            return {
              error: { status: "CUSTOM_ERROR", error: "证据登记未完成。" },
            };
          }
          void outcome;
          return { data: evidence };
        } catch (error) {
          return { error: toErrorMessage(error) };
        }
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Batches",
      ],
    }),
    supplementEvidence: builder.mutation<
      Evidence,
      {
        caseId: string;
        actor: string;
        seriesId: string;
        title: string;
        source: string;
        strength: EvidenceStrength;
        occurredAt: string;
        attachment: string;
        note: string;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const batchInput: SupplementEvidenceInput = {
          ...input,
          requestId: newRequestId(),
        };
        try {
          runBatch({ kind: "supplement_evidence", input: batchInput });
        } catch (error) {
          return { error: toErrorMessage(error) };
        }
        const evidenceId = `${batchInput.requestId}__evidence`;
        const evidence = readDatabase().evidence.find(
          (item) => item.id === evidenceId,
        );
        return evidence
          ? { data: evidence }
          : {
              error: { status: "CUSTOM_ERROR", error: "证据补充未完成。" },
            };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Batches",
      ],
    }),
    saveConclusion: builder.mutation<
      {
        conclusion?: ConclusionVersion;
        conflict?: {
          winnerConclusionId: string;
          winnerBatchId: string;
        };
      },
      {
        caseId: string;
        actor: string;
        disposition: CaseDisposition;
        rationale: string;
        riskControls: string[];
        submit?: boolean;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const batchInput: SubmitConclusionInput = {
          caseId: input.caseId,
          actor: input.actor,
          disposition: input.disposition,
          rationale: input.rationale,
          riskControls: input.riskControls,
          submit: Boolean(input.submit),
          requestId: newRequestId(),
        };
        try {
          const outcome = runBatch({
            kind: "submit_conclusion",
            input: batchInput,
          });
          return {
            data: {
              conclusion: outcome.conclusion,
              conflict: outcome.conflict,
            },
          };
        } catch (error) {
          if (error instanceof BatchConflictError) {
            return { data: { conflict: error.outcome.conflict } };
          }
          return { error: toErrorMessage(error) };
        }
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
        "Batches",
      ],
    }),
    transitionCase: builder.mutation<
      InvestigationCase,
      { caseId: string; status: CaseStatus; reason?: string; actor: string }
    >({
      queryFn: async ({ caseId, status, reason, actor }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        if (status === "pending_review") {
          const hasSubmitted = database.conclusions.some(
            (item) =>
              item.caseId === caseId && item.status === "submitted",
          );
          if (!hasSubmitted) {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
          }
        }
        targetCase.status = status;
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId,
          actor,
          action: "案件状态流转",
          detail: `状态更新为 ${status}${reason ? `，原因：${reason}` : ""}。`,
        });
        writeDatabase(database);
        return { data: targetCase };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    reviewConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        actor: string;
        conclusionId: string;
        decision: "approve" | "return";
        reviewerNote: string;
      }
    >({
      queryFn: async ({ caseId, actor, conclusionId, decision, reviewerNote }) => {
        await wait();
        const input: ReviewConclusionInput = {
          caseId,
          actor,
          conclusionId,
          decision,
          reviewerNote,
          requestId: newRequestId(),
        };
        try {
          runBatch({ kind: "review_conclusion", input });
        } catch (error) {
          return { error: toErrorMessage(error) };
        }
        const conclusion = readDatabase().conclusions.find(
          (item) => item.id === conclusionId,
        );
        return conclusion
          ? { data: conclusion }
          : {
              error: { status: "CUSTOM_ERROR", error: "复核未完成。" },
            };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
        "Batches",
      ],
    }),
    recoverBatches: builder.mutation<
      { recovered: Array<{ id: string; kind: string }> },
      void
    >({
      queryFn: async () => {
        await wait(180);
        const recovered = recoverInterruptedBatches().map((item) => ({
          id: item.batch.id,
          kind: item.batch.kind,
        }));
        return { data: { recovered } };
      },
      invalidatesTags: [
        "Batches",
        "Audit",
        "Cases",
        "Case",
        "Dashboard",
        "Alerts",
      ],
    }),
    resetMockData: builder.mutation<{ ok: boolean }, void>({
      queryFn: async () => {
        await wait(180);
        resetDatabase();
        return { data: { ok: true } };
      },
      invalidatesTags: ["Alerts", "Cases", "Case", "Audit", "Dashboard", "Batches"],
    }),
  }),
});

export const {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetBatchesQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useGetDecisionReportQuery,
  useLinkAlertsToCaseMutation,
  useRecoverBatchesMutation,
  useResetMockDataMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useSupplementEvidenceMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateGraphNodeMutation,
} = bankApi;

export type { CaseDisposition };
