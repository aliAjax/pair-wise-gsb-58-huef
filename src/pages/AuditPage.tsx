import {
  Badge,
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  Bomb,
  Download,
  FileJson,
  FileSpreadsheet,
  RotateCcw,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DecisionBatch } from "../models/types";
import {
  useGetAuditLogsQuery,
  useGetCaseOutcomesQuery,
  useGetCasesQuery,
  useGetDecisionBatchesQuery,
  useArmCrashMutation,
  useRecoverBatchesMutation,
  useResetMockDataMutation,
} from "../services/api";

const download = (
  filename: string,
  content: string,
  type = "text/plain;charset=utf-8",
) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const escapeCsv = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const batchKindLabel: Record<DecisionBatch["kind"], string> = {
  submit_conclusion: "提交结论",
  review_conclusion: "结论复核",
  supplement_evidence: "证据补版",
  link_alerts: "关联告警",
};

const crashStepOptions: Array<{
  value: string;
  label: string;
  group: string;
}> = [
  { value: "submit_conclusion:freeze_basis", label: "提交结论 · 冻结依据后", group: "提交结论" },
  { value: "submit_conclusion:insert_conclusion", label: "提交结论 · 写入结论后", group: "提交结论" },
  { value: "submit_conclusion:update_case", label: "提交结论 · 更新案件后", group: "提交结论" },
  { value: "submit_conclusion:audit", label: "提交结论 · 写审计后", group: "提交结论" },
  { value: "supplement_evidence:append_evidence_version", label: "证据补版 · 追加版本后", group: "证据补版" },
  { value: "supplement_evidence:invalidate_conclusions", label: "证据补版 · 失效结论后", group: "证据补版" },
  { value: "supplement_evidence:audit", label: "证据补版 · 写审计后", group: "证据补版" },
  { value: "review_conclusion:update_conclusion", label: "结论复核 · 更新结论后", group: "结论复核" },
  { value: "review_conclusion:audit", label: "结论复核 · 写审计后", group: "结论复核" },
  { value: "link_alerts:link_alerts", label: "关联告警 · 关联后", group: "关联告警" },
];

