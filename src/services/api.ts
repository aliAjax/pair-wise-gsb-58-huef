import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  Alert,
  AlertFilters,
  AuditLog,
  CaseDisposition,
  CaseStatus,
  ConclusionVersion,
  DashboardSummary,
  Evidence,
  InvestigationCase,
  InvestigationNode,
} from "../models/types";
import {
  BatchInterrupted,
  BatchRejected,
  armCrashAfterStep,
  clearCrash,
  completeLinkAlerts,
  completeReview,
  completeSubmit,
  completeSupplementEvidence,
  recoverInterruptedBatches,
  type SupplementEvidenceInput,
} from "./decisionEngine";
import {
  appendAudit,
  createId,
  nowIso,
  readDatabase,
  resetDatabase,
  writeDatabase,
} from "./mockStorage";
import {
  buildCaseOutcome,
  buildCaseOutcomes,
  buildDashboardSummary,
  type CaseOutcomeRow,
} from "./caseView";

const wait = (milliseconds = 220) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const errorFrom = (error: unknown): { status: number; error: string } => {
  if (error instanceof BatchRejected) {
    return { status: 409, error: error.message };
  }
  if (error instanceof BatchInterrupted) {
    return {
      status: 503,
      error: `写库中断，批次 ${error.batchId} 已保留，重试将从中断步骤继续。`,
    };
  }
  if (typeof error === "object" && error && "message" in error) {
    return { status: 500, error: String((error as Error).message) };
  }
  return { status: 500, error: "操作失败，请稍后重试。" };
};

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

export interface CaseWorkspaceView {
  case: InvestigationCase;
  nodes: InvestigationNode[];
  edges: ReturnType<typeof readDatabase>["edges"];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  outcome: ReturnType<typeof buildCaseOutcome>;
}

