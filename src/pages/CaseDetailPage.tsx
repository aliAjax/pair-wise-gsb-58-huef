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
  FilePlus2,
  Files,
  GitBranchPlus,
  RotateCcw,
  Send,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../app/hooks";
import {
  CaseStatusBadge,
  ConclusionStatusBadge,
  EvidenceStrengthBadge,
  EvidenceVersionBadge,
  RiskBadge,
} from "../components/Badges";
import { BasisPanel } from "../components/BasisPanel";
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
  ConclusionVersion,
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
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useSupplementEvidenceMutation,
  useTransitionCaseMutation,
  useUpdateGraphNodeMutation,
} from "../services/api";
import { buildConclusionView, currentEvidence } from "../services/decisionModel";
import { createId } from "../services/mockStorage";

const dispositionLabels: Record<CaseDisposition, string> = {
  freeze: "建议冻结",
  release: "建议放行",
  observe: "继续观察",
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请检查输入后重试。";
};

interface EvidenceFormState {
  seriesId?: string;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  attachment: string;
  note: string;
}

const emptyEvidenceForm: EvidenceFormState = {
  title: "",
  source: "",
  strength: "medium",
  occurredAt: "2026-09-29T09:00",
  attachment: "",
  note: "",
};

export function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const actor = useAppSelector((state) => state.alertsUi.actor);
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

  const [nodeOpened, nodeModal] = useDisclosure(false);
  const [evidenceOpened, evidenceModal] = useDisclosure(false);
  const [conclusionOpened, conclusionModal] = useDisclosure(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewTargetId, setReviewTargetId] = useState<string | null>(null);
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
  const [evidenceForm, setEvidenceForm] =
    useState<EvidenceFormState>(emptyEvidenceForm);
  const [conclusionForm, setConclusionForm] = useState({
    disposition: "observe" as CaseDisposition,
    rationale: "",
    riskControls: "",
  });

  const caseCurrentEvidence = useMemo(
    () => (data ? currentEvidence(caseId, data.evidence) : []),
    [data, caseId],
  );

  // 台账按逻辑证据系列分组，每系列展示全部版本
  const evidenceSeries = useMemo(() => {
    if (!data) {
      return [];
    }
    const groups = new Map<string, Evidence[]>();
    data.evidence
      .filter((item) => item.caseId === caseId)
      .forEach((item) => {
        groups.set(item.seriesId, [
          ...(groups.get(item.seriesId) ?? []),
          item,
        ]);
      });
    return Array.from(groups.entries()).map(([seriesId, versions]) => {
      const sorted = versions.sort((a, b) => b.version - a.version);
      return { seriesId, versions: sorted, latest: sorted[0] };
    });
  }, [data, caseId]);

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

  const conclusionViews = data.conclusions.map((item) =>
    buildConclusionView(item, {
      evidence: data.evidence,
      conclusions: data.conclusions,
      alerts: allAlerts,
    }),
  );
  const submittedConclusion = data.conclusions.find(
    (item) => item.status === "submitted",
  );
  const reviewTarget: ConclusionVersion | undefined =
    data.conclusions.find((item) => item.id === reviewTargetId) ??
    submittedConclusion;

  const staleNotice = data.hasStaleBasis ? (
    <Alert color="yellow" icon={<RotateCcw size={16} />}>
      案件存在依据已更新的草稿或待复核结论，需基于新证据版本重算；已通过版本仍保留提交时的冻结快照。
    </Alert>
  ) : null;
  const missingNotice = data.hasMissingBasis ? (
    <Alert color="red" icon={<Files size={16} />}>
      旧结论未能按提交时间回填证据版本，已标记待补证；补充证据后请重新提交结论。
    </Alert>
  ) : null;

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

  const openRegisterEvidence = () => {
    setEvidenceForm(emptyEvidenceForm);
    evidenceModal.open();
  };

  const openSupplementEvidence = (series: Evidence) => {
    setEvidenceForm({
      seriesId: series.seriesId,
      title: series.title,
      source: series.source,
      strength: series.strength,
      occurredAt: "2026-09-29T09:00",
      attachment: "",
      note: "",
    });
    evidenceModal.open();
  };

  const handleSubmitEvidence = async () => {
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
    const common = {
      caseId,
      actor,
      title: evidenceForm.title.trim(),
      source: evidenceForm.source.trim(),
      strength: evidenceForm.strength,
      occurredAt: new Date(evidenceForm.occurredAt).toISOString(),
      attachment: evidenceForm.attachment.trim(),
      note: evidenceForm.note.trim() || "未补充说明。",
    };
    try {
      if (evidenceForm.seriesId) {
        await supplementEvidence({
          ...common,
          seriesId: evidenceForm.seriesId,
        }).unwrap();
        notifications.show({
          color: "teal",
          title: "证据新版本已提交",
          message:
            "旧版本已保留并标记替代；引用旧版本的草稿与待复核结论已失效，已通过版本不受影响。",
        });
      } else {
        await addEvidence(common).unwrap();
        notifications.show({
          color: "teal",
          title: "证据已登记",
          message: "证据来源、发生时间与提交时间已写入台账。",
        });
      }
      evidenceModal.close();
      setEvidenceForm(emptyEvidenceForm);
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: evidenceForm.seriesId ? "证据补充失败" : "证据登记失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const openConclusionModal = (prefill?: ConclusionVersion) => {
    setConclusionForm({
      disposition: prefill?.disposition ?? "observe",
      rationale: prefill?.rationale ?? "",
      riskControls: prefill?.riskControls.join("\n") ?? "",
    });
    conclusionModal.open();
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
      }).unwrap();
      if (result.conflict) {
        notifications.show({
          color: "grape",
          title: "存在先到的提交",
          message:
            "另一位调查员的结论已先入库；你的内容已保留为冲突草稿，可在结论页并排查看两边冻结依据。",
        });
      } else {
        notifications.show({
          color: "teal",
          title: submit ? "已提交复核" : "草稿已保存",
          message: submit
            ? "提交时的证据版本与告警已冻结，后续证据更新不会改变本版本依据。"
            : "草稿已冻结当时依据，证据更新后草稿将失效重算。",
        });
      }
      conclusionModal.close();
      setConclusionForm({
        disposition: "observe",
        rationale: "",
        riskControls: "",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "结论保存失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleTransition = async (
    status: "investigating" | "pending_review" | "supplement" | "closed",
  ) => {
    try {
      await transitionCase({ caseId, status, actor }).unwrap();
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
    if (!reviewTarget) {
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
    try {
      await reviewConclusion({
        caseId,
        actor: "赵平",
        conclusionId: reviewTarget.id,
        decision,
        reviewerNote: reviewNote.trim(),
      }).unwrap();
      notifications.show({
        color: decision === "approve" ? "teal" : "orange",
        title: decision === "approve" ? "复核通过" : "已退回补证",
        message:
          decision === "approve"
            ? "结论通过，提交时冻结的证据版本与告警快照作为最终依据永久保留。"
            : "已退回补证，需基于新证据版本重新提交。",
      });
      setReviewNote("");
      setReviewTargetId(null);
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
              <CaseStatusBadge value={data.effectiveStatus} />
            </Group>
            <Text c="dimmed" size="sm" mt={5}>
              {data.case.id} · 负责人 {data.case.owner} · 当前操作 {actor} ·
              更新于{" "}
              {new Date(data.case.updatedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </Text>
          </div>
        </Group>
        <Group>
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
            onClick={openRegisterEvidence}
          >
            登记证据
          </Button>
          <Button
            leftSection={<Send size={16} />}
            onClick={() => openConclusionModal()}
          >
            新建结论版本
          </Button>
        </Group>
      </Group>

      {staleNotice}
      {missingNotice}

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
                      点击事件可高亮关系或证据（仅展示各证据当前版本）
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
                    evidence={caseCurrentEvidence}
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
                  同一份证据补充版本后旧版本永久保留；结论按提交时冻结的版本引用。
                </Text>
              </div>
              <Button
                leftSection={<FilePlus2 size={16} />}
                onClick={openRegisterEvidence}
              >
                登记证据
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={1080}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>证据名称 / 版本</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>强度</Table.Th>
                    <Table.Th>发生时间</Table.Th>
                    <Table.Th>提交记录</Table.Th>
                    <Table.Th>附件标识</Table.Th>
                    <Table.Th>版本状态 / 操作</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {evidenceSeries.flatMap((series) =>
                    series.versions.map((item, index) => (
                      <Table.Tr
                        key={item.id}
                        className={
                          focusedEvidenceId === item.id
                            ? "table-row-focused"
                            : ""
                        }
                        style={
                          item.versionState === "superseded"
                            ? { opacity: 0.62 }
                            : undefined
                        }
                      >
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {item.title}
                          </Text>
                          <Text size="xs" c="dimmed" ff="monospace">
                            {item.id} · V{item.version}
                            {index > 0 ? "（历史版本）" : ""}
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
                          <Text size="xs">
                            {item.submittedBy} ·{" "}
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
                        <Table.Td>
                          <Stack gap={6} align="flex-start">
                            <EvidenceVersionBadge value={item.versionState} />
                            {item.versionState === "current" ? (
                              <Button
                                size="compact-xs"
                                variant="light"
                                color="cyan"
                                onClick={() => openSupplementEvidence(item)}
                              >
                                补充新版本
                              </Button>
                            ) : (
                              <Text size="xs" c="dimmed">
                                被 V{series.versions[0].version} 替代
                              </Text>
                            )}
                          </Stack>
                        </Table.Td>
                      </Table.Tr>
                    )),
                  )}
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
                      提交即冻结证据版本与告警；已通过版本永久保留提交快照。
                    </Text>
                  </div>
                  <Button onClick={() => openConclusionModal()}>新建版本</Button>
                </Group>
                <Stack gap={0}>
                  {conclusionViews.map((view, index) => (
                    <div key={view.conclusion.id}>
                      {index > 0 ? <Divider /> : null}
                      <Stack gap="xs" p="md">
                        <Group justify="space-between">
                          <Group>
                            <Text fw={600}>V{view.conclusion.version}</Text>
                            <ConclusionStatusBadge
                              value={view.conclusion.status}
                            />
                            <Badge variant="light" color="gray">
                              {dispositionLabels[view.conclusion.disposition]}
                            </Badge>
                          </Group>
                          <Text size="xs" c="dimmed">
                            {view.conclusion.createdBy} ·{" "}
                            {new Date(
                              view.conclusion.createdAt,
                            ).toLocaleString("zh-CN", { hour12: false })}
                          </Text>
                        </Group>
                        <Text size="sm">{view.conclusion.rationale}</Text>
                        <Group gap="xs">
                          {view.conclusion.riskControls.map((control) => (
                            <Badge
                              key={control}
                              variant="outline"
                              color="gray"
                            >
                              {control}
                            </Badge>
                          ))}
                        </Group>
                        <BasisPanel view={view} />
                        {view.conclusion.status === "invalidated" ? (
                          <Button
                            size="xs"
                            variant="light"
                            color="yellow"
                            leftSection={<RotateCcw size={14} />}
                            onClick={() =>
                              openConclusionModal(view.conclusion)
                            }
                          >
                            按新依据重算并新建版本
                          </Button>
                        ) : null}
                        {view.conclusion.status === "conflict" ? (
                          <Text size="xs" c="grape">
                            该草稿为并发提交的后到版本；先到版本已进入复核，两边依据见上。
                          </Text>
                        ) : null}
                        {view.conclusion.reviewerNote ? (
                          <Alert
                            color={
                              view.conclusion.status === "approved"
                                ? "teal"
                                : "orange"
                            }
                            title={`复核意见 · ${view.conclusion.reviewer}`}
                          >
                            {view.conclusion.reviewerNote}
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
                {reviewTarget && reviewTarget.status === "submitted" ? (
                  <>
                    <Text size="sm" c="dimmed" mt={5}>
                      待复核 V{reviewTarget.version} ·{" "}
                      {reviewTarget.createdBy} ·{" "}
                      {dispositionLabels[reviewTarget.disposition]}
                    </Text>
                    <Alert
                      color="orange"
                      icon={<RotateCcw size={16} />}
                      mt="md"
                    >
                      复核以该版本冻结的证据与告警为准；即使台账随后更新，本版本依据不变。
                    </Alert>
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
                  <Text c="dimmed" mt="md">
                    没有处于待复核状态的结论。
                  </Text>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="alerts" pt="md">
          <Paper withBorder>
            <Table.ScrollContainer minWidth={900}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>告警编号</Table.Th>
                    <Table.Th>标题</Table.Th>
                    <Table.Th>账户</Table.Th>
                    <Table.Th>风险</Table.Th>
                    <Table.Th>金额</Table.Th>
                    <Table.Th>版本</Table.Th>
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
                        <Badge size="sm" variant="light" color="cyan">
                          v{item.version}
                        </Badge>
                      </Table.Td>
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
        title={evidenceForm.seriesId ? "补充证据新版本" : "登记案件证据"}
        size="lg"
      >
        {evidenceForm.seriesId ? (
          <Alert color="cyan" mb="md">
            新版本会替代当前版本用于后续判定；旧版本保留在台账，已通过结论仍引用冻结的旧版本。
          </Alert>
        ) : null}
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
          <Button
            loading={isAddingEvidence || isSupplementing}
            onClick={handleSubmitEvidence}
          >
            {evidenceForm.seriesId ? "提交新版本" : "登记证据"}
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={conclusionOpened}
        onClose={conclusionModal.close}
        title="新建结论版本"
        size="lg"
      >
        <Paper withBorder p="sm" mb="md" bg="var(--mantine-color-gray-0)">
          <Text size="xs" fw={700} mb={6}>
            提交时将冻结以下依据（{actor}）
          </Text>
          <Group gap="xs">
            {caseCurrentEvidence.length === 0 ? (
              <Text size="xs" c="red">
                案件暂无证据，不能提交复核
              </Text>
            ) : (
              caseCurrentEvidence.map((item) => (
                <Badge key={item.id} size="sm" variant="light" color="cyan">
                  {item.title} V{item.version}
                </Badge>
              ))
            )}
          </Group>
          <Text size="xs" c="dimmed" mt={6}>
            告警 {data.case.alertIds.length} 条将按当前版本冻结；若另一调查员先提交，你的提交会保留为冲突草稿。
          </Text>
        </Paper>
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
          保存草稿不会触发复核，但同样冻结当时依据；证据更新后草稿与待复核结论失效重算，已通过版本保留提交快照。
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
    </Stack>
  );
}
