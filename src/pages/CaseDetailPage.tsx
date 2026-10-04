import {
  Alert,
  Badge,
  Button,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  ArrowLeft,
  Check,
  DatabaseZap,
  FilePlus2,
  GitBranchPlus,
  RotateCcw,
  Send,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../app/hooks";
import {
  CaseStatusBadge,
  ConclusionStatusBadge,
  EvidenceStrengthBadge,
  RiskBadge,
} from "../components/Badges";
import { ConclusionBasis } from "../components/ConclusionBasis";
import {
  SupplementEvidenceModal,
  type SupplementFormValues,
} from "../components/SupplementEvidenceModal";
import {
  focusEvidence,
  focusTimeline,
  selectNode,
} from "../features/alerts/alertsSlice";
import { InvestigationGraph } from "../features/graph/InvestigationGraph";
import {
  TransactionTimeline,
  type TimelineEvent,
} from "../features/timeline/TransactionTimeline";
import type {
  CaseDisposition,
  Evidence,
  EvidenceStrength,
  NodeKind,
  RiskLevel,
} from "../models/types";
import {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useGetAlertsQuery,
  useGetCaseWorkspaceQuery,
  useRecoverBatchesMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useSupplementEvidenceMutation,
  useTransitionCaseMutation,
  useUpdateGraphNodeMutation,
} from "../services/api";
import { createId } from "../services/mockStorage";

const dispositionLabels: Record<CaseDisposition, string> = {
  freeze: "建议冻结",
  release: "建议放行",
  observe: "继续观察",
};

const actorOptions = [
  { value: "林澜", label: "调查员 · 林澜" },
  { value: "周明", label: "调查员 · 周明" },
  { value: "宋佳", label: "调查员 · 宋佳" },
];

const outcomeColor: Record<string, string> = {
  approved: "teal",
  pending_review: "orange",
  stale_recompute: "yellow",
  supplement: "red",
  evidence_pending: "red",
  drafting: "blue",
  empty: "gray",
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请检查输入后重试。";
};

export function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const selectedNodeId = useAppSelector(
    (state) => state.alertsUi.selectedNodeId,
  );
  const focusedTimelineId = useAppSelector(
    (state) => state.alertsUi.focusedTimelineId,
  );
  const focusedEvidenceId = useAppSelector(
    (state) => state.alertsUi.focusedEvidenceId,
  );
  const { data, isLoading, error } = useGetCaseWorkspaceQuery(caseId);
  const { data: allAlerts = [] } = useGetAlertsQuery({
    keyword: "",
    riskLevel: "all",
    status: "all",
    channel: "",
  });
  const [addNode] = useAddGraphNodeMutation();
  const [updateNode] = useUpdateGraphNodeMutation();
  const [addEvidence, { isLoading: isAddingEvidence }] =
    useAddEvidenceMutation();
  const [supplementEvidence, { isLoading: isSupplementing }] =
    useSupplementEvidenceMutation();
  const [saveConclusion, { isLoading: isSavingConclusion }] =
    useSaveConclusionMutation();
  const [transitionCase, { isLoading: isTransitioning }] =
    useTransitionCaseMutation();
  const [reviewConclusion, { isLoading: isReviewing }] =
    useReviewConclusionMutation();
  const [recoverBatches, { isLoading: isRecovering }] =
    useRecoverBatchesMutation();

  const [actor, setActor] = useState("林澜");
  const [nodeOpened, nodeModal] = useDisclosure(false);
  const [evidenceOpened, evidenceModal] = useDisclosure(false);
  const [conclusionOpened, conclusionModal] = useDisclosure(false);
  const [supplementTarget, setSupplementTarget] = useState<
    Evidence | undefined
  >(undefined);
  const [reviewNote, setReviewNote] = useState("");
  const [nodeForm, setNodeForm] = useState({
    sourceId: "",
    kind: "account" as NodeKind,
    label: "",
    riskLevel: "medium" as RiskLevel,
    evidenceStrength: "medium" as EvidenceStrength,
    source: "",
    occurredAt: "2026-09-29T09:00",
    note: "",
    relationLabel: "",
    relationExplanation: "",
    amount: 0,
  });
  const [evidenceForm, setEvidenceForm] = useState({
    title: "",
    source: "",
    strength: "medium" as EvidenceStrength,
    occurredAt: "2026-09-29T09:00",
    attachment: "",
    note: "",
  });
  const [conclusionForm, setConclusionForm] = useState({
    disposition: "observe" as CaseDisposition,
    rationale: "",
    riskControls: "",
  });
  // 一次结论编辑对应一个请求令牌：失败重试复用，关闭弹窗后换新
  const [submitAttemptId, setSubmitAttemptId] = useState(() =>
    createId("ATT"),
  );

  if (isLoading) {
    return <Text>正在加载案件工作区...</Text>;
  }

  if (error || !data) {
    return (
      <Alert color="red" title="案件加载失败">
        {errorMessage(error)}
      </Alert>
    );
  }

  const caseAlerts = allAlerts.filter((item) =>
    data.case.alertIds.includes(item.id),
  );
  const selectedNode = data.nodes.find((item) => item.id === selectedNodeId);
  // 复核操作只针对待复核结论；最新版本可能是失效草稿
  const reviewableConclusion = data.conclusions.find(
    (item) => item.status === "submitted",
  );
  const staleConclusions = data.conclusions.filter(
    (item) => item.status === "stale",
  );
  const outcome = data.outcome;

  const handleTimelineFocus = (event?: TimelineEvent) => {
    dispatch(focusTimeline(event?.id));
    dispatch(focusEvidence(event?.source === "evidence" ? event.id : undefined));
    if (event?.source === "transaction") {
      const edge = data.edges.find((item) => item.id === event.id);
      if (edge) {
        dispatch(selectNode(edge.target));
      }
    }
  };

  const handleAddNode = async () => {
    if (!nodeForm.sourceId || !nodeForm.label.trim() || !nodeForm.source.trim()) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "关系源节点、节点名称和证据来源均为必填项。",
      });
      return;
    }
    try {
      await addNode({
        caseId,
        node: {
          id: createId("NODE"),
          caseId,
          position: { x: 420, y: 240 },
          data: {
            label: nodeForm.label.trim(),
            kind: nodeForm.kind,
            riskLevel: nodeForm.riskLevel,
            note: nodeForm.note.trim() || "待补充关系说明。",
            evidenceStrength: nodeForm.evidenceStrength,
            source: nodeForm.source.trim(),
            occurredAt: new Date(nodeForm.occurredAt).toISOString(),
          },
        },
        relation: {
          sourceId: nodeForm.sourceId,
          kind: "transfer",
          label: nodeForm.relationLabel.trim() || "已登记关系",
          explanation:
            nodeForm.relationExplanation.trim() ||
            "关系来自调查员登记，需结合来源材料复核。",
          amount: nodeForm.amount || undefined,
        },
      }).unwrap();
      notifications.show({
        color: "teal",
        title: "节点已加入",
        message: "图谱、证据来源和审计日志已同步更新。",
      });
      nodeModal.close();
      setNodeForm((current) => ({
        ...current,
        label: "",
        source: "",
        note: "",
      }));
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "加入失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleAddEvidence = async () => {
    if (
      !evidenceForm.title.trim() ||
      !evidenceForm.source.trim() ||
      !evidenceForm.attachment.trim()
    ) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "证据名称、来源和附件标识均为必填项。",
      });
      return;
    }
    try {
      await addEvidence({
        caseId,
        title: evidenceForm.title.trim(),
        source: evidenceForm.source.trim(),
        strength: evidenceForm.strength,
        occurredAt: new Date(evidenceForm.occurredAt).toISOString(),
        attachment: evidenceForm.attachment.trim(),
        note: evidenceForm.note.trim() || "未补充说明。",
      }).unwrap();
      notifications.show({
        color: "teal",
        title: "证据已登记",
        message: "证据来源、发生时间与提交时间已写入台账。",
      });
      evidenceModal.close();
      setEvidenceForm((current) => ({
        ...current,
        title: "",
        source: "",
        attachment: "",
        note: "",
      }));
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "证据登记失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleSaveConclusion = async (submit: boolean) => {
    if (conclusionForm.rationale.trim().length < 12) {
      notifications.show({
        color: "red",
        title: "结论依据不足",
        message: "结论说明至少需要 12 个字符。",
      });
      return;
    }
    try {
      const result = await saveConclusion({
        caseId,
        actor,
        disposition: conclusionForm.disposition,
        rationale: conclusionForm.rationale.trim(),
        riskControls: conclusionForm.riskControls
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        submit,
        attemptId: submitAttemptId,
      }).unwrap();
      if (result.lostRace) {
        notifications.show({
          color: "orange",
          title: "并发提交：已保留草稿",
          message: `更早到达的版本 ${result.winnerConclusionId ?? ""} 已入库，你的版本保留为草稿并附带双方依据，请对照后重算。`,
          autoClose: 8000,
        });
      } else {
        notifications.show({
          color: "teal",
          title: submit ? "已提交复核" : "草稿已保存",
          message: "结论已冻结证据版本与告警快照。",
        });
      }
      conclusionModal.close();
      setConclusionForm({
        disposition: "observe",
        rationale: "",
        riskControls: "",
      });
      setSubmitAttemptId(createId("ATT"));
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "结论保存失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleSupplement = async (values: SupplementFormValues) => {
    if (!supplementTarget) {
      return;
    }
    if (
      !values.title.trim() ||
      !values.source.trim() ||
      !values.attachment.trim() ||
      !values.occurredAt
    ) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "证据名称、来源、发生时间和附件标识均为必填项。",
      });
      return;
    }
    try {
      const result = await supplementEvidence({
        caseId,
        evidenceId: supplementTarget.id,
        actor,
        patch: {
          title: values.title.trim(),
          source: values.source.trim(),
          strength: values.strength,
          occurredAt: new Date(values.occurredAt).toISOString(),
          attachment: values.attachment.trim(),
          note: values.note.trim() || "未补充版本说明。",
        },
      }).unwrap();
      notifications.show({
        color: result.invalidated.length > 0 ? "yellow" : "teal",
        title: `证据已发布 V${result.evidence.version}`,
        message:
          result.invalidated.length > 0
            ? `${result.invalidated.length} 份草稿/待复核结论依据失效，已标记待重算；已通过版本保留快照。`
            : "未发现引用旧版本的未决结论。",
        autoClose: 7000,
      });
      setSupplementTarget(undefined);
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "证据补版失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleRecover = async () => {
    try {
      const result = await recoverBatches().unwrap();
      notifications.show({
        color: "teal",
        title: "批次恢复完成",
        message:
          result.resumed > 0
            ? `已从最近完整批次续跑 ${result.resumed} 个批次，只补未完成项。`
            : "没有发现中断的判定批次。",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "批次恢复失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleTransition = async (
    status: "investigating" | "pending_review" | "supplement" | "closed",
  ) => {
    try {
      await transitionCase({ caseId, status }).unwrap();
      notifications.show({
        color: "teal",
        title: "状态已更新",
        message: `案件状态已流转为 ${status}。`,
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "状态流转失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleReview = async (decision: "approve" | "return") => {
    if (!reviewableConclusion) {
      return;
    }
    if (reviewNote.trim().length < 6) {
      notifications.show({
        color: "red",
        title: "复核意见不足",
        message: "复核意见至少需要 6 个字符。",
      });
      return;
    }
    if (
      decision === "approve" &&
      reviewableConclusion.basisStatus === "evidence_pending"
    ) {
      notifications.show({
        color: "red",
        title: "待补证结论不能通过",
        message: "该结论缺少证据版本，请先退回补证，补证后由调查员重新提交。",
      });
      return;
    }
    try {
      await reviewConclusion({
        caseId,
        conclusionId: reviewableConclusion.id,
        decision,
        reviewerNote: reviewNote.trim(),
      }).unwrap();
      notifications.show({
        color: decision === "approve" ? "teal" : "orange",
        title: decision === "approve" ? "复核通过" : "已退回补证",
        message:
          decision === "approve"
            ? "已通过版本保留提交快照，不受后续证据版本影响。"
            : "复核动作和意见已写入审计记录。",
      });
      setReviewNote("");
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "复核失败",
        message: errorMessage(mutationError),
      });
    }
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Group align="flex-start">
          <Button
            variant="subtle"
            px={6}
            leftSection={<ArrowLeft size={16} />}
            onClick={() => navigate("/cases")}
          >
            返回案件
          </Button>
          <div>
            <Group gap="sm">
              <Title order={2}>{data.case.title}</Title>
              <RiskBadge value={data.case.riskLevel} />
              <CaseStatusBadge value={data.case.status} />
            </Group>
            <Text c="dimmed" size="sm" mt={5}>
              {data.case.id} · 负责人 {data.case.owner} · 更新于{" "}
              {new Date(data.case.updatedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </Text>
          </div>
        </Group>
        <Group>
          <Select
            size="xs"
            variant="filled"
            label="当前提交人"
            value={actor}
            onChange={(value) => setActor(value ?? "林澜")}
            data={actorOptions}
            w={168}
          />
          <Button
            variant="default"
            leftSection={<GitBranchPlus size={16} />}
            onClick={nodeModal.open}
          >
            加入图谱节点
          </Button>
          <Button
            variant="light"
            leftSection={<FilePlus2 size={16} />}
            onClick={evidenceModal.open}
          >
            登记证据
          </Button>
          <Button
            leftSection={<Send size={16} />}
            onClick={conclusionModal.open}
          >
            新建结论版本
          </Button>
        </Group>
      </Group>

      <Paper
        withBorder
        p="md"
        bg={`var(--mantine-color-${outcomeColor[outcome.kind]}-0)`}
      >
        <Group justify="space-between" align="center">
          <Group>
            <Badge
              color={outcomeColor[outcome.kind]}
              size="lg"
              variant="light"
            >
              {outcome.label}
            </Badge>
            <Text size="sm" c="dimmed">
              {outcome.anchorConclusion
                ? `锚定版本 V${outcome.anchorConclusion.version} · ${outcome.anchorConclusion.createdBy} · ${dispositionLabels[outcome.anchorConclusion.disposition]}`
                : "登记证据后即可提交第一版结论。"}
            </Text>
            {outcome.staleCount > 0 ? (
              <Badge color="yellow" variant="outline">
                {outcome.staleCount} 份结论依据失效待重算
              </Badge>
            ) : null}
            {outcome.conflictDrafts.length > 0 ? (
              <Badge color="orange" variant="outline">
                {outcome.conflictDrafts.length} 份并发落败草稿
              </Badge>
            ) : null}
          </Group>
          <Button
            size="xs"
            variant="default"
            leftSection={<DatabaseZap size={14} />}
            loading={isRecovering}
            onClick={handleRecover}
          >
            从中断批次恢复
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md">
        <Group justify="space-between">
          <div>
            <Text size="sm" fw={600}>
              案件摘要
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              {data.case.summary}
            </Text>
          </div>
          <Group>
            <Button
              size="xs"
              variant="default"
              loading={isTransitioning}
              onClick={() => handleTransition("investigating")}
            >
              标记调查中
            </Button>
            <Button
              size="xs"
              variant="light"
              loading={isTransitioning}
              onClick={() => handleTransition("pending_review")}
            >
              提交复核
            </Button>
            <Button
              size="xs"
              variant="light"
              color="orange"
              loading={isTransitioning}
              onClick={() => handleTransition("supplement")}
            >
              要求补证
            </Button>
            <Button
              size="xs"
              variant="light"
              color="teal"
              loading={isTransitioning}
              onClick={() => handleTransition("closed")}
            >
              关闭案件
            </Button>
          </Group>
        </Group>
      </Paper>

      <Tabs defaultValue="graph" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="graph">关系图谱与时间轴</Tabs.Tab>
          <Tabs.Tab value="evidence">证据台账</Tabs.Tab>
          <Tabs.Tab value="conclusions">结论与复核</Tabs.Tab>
          <Tabs.Tab value="alerts">关联告警</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="graph" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, xl: 8 }}>
              <Paper withBorder>
                <Group justify="space-between" p="sm">
                  <div>
                    <Text size="sm" fw={600}>
                      案件关系图谱
                    </Text>
                    <Text size="xs" c="dimmed">
                      拖动节点可调整布局；关联关系必须结合解释和证据复核。
                    </Text>
                  </div>
                  <Badge variant="light" color="gray">
                    {data.nodes.length} 节点 / {data.edges.length} 关系
                  </Badge>
                </Group>
                <Divider />
                <InvestigationGraph
                  nodes={data.nodes}
                  edges={data.edges}
                  selectedNodeId={selectedNodeId}
                  focusedTimelineId={focusedTimelineId}
                  onSelectNode={(nodeId) => dispatch(selectNode(nodeId))}
                  onNodePositionChange={(nodeId, position) => {
                    const node = data.nodes.find((item) => item.id === nodeId);
                    if (node) {
                      void updateNode({
                        caseId,
                        node: { ...node, position },
                      });
                    }
                  }}
                />
              </Paper>
              {selectedNode ? (
                <Paper withBorder p="md" mt="md">
                  <Group justify="space-between">
                    <div>
                      <Text fw={600}>{selectedNode.data.label} 节点说明</Text>
                      <Text size="xs" c="dimmed">
                        {selectedNode.data.source} ·{" "}
                        {new Date(
                          selectedNode.data.occurredAt,
                        ).toLocaleString("zh-CN", { hour12: false })}
                      </Text>
                    </div>
                    <EvidenceStrengthBadge
                      value={selectedNode.data.evidenceStrength}
                    />
                  </Group>
                  <Text size="sm" mt="sm">
                    {selectedNode.data.note}
                  </Text>
                </Paper>
              ) : null}
            </Grid.Col>
            <Grid.Col span={{ base: 12, xl: 4 }}>
              <Paper withBorder h={selectedNode ? 702 : 620}>
                <Group justify="space-between" p="sm">
                  <div>
                    <Text size="sm" fw={600}>
                      联动时间轴
                    </Text>
                    <Text size="xs" c="dimmed">
                      点击事件可高亮关系或证据
                    </Text>
                  </div>
                  {focusedTimelineId ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<RotateCcw size={13} />}
                      onClick={() => handleTimelineFocus(undefined)}
                    >
                      清除
                    </Button>
                  ) : null}
                </Group>
                <Divider />
                <div style={{ height: selectedNode ? 642 : 560, padding: 12 }}>
                  <TransactionTimeline
                    alerts={caseAlerts}
                    edges={data.edges}
                    evidence={data.evidence}
                    focusedId={focusedTimelineId}
                    onFocus={handleTimelineFocus}
                  />
                </div>
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="evidence" pt="md">
          <Paper withBorder>
            <Group justify="space-between" p="md">
              <div>
                <Text fw={600}>证据台账</Text>
                <Text size="sm" c="dimmed">
                  每份证据保留完整版本链；结论只引用提交时冻结的版本，补版后旧版本仍可追溯。
                </Text>
              </div>
              <Button
                leftSection={<FilePlus2 size={16} />}
                onClick={evidenceModal.open}
              >
                登记证据
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={1080}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>证据名称</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>强度</Table.Th>
                    <Table.Th>发生时间</Table.Th>
                    <Table.Th>版本链 / 提交记录</Table.Th>
                    <Table.Th>附件标识</Table.Th>
                    <Table.Th>说明</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.evidence.map((item) => (
                    <Table.Tr
                      key={item.id}
                      className={
                        focusedEvidenceId === item.id
                          ? "table-row-focused"
                          : ""
                      }
                    >
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {item.title}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {item.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.source}</Table.Td>
                      <Table.Td>
                        <EvidenceStrengthBadge value={item.strength} />
                      </Table.Td>
                      <Table.Td>
                        {new Date(item.occurredAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} mb={2}>
                          {item.versions.map((version) => (
                            <Badge
                              key={version.version}
                              size="xs"
                              variant={
                                version.version === item.version
                                  ? "filled"
                                  : "outline"
                              }
                              color={
                                version.version === item.version
                                  ? "teal"
                                  : "gray"
                              }
                            >
                              V{version.version}
                            </Badge>
                          ))}
                        </Group>
                        <Text size="xs">
                          {item.submittedBy} · 当前 V{item.version}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {new Date(item.submittedAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {item.attachment}
                        </Text>
                      </Table.Td>
                      <Table.Td maw={260}>
                        <Text size="xs" c="dimmed">
                          {item.note}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="orange"
                          leftSection={<GitBranchPlus size={13} />}
                          onClick={() => setSupplementTarget(item)}
                        >
                          补版本
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="conclusions" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Paper withBorder>
                <Group justify="space-between" p="md">
                  <div>
                    <Text fw={600}>结论版本</Text>
                    <Text size="sm" c="dimmed">
                      提交即冻结证据版本与告警；已通过版本保留快照，证据补版只使草稿与待复核版本失效重算。
                    </Text>
                  </div>
                  <Button onClick={conclusionModal.open}>新建版本</Button>
                </Group>
                <Stack gap={0}>
                  {data.conclusions.map((item, index) => (
                    <div key={item.id}>
                      {index > 0 ? <Divider /> : null}
                      <Stack gap="xs" p="md">
                        <Group justify="space-between">
                          <Group>
                            <Text fw={600}>V{item.version}</Text>
                            <ConclusionStatusBadge value={item.status} />
                            <Badge variant="light" color="gray">
                              {dispositionLabels[item.disposition]}
                            </Badge>
                            {item.conflictBatchId ? (
                              <Badge variant="outline" color="orange">
                                并发落败草稿
                              </Badge>
                            ) : null}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {item.createdBy} ·{" "}
                            {new Date(item.createdAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </Text>
                        </Group>
                        <Text size="sm">{item.rationale}</Text>
                        <Group gap="xs">
                          {item.riskControls.map((control) => (
                            <Badge key={control} variant="outline" color="gray">
                              {control}
                            </Badge>
                          ))}
                        </Group>
                        <ConclusionBasis
                          conclusion={item}
                          evidence={data.evidence}
                        />
                        {item.reviewerNote ? (
                          <Alert
                            color={
                              item.status === "approved" ? "teal" : "orange"
                            }
                            title={`复核意见 · ${item.reviewer}`}
                          >
                            {item.reviewerNote}
                          </Alert>
                        ) : null}
                      </Stack>
                    </div>
                  ))}
                </Stack>
              </Paper>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <Paper withBorder p="md">
                <Title order={4}>复核操作</Title>
                {reviewableConclusion ? (
                  <>
                    <Text size="sm" c="dimmed" mt={5}>
                      待复核版本 V{reviewableConclusion.version} ·{" "}
                      {reviewableConclusion.createdBy} ·{" "}
                      {dispositionLabels[reviewableConclusion.disposition]}
                    </Text>
                    {reviewableConclusion.basisStatus === "evidence_pending" ? (
                      <Alert color="red" mt="md" icon={<RotateCcw size={16} />}>
                        该历史结论提交时缺少证据版本，已标记待补证，不能通过；请退回后补充证据并重新提交。
                      </Alert>
                    ) : !outcome.basisCurrent ? (
                      <Alert color="yellow" mt="md" icon={<RotateCcw size={16} />}>
                        冻结依据在台账上已有新版本，但该版本仍处于待复核；请核对后通过或退回重算。
                      </Alert>
                    ) : (
                      <Alert
                        color="orange"
                        icon={<RotateCcw size={16} />}
                        mt="md"
                      >
                        关系关联不能直接作为结论。通过前请核对冻结的证据版本、告警快照与证据强度。
                      </Alert>
                    )}
                    <Textarea
                      label="复核意见"
                      description="通过或退回意见均进入不可删除的审计记录"
                      minRows={4}
                      mt="md"
                      value={reviewNote}
                      onChange={(event) =>
                        setReviewNote(event.currentTarget.value)
                      }
                    />
                    <Group mt="md">
                      <Button
                        leftSection={<Check size={16} />}
                        color="teal"
                        loading={isReviewing}
                        disabled={
                          reviewableConclusion.basisStatus ===
                          "evidence_pending"
                        }
                        onClick={() => handleReview("approve")}
                      >
                        复核通过
                      </Button>
                      <Button
                        variant="light"
                        color="orange"
                        leftSection={<RotateCcw size={16} />}
                        loading={isReviewing}
                        onClick={() => handleReview("return")}
                      >
                        退回补证
                      </Button>
                    </Group>
                  </>
                ) : (
                  <Stack gap="sm" mt="md">
                    <Text c="dimmed">当前没有待复核版本。</Text>
                    {staleConclusions.length > 0 ? (
                      <Alert color="yellow">
                        {staleConclusions.length} 份结论因证据发布新版本而失效，调查员需依据新版本重新提交。
                      </Alert>
                    ) : null}
                  </Stack>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="alerts" pt="md">
          <Paper withBorder>
            <Group justify="space-between" p="md">
              <div>
                <Text fw={600}>关联告警</Text>
                <Text size="sm" c="dimmed">
                  提交结论时这些告警以快照形式冻结，后续分诊状态变化不影响已提交依据。
                </Text>
              </div>
              <Badge variant="light" color="teal">
                当前 {caseAlerts.length} 条
              </Badge>
            </Group>
            <Table.ScrollContainer minWidth={820}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>告警编号</Table.Th>
                    <Table.Th>标题</Table.Th>
                    <Table.Th>账户</Table.Th>
                    <Table.Th>风险</Table.Th>
                    <Table.Th>金额</Table.Th>
                    <Table.Th>检测时间</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {caseAlerts.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td ff="monospace">{item.id}</Table.Td>
                      <Table.Td>{item.title}</Table.Td>
                      <Table.Td>{item.account}</Table.Td>
                      <Table.Td>
                        <RiskBadge value={item.riskLevel} />
                      </Table.Td>
                      <Table.Td>¥{item.amount.toLocaleString("zh-CN")}</Table.Td>
                      <Table.Td>
                        {new Date(item.detectedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>
      </Tabs>

      <Modal
        opened={nodeOpened}
        onClose={nodeModal.close}
        title="加入案件图谱节点"
        size="lg"
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="关系源节点"
            required
            searchable
            value={nodeForm.sourceId}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                sourceId: value ?? "",
              }))
            }
            data={data.nodes.map((item) => ({
              value: item.id,
              label: item.data.label,
            }))}
          />
          <Select
            label="节点类型"
            value={nodeForm.kind}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                kind: (value as NodeKind) ?? "account",
              }))
            }
            data={[
              { value: "account", label: "账户" },
              { value: "device", label: "设备" },
              { value: "ip", label: "IP 地址" },
              { value: "merchant", label: "商户" },
            ]}
          />
          <TextInput
            label="节点名称"
            required
            value={nodeForm.label}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                label: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={nodeForm.source}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="风险等级"
            value={nodeForm.riskLevel}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                riskLevel: (value as RiskLevel) ?? "medium",
              }))
            }
            data={[
              { value: "high", label: "高风险" },
              { value: "medium", label: "中风险" },
              { value: "low", label: "低风险" },
            ]}
          />
          <Select
            label="证据强度"
            value={nodeForm.evidenceStrength}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                evidenceStrength:
                  (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强" },
              { value: "medium", label: "中" },
              { value: "weak", label: "弱" },
            ]}
          />
          <TextInput
            type="datetime-local"
            label="证据发生时间"
            value={nodeForm.occurredAt}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <NumberInput
            label="关联金额"
            value={nodeForm.amount}
            min={0}
            thousandSeparator
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                amount: Number(value) || 0,
              }))
            }
          />
          <TextInput
            label="关系名称"
            placeholder="例如：转账 12 万"
            value={nodeForm.relationLabel}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                relationLabel: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="关系解释"
            placeholder="说明关联依据与限制"
            value={nodeForm.relationExplanation}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                relationExplanation: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="节点说明"
          minRows={3}
          mt="md"
          value={nodeForm.note}
          onChange={(event) =>
            setNodeForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={nodeModal.close}>
            取消
          </Button>
          <Button onClick={handleAddNode}>加入图谱</Button>
        </Group>
      </Modal>

      <Modal
        opened={evidenceOpened}
        onClose={evidenceModal.close}
        title="登记案件证据"
        size="lg"
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="证据名称"
            required
            value={evidenceForm.title}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                title: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={evidenceForm.source}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="证据强度"
            value={evidenceForm.strength}
            onChange={(value) =>
              setEvidenceForm((current) => ({
                ...current,
                strength: (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强证据" },
              { value: "medium", label: "中等证据" },
              { value: "weak", label: "弱证据" },
            ]}
          />
          <TextInput
            type="datetime-local"
            label="证据发生时间"
            value={evidenceForm.occurredAt}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="附件标识"
            required
            placeholder="文件名或本地附件编号"
            value={evidenceForm.attachment}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                attachment: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="证据说明"
          minRows={3}
          mt="md"
          value={evidenceForm.note}
          onChange={(event) =>
            setEvidenceForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={evidenceModal.close}>
            取消
          </Button>
          <Button loading={isAddingEvidence} onClick={handleAddEvidence}>
            登记证据
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={conclusionOpened}
        onClose={conclusionModal.close}
        title="新建结论版本"
        size="lg"
      >
        <Select
          label="处置建议"
          value={conclusionForm.disposition}
          onChange={(value) =>
            setConclusionForm((current) => ({
              ...current,
              disposition: (value as CaseDisposition) ?? "observe",
            }))
          }
          data={[
            { value: "freeze", label: "建议冻结" },
            { value: "release", label: "建议放行" },
            { value: "observe", label: "继续观察" },
          ]}
        />
        <Textarea
          label="结论依据"
          description="至少 12 个字符；说明关联事实、证据限制与判断边界"
          minRows={5}
          mt="md"
          value={conclusionForm.rationale}
          onChange={(event) =>
            setConclusionForm((current) => ({
              ...current,
              rationale: event.currentTarget.value,
            }))
          }
        />
        <Textarea
          label="风险控制措施"
          description="每行一项"
          minRows={4}
          mt="md"
          value={conclusionForm.riskControls}
          onChange={(event) =>
            setConclusionForm((current) => ({
              ...current,
              riskControls: event.currentTarget.value,
            }))
          }
        />
        <Alert color="gray" mt="md">
          保存草稿不会触发复核；提交时将冻结当前证据版本与关联告警快照。两位调查员同时提交时，先到版本入库，后到版本保留为附带双方依据的草稿。
        </Alert>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={conclusionModal.close}>
            取消
          </Button>
          <Button
            variant="light"
            loading={isSavingConclusion}
            onClick={() => handleSaveConclusion(false)}
          >
            保存草稿
          </Button>
          <Button
            loading={isSavingConclusion}
            onClick={() => handleSaveConclusion(true)}
          >
            提交复核
          </Button>
        </Group>
      </Modal>

      <SupplementEvidenceModal
        opened={supplementTarget !== undefined}
        evidence={supplementTarget}
        submitting={isSupplementing}
        onClose={() => setSupplementTarget(undefined)}
        onSubmit={handleSupplement}
      />
    </Stack>
  );
}