export function AuditPage() {
  const { data: logs = [] } = useGetAuditLogsQuery();
  const { data: cases = [] } = useGetCasesQuery();
  const { data: outcomes = [] } = useGetCaseOutcomesQuery();
  const { data: batches = [] } = useGetDecisionBatchesQuery();
  const [resetMockData, { isLoading: isResetting }] =
    useResetMockDataMutation();
  const [recoverBatches, { isLoading: isRecovering }] =
    useRecoverBatchesMutation();
  const [armCrash] = useArmCrashMutation();
  const [keyword, setKeyword] = useState("");
  const [caseId, setCaseId] = useState("all");
  const [crashTarget, setCrashTarget] = useState<string | null>(
    "submit_conclusion:freeze_basis",
  );

  const filteredLogs = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    return logs.filter((item) => {
      const matchesCase = caseId === "all" || item.caseId === caseId;
      const matchesKeyword =
        !normalized ||
        [item.actor, item.action, item.detail, item.caseId ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return matchesCase && matchesKeyword;
    });
  }, [caseId, keyword, logs]);

  const interruptedCount = batches.filter(
    (item) => item.status === "interrupted",
  ).length;

  const handleReset = async () => {
    await resetMockData().unwrap();
    notifications.show({
      color: "teal",
      title: "演示数据已重置",
      message: "案件、证据版本、判定批次与审计记录已恢复为初始数据。",
    });
  };

  const handleRecover = async () => {
    try {
      const result = await recoverBatches().unwrap();
      notifications.show({
        color: "teal",
        title: "批次恢复完成",
        message:
          result.resumed > 0
            ? `已从最近完整批次续跑 ${result.resumed} 个中断批次，只补未完成项。`
            : "没有中断中的判定批次。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "恢复失败",
        message:
          typeof error === "object" && error && "error" in error
            ? String((error as { error: unknown }).error)
            : "请重试。",
      });
    }
  };

  const handleArmCrash = () => {
    if (!crashTarget) {
      return;
    }
    const [kind, ...rest] = crashTarget.split(":");
    armCrash({
      batchKind: kind as DecisionBatch["kind"],
      afterStep: rest.join(":"),
    });
    notifications.show({
      color: "orange",
      title: "已安排一次写库中断",
      message: `下一次「${batchKindLabel[kind as DecisionBatch["kind"]]}」在该步骤落盘后中断；重试只会补齐未完成步骤。`,
      autoClose: 8000,
    });
  };

  const exportOutcomesJson = () => {
    const payload = outcomes.map((row) => ({
      caseId: row.caseId,
      caseTitle: row.case.title,
      processStatus: row.case.status,
      outcome: row.kind,
      outcomeLabel: row.label,
      anchorConclusionId: row.anchorConclusion?.id,
      anchorVersion: row.anchorConclusion?.version,
      basisStatus: row.anchorConclusion?.basisStatus,
      basisCurrent: row.basisCurrent,
      staleCount: row.staleCount,
      conflictDraftCount: row.conflictDrafts.length,
      frozenEvidence:
        row.anchorConclusion?.evidenceRefs.map((ref) => ({
          evidenceId: ref.evidenceId,
          version: ref.version,
          mode: ref.mode,
        })) ?? [],
      frozenAlerts:
        row.anchorConclusion?.alertRefs.map((ref) => ref.alertId) ?? [],
    }));
    download(
      "fraud-case-outcomes.json",
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8",
    );
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>审计与报告</Title>
          <Text c="dimmed" size="sm" mt={4}>
            证据台账、结论复核、告警关联统一走可恢复判定批次；留痕不可变，导出与案件页同一结果。
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            leftSection={<RotateCcw size={16} />}
            loading={isResetting}
            onClick={handleReset}
          >
            重置演示数据
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder p="md">
          <Text size="sm" c="dimmed">
            审计事件
          </Text>
          <Title order={3} mt={5}>
            {logs.length}
          </Title>
        </Paper>
        <Paper withBorder p="md">
          <Text size="sm" c="dimmed">
            判定批次
          </Text>
          <Title order={3} mt={5}>
            {batches.length}
            <Text component="span" size="sm" c="orange" ml={8}>
              {interruptedCount} 中断
            </Text>
          </Title>
        </Paper>
        <Paper withBorder p="md">
          <Text size="sm" c="dimmed">
            幂等保证
          </Text>
          <Text size="sm" fw={600} mt={9}>
            重试不补审计、不加版本
          </Text>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-end">
          <div>
            <Text fw={600}>写库中断演练</Text>
            <Text size="xs" c="dimmed">
              安排下一次批次在指定步骤后中断；随后到案件页重试提交/补版/复核，再回到这里执行恢复。
            </Text>
          </div>
          <Group>
            <Select
              w={300}
              value={crashTarget}
              onChange={setCrashTarget}
              data={[
                {
                  group: "提交结论",
                  items: crashStepOptions
                    .filter((item) => item.group === "提交结论")
                    .map((item) => ({ value: item.value, label: item.label })),
                },
                {
                  group: "证据补版",
                  items: crashStepOptions
                    .filter((item) => item.group === "证据补版")
                    .map((item) => ({ value: item.value, label: item.label })),
                },
                {
                  group: "结论复核",
                  items: crashStepOptions
                    .filter((item) => item.group === "结论复核")
                    .map((item) => ({ value: item.value, label: item.label })),
                },
                {
                  group: "关联告警",
                  items: crashStepOptions
                    .filter((item) => item.group === "关联告警")
                    .map((item) => ({ value: item.value, label: item.label })),
                },
              ]}
            />
            <Button
              variant="light"
              color="orange"
              leftSection={<Bomb size={16} />}
              onClick={handleArmCrash}
            >
              安排中断
            </Button>
            <Button
              variant="light"
              color="teal"
              leftSection={<RotateCcw size={16} />}
              loading={isRecovering}
              onClick={handleRecover}
            >
              立即恢复中断批次
            </Button>
          </Group>
        </Group>
      </Paper>

      <Tabs defaultValue="logs">
        <Tabs.List>
          <Tabs.Tab value="logs">审计记录</Tabs.Tab>
          <Tabs.Tab value="batches">
            判定批次{interruptedCount > 0 ? `（${interruptedCount} 中断）` : ""}
          </Tabs.Tab>
          <Tabs.Tab value="export">统一结果导出</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="logs" pt="md">
          <Paper withBorder p="md" mb="md">
            <Group grow align="flex-end">
              <TextInput
                label="关键词"
                placeholder="操作人、动作、详情或案件编号"
                leftSection={<Search size={16} />}
                value={keyword}
                onChange={(event) => setKeyword(event.currentTarget.value)}
              />
              <Select
                label="案件"
                value={caseId}
                onChange={(value) => setCaseId(value ?? "all")}
                data={[
                  { value: "all", label: "全部案件" },
                  ...cases.map((item) => ({
                    value: item.id,
                    label: `${item.id} ${item.title}`,
                  })),
                ]}
              />
            </Group>
          </Paper>
          <Paper withBorder>
            <Table.ScrollContainer minWidth={960}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>时间</Table.Th>
                    <Table.Th>案件</Table.Th>
                    <Table.Th>操作人</Table.Th>
                    <Table.Th>动作</Table.Th>
                    <Table.Th>批次</Table.Th>
                    <Table.Th>详情</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filteredLogs.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {new Date(item.at).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {item.caseId ?? "系统级"}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.actor}</Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {item.action}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {item.batchId ? (
                          <Text size="xs" ff="monospace">
                            {item.batchId}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td maw={520}>
                        <Text size="sm">{item.detail}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
          <Group mt="md">
            <Button
              variant="light"
              leftSection={<FileJson size={16} />}
              onClick={() =>
                download(
                  "fraud-case-audit.json",
                  JSON.stringify(filteredLogs, null, 2),
                  "application/json;charset=utf-8",
                )
              }
            >
              导出审计 JSON
            </Button>
            <Button
              leftSection={<FileSpreadsheet size={16} />}
              onClick={() =>
                download(
                  "fraud-case-audit.csv",
                  [
                    ["时间", "案件", "操作人", "动作", "批次", "详情"],
                    ...filteredLogs.map((item) => [
                      item.at,
                      item.caseId ?? "",
                      item.actor,
                      item.action,
                      item.batchId ?? "",
                      item.detail,
                    ]),
                  ]
                    .map((row) => row.map(escapeCsv).join(","))
                    .join("\n"),
                  "text/csv;charset=utf-8",
                )
              }
            >
              导出审计 CSV
            </Button>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value="batches" pt="md">
          <Paper withBorder>
            <Table.ScrollContainer minWidth={1080}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>批次</Table.Th>
                    <Table.Th>类型</Table.Th>
                    <Table.Th>案件</Table.Th>
                    <Table.Th>角色</Table.Th>
                    <Table.Th>状态 / 已完成步骤</Table.Th>
                    <Table.Th>建立时间</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...batches]
                    .sort(
                      (a, b) =>
                        Date.parse(b.createdAt) - Date.parse(a.createdAt),
                    )
                    .map((item) => (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {item.id}
                          </Text>
                        </Table.Td>
                        <Table.Td>{batchKindLabel[item.kind]}</Table.Td>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {item.caseId}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          {item.role ? (
                            <Badge
                              size="xs"
                              color={item.role === "winner" ? "teal" : "orange"}
                            >
                              {item.role === "winner" ? "先到入库" : "落败草稿"}
                            </Badge>
                          ) : (
                            <Text size="xs" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td maw={360}>
                          <Badge
                            size="xs"
                            color={
                              item.status === "completed" ? "teal" : "orange"
                            }
                            variant={item.status === "completed" ? "light" : "filled"}
                            mb={4}
                          >
                            {item.status === "completed" ? "已完成" : "中断待续"}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {item.stepsCompleted.join(" → ")}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">
                            {new Date(item.createdAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="export" pt="md">
          <Paper withBorder p="md">
            <Group justify="space-between" mb="md">
              <div>
                <Text fw={600}>案件判定结果（与概览、案件页同一出口）</Text>
                <Text size="sm" c="dimmed">
                  含锚定结论、冻结证据版本、告警快照数量与依据一致性。
                </Text>
              </div>
              <Group>
                <Button
                  leftSection={<Download size={16} />}
                  onClick={exportOutcomesJson}
                >
                  导出结果 JSON
                </Button>
                <Button
                  variant="light"
                  leftSection={<FileSpreadsheet size={16} />}
                  onClick={() =>
                    download(
                      "fraud-case-outcomes.csv",
                      [
                        [
                          "案件编号",
                          "案件名称",
                          "流程状态",
                          "判定结果",
                          "锚定结论",
                          "依据状态",
                          "依据一致",
                          "失效数量",
                          "冻结证据",
                          "冻结告警",
                        ],
                        ...outcomes.map((row) => [
                          row.caseId,
                          row.case.title,
                          row.case.status,
                          row.label,
                          row.anchorConclusion
                            ? `${row.anchorConclusion.id} V${row.anchorConclusion.version}`
                            : "",
                          row.anchorConclusion?.basisStatus ?? "",
                          row.basisCurrent ? "是" : "否",
                          String(row.staleCount),
                          (row.anchorConclusion?.evidenceRefs ?? [])
                            .map((ref) => `${ref.evidenceId}@V${ref.version}`)
                            .join("|"),
                          (row.anchorConclusion?.alertRefs ?? [])
                            .map((ref) => ref.alertId)
                            .join("|"),
                        ]),
                      ]
                        .map((row) => row.map(escapeCsv).join(","))
                        .join("\n"),
                      "text/csv;charset=utf-8",
                    )
                  }
                >
                  导出结果 CSV
                </Button>
              </Group>
            </Group>
            <Table.ScrollContainer minWidth={980}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>案件</Table.Th>
                    <Table.Th>判定结果</Table.Th>
                    <Table.Th>锚定结论</Table.Th>
                    <Table.Th>冻结证据版本</Table.Th>
                    <Table.Th>冻结告警</Table.Th>
                    <Table.Th>失效</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {outcomes.map((row) => (
                    <Table.Tr key={row.caseId}>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {row.caseId}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {row.case.title}
                        </Text>
                      </Table.Td>
                      <Table.Td>{row.label}</Table.Td>
                      <Table.Td>
                        {row.anchorConclusion ? (
                          <Text size="xs">
                            {row.anchorConclusion.id} · V
                            {row.anchorConclusion.version} ·{" "}
                            {row.anchorConclusion.basisStatus === "frozen"
                              ? "提交冻结"
                              : row.anchorConclusion.basisStatus === "backfilled"
                                ? "旧数据回填"
                                : "待补证"}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td maw={300}>
                        {row.anchorConclusion &&
                        row.anchorConclusion.evidenceRefs.length > 0 ? (
                          <Group gap={4}>
                            {row.anchorConclusion.evidenceRefs.map((ref) => (
                              <Badge
                                key={`${ref.evidenceId}-${ref.version}`}
                                size="xs"
                                variant="outline"
                                color={
                                  row.basisCurrent ? "teal" : "yellow"
                                }
                              >
                                {ref.evidenceId}@V{ref.version}
                              </Badge>
                            ))}
                          </Group>
                        ) : (
                          <Text size="xs" c="red">
                            待补证
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {row.anchorConclusion?.alertRefs.length ?? 0} 条
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {row.staleCount > 0 ? (
                          <Badge size="xs" color="yellow">
                            {row.staleCount}
                          </Badge>
                        ) : (
                          <Text size="xs" c="dimmed">
                            0
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