export interface SaveConclusionInput {
  caseId: string;
  actor: string;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  submit: boolean;
  arrivalAt?: string;
  /** 同一逻辑请求的重试令牌；缺失时由引擎生成 */
  attemptId?: string;
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
    "Outcomes",
  ],
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      queryFn: async () => {
        await wait();
        // 概览与案件页走同一个判定结果出口
        return { data: buildDashboardSummary(readDatabase()) };
      },
      providesTags: ["Dashboard", "Outcomes"],
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
        return { data: readDatabase().cases };
      },
      providesTags: ["Cases"],
    }),
    getCaseOutcomes: builder.query<CaseOutcomeRow[], void>({
      queryFn: async () => {
        await wait(80);
        return { data: buildCaseOutcomes(readDatabase()) };
      },
      providesTags: ["Outcomes"],
    }),
    getCaseWorkspace: builder.query<CaseWorkspaceView, string>({
      queryFn: async (caseId) => {
        await wait();
        const database = readDatabase();
        const investigationCase = database.cases.find(
          (item) => item.id === caseId,
        );
        if (!investigationCase) {
          return { error: { status: 404, error: "案件不存在" } };
        }
        const caseEvidence = database.evidence.filter(
          (item) => item.caseId === caseId,
        );
        const caseConclusions = database.conclusions
          .filter((item) => item.caseId === caseId)
          .sort(
            (a, b) =>
              b.version - a.version ||
              Date.parse(b.createdAt) - Date.parse(a.createdAt),
          );
        return {
          data: {
            case: investigationCase,
            nodes: database.nodes.filter((item) => item.caseId === caseId),
            edges: database.edges.filter((item) => item.caseId === caseId),
            evidence: caseEvidence,
            conclusions: caseConclusions,
            // 案件页判定结果与概览、导出同源
            outcome: buildCaseOutcome(
              investigationCase,
              caseConclusions,
              caseEvidence,
            ),
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        "Dashboard",
        "Outcomes",
      ],
    }),
    getAuditLogs: builder.query<AuditLog[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().auditLogs };
      },
      providesTags: ["Audit"],
    }),
    getDecisionBatches: builder.query<
      ReturnType<typeof readDatabase>["batches"],
      void
    >({
      queryFn: async () => {
        await wait(60);
        return { data: readDatabase().batches };
      },
      providesTags: ["Audit", "Outcomes"],
    }),
    linkAlertsToCase: builder.mutation<
      Alert[],
      { alertIds: string[]; caseId: string; actor?: string }
    >({
      queryFn: async ({ alertIds, caseId, actor = "林澜" }) => {
        await wait();
        try {
          const selected = completeLinkAlerts({ alertIds, caseId, actor });
          return { data: selected };
        } catch (error) {
          return { error: errorFrom(error) };
        }
      },
      invalidatesTags: ["Alerts", "Cases", "Audit", "Dashboard", "Outcomes"],
    }),
    updateAlertStatus: builder.mutation<
      Alert,
      { alertId: string; status: Alert["status"] }
    >({
      queryFn: async ({ alertId, status }) => {
        await wait(80);
        const database = readDatabase();
        const alert = database.alerts.find((item) => item.id === alertId);
        if (!alert) {
          return { error: { status: 404, error: "告警不存在" } };
        }
        alert.status = status;
        appendAudit(database, {
          caseId: alert.caseId,
          actor: "林澜",
          action: "更新告警状态",
          detail: `${alert.id} 状态更新为 ${status}。`,
        });
        writeDatabase(database);
        return { data: alert };
      },
      invalidatesTags: ["Alerts", "Case", "Audit", "Dashboard"],
    }),
    addGraphNode: builder.mutation<InvestigationNode, AddNodeInput>({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return { error: { status: 404, error: "案件不存在" } };
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
        await wait(60);
        const database = readDatabase();
        const index = database.nodes.findIndex((item) => item.id === node.id);
        if (index < 0) {
          return { error: { status: 404, error: "节点不存在" } };
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
      Omit<Evidence, "id" | "submittedAt" | "submittedBy" | "version" | "versions">
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const submittedAt = nowIso();
        const id = createId("EV");
        const evidence: Evidence = {
          ...input,
          id,
          submittedAt,
          submittedBy: "林澜",
          version: 1,
          versions: [
            {
              version: 1,
              title: input.title,
              source: input.source,
              strength: input.strength,
              occurredAt: input.occurredAt,
              submittedAt,
              submittedBy: "林澜",
              attachment: input.attachment,
              note: input.note,
            },
          ],
        };
        database.evidence.unshift(evidence);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId: input.caseId,
          actor: "林澜",
          action: "新增证据",
          detail: `${input.title} V1 已登记，来源为 ${input.source}。`,
        });
        writeDatabase(database);
        return { data: evidence };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Outcomes",
      ],
    }),
    supplementEvidence: builder.mutation<
      { evidence: Evidence; invalidated: ConclusionVersion[] },
      SupplementEvidenceInput
    >({
      queryFn: async (input) => {
        await wait();
        try {
          return { data: completeSupplementEvidence(input) };
        } catch (error) {
          return { error: errorFrom(error) };
        }
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
        "Outcomes",
      ],
    }),
    saveConclusion: builder.mutation<
      {
        conclusion: ConclusionVersion;
        lostRace: boolean;
        winnerConclusionId?: string;
      },
      SaveConclusionInput
    >({
      queryFn: async (input) => {
        await wait();
        try {
          const outcome = completeSubmit(input);
          return {
            data: {
              conclusion: outcome.conclusion,
              lostRace: outcome.lostRace,
              winnerConclusionId: outcome.winnerConclusionId,
            },
          };
        } catch (error) {
          return { error: errorFrom(error) };
        }
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
        "Outcomes",
      ],
    }),
    transitionCase: builder.mutation<
      InvestigationCase,
      { caseId: string; status: CaseStatus; reason?: string }
    >({
      queryFn: async ({ caseId, status, reason }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: 404, error: "案件不存在" } };
        }
        if (status === "pending_review") {
          const hasSubmitted = database.conclusions.some(
            (item) => item.caseId === caseId && item.status === "submitted",
          );
          if (!hasSubmitted) {
            return {
              error: {
                status: 409,
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
          }
        }
        targetCase.status = status;
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId,
          actor: "林澜",
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
        "Outcomes",
      ],
    }),
    reviewConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        conclusionId: string;
        decision: "approve" | "return";
        reviewerNote: string;
        actor?: string;
      }
    >({
      queryFn: async ({
        caseId,
        conclusionId,
        decision,
        reviewerNote,
        actor = "赵平",
      }) => {
        await wait();
        try {
          const conclusion = completeReview({
            caseId,
            conclusionId,
            decision,
            reviewerNote,
            actor,
          });
          return { data: conclusion };
        } catch (error) {
          return { error: errorFrom(error) };
        }
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
        "Outcomes",
      ],
    }),
    recoverBatches: builder.mutation<
      { resumed: number },
      void
    >({
      queryFn: async () => {
        await wait(120);
        try {
          const report = recoverInterruptedBatches();
          return { data: { resumed: report.resumed } };
        } catch (error) {
          return { error: errorFrom(error) };
        }
      },
      invalidatesTags: [
        "Alerts",
        "Cases",
        "Case",
        "Audit",
        "Dashboard",
        "Outcomes",
      ],
    }),
    armCrash: builder.mutation<
      { ok: true },
      { batchKind: Parameters<typeof armCrashAfterStep>[0]; afterStep: string }
    >({
      queryFn: async ({ batchKind, afterStep }) => {
        armCrashAfterStep(batchKind, afterStep);
        return { data: { ok: true as const } };
      },
    }),
    clearCrash: builder.mutation<{ ok: true }, void>({
      queryFn: async () => {
        clearCrash();
        return { data: { ok: true as const } };
      },
    }),
    resetMockData: builder.mutation<{ ok: boolean }, void>({
      queryFn: async () => {
        await wait(120);
        clearCrash();
        resetDatabase();
        return { data: { ok: true } };
      },
      invalidatesTags: ["Alerts", "Cases", "Case", "Audit", "Dashboard", "Outcomes"],
    }),
  }),
});

export const {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useArmCrashMutation,
  useClearCrashMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetCaseOutcomesQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useGetDecisionBatchesQuery,
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
