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
  Download,
  FlaskConical,
  RotateCcw,
  Search,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useGetAuditLogsQuery,
  useGetBatchesQuery,
  useGetCasesQuery,
  useGetDecisionReportQuery,
  useRecoverBatchesMutation,
  useResetMockDataMutation,
} from "../services/api";
import { armWriteCrash } from "../services/mockStorage";

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

const batchKindLabels: Record<string, string> = {
  submit_conclusion: "提交结论",
  supplement_evidence: "证据补充版本",
  register_evidence: "登记证据",
  review_conclusion: "结论复核",
  link_alerts: "关联告警",
  update_alert_status: "更新告警状态",
};

const batchStatusConfig: Record<
  string,
  { color: string; label: string }
> = {
  committed: { color: "teal", label: "已完成" },
  interrupted: { color: "yellow", label: "写库中断" },
  conflict: { color: "grape", label: "并发冲突" },
  failed: { color: "red", label: "校验失败" },
};

export function AuditPage() {
  const { data: logs = [] } = useGetAuditLogsQuery();
  const { data: cases = [] } = useGetCasesQuery();
  const { data: batches = [] } = useGetBatchesQuery();
  const { data: report } = useGetDecisionReportQuery();
  const [resetMockData, { isLoading: isResetting }] =
    useResetMockDataMutation();
  const [recoverBatches, { isLoading: isRecovering }] =
    useRecoverBatchesMutation();
  const [keyword, setKeyword] = useState("");
  const [caseId, setCaseId] = useState("all");
  const [crashStep, setCrashStep] = useState("audit");

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

  const interrupted = batches.filter((item) => item.status === "interrupted");

  const handleReset = async () => {
    await resetMockData().unwrap();
    notifications.show({
      color: "teal",
      title: "演示数据已重置",
      message: "本地 localStorage 中的案件、证据、批次与审计记录已恢复为初始数据。",
    });
  };

  const handleRecover = async () => {
    try {
      const result = await recoverBatches().unwrap();
      notifications.show({
        color: "teal",
        title: "已从最近完整批次继续",
        message:
          result.recovered.length > 0
            ? `补完 ${result.recovered.length} 个中断批次的未完成步骤，未产生重复版本或审计。`
            : "没有需要恢复的中断批次。",
      });
    } catch {
      notifications.show({
        color: "red",
        title: "恢复失败",
        message: "请再次尝试恢复；已完成步骤不会重复执行。",
      });
    }
  };

  const handleArmCrash = () => {
    armWriteCrash(crashStep);
    notifications.show({
      color: "yellow",
      title: "已布置写库中断",
      message: `下一次判定批次执行到「${crashStep}」步骤前会模拟写库中断（仅一次），随后可恢复。`,
    });
  };

  const handleExportReportJson = () => {
    if (!report) {
      return;
    }
    download(
      "fraud-decision-report.json",
      JSON.stringify(report, null, 2),
      "application/json;charset=utf-8",
    );
  };

  const handleExportReportCsv = () => {
    if (!report) {
      return;
    }
    const rows: string[][] = [
      [
        "案件编号",
        "案件名称",
        "有效状态",
        "结论版本",
        "结论状态",
        "依据状态",
        "冻结证据",
        "冻结告警",
        "提交人",
        "提交时间",
      ],
    ];
    report.cases.forEach((entry) => {
      entry.conclusions.forEach((view) => {
        rows.push([
          entry.case.id,
          entry.case.title,
          entry.effectiveStatus,
          String(view.conclusion.version),
          view.conclusion.status,
          view.basisState,
          view.evidenceBasis
            .map((ref) => `${ref.title}@V${ref.version}`)
            .join("|"),
          view.alertBasis.map((snapshot) => snapshot.id).join("|"),
          view.conclusion.createdBy,
          view.conclusion.createdAt,
        ]);
      });
    });
    download(
      "fraud-decision-report.csv",
      rows.map((row) => row.map(escapeCsv).join(",")).join("\n"),
      "text/csv;charset=utf-8",
    );
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>审计与报告</Title>
          <Text c="dimmed" size="sm" mt={4}>
            证据台账、结论复核、告警关联与审计记录在可恢复判定批次内落盘；所有页面与导出共用同一份判定结果。
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
          <Button
            variant="light"
            leftSection={<Download size={16} />}
            onClick={handleExportReportJson}
          >
            导出判定 JSON
          </Button>
          <Button
            leftSection={<Download size={16} />}
            onClick={handleExportReportCsv}
          >
            导出判定 CSV
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
            判定批次（中断 {interrupted.length}）
          </Text>
          <Title order={3} mt={5}>
            {batches.length}
          </Title>
        </Paper>
        <Paper withBorder p="md">
          <Text size="sm" c="dimmed">
            不可修改字段
          </Text>
          <Title order={4} mt={8}>
            时间 / 来源 / 操作人 / 冻结依据
          </Title>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-end">
          <div>
            <Group gap={8} mb={6}>
              <FlaskConical size={16} />
              <Text fw={600} size="sm">
                写库中断演练
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              布置后，下一次判定批次（登记/补充证据、提交结论、复核、关联告警）在选定步骤前中断；批次进度保留，可一键恢复且不产生重复版本或审计。
            </Text>
          </div>
          <Group align="flex-end">
            <Select
              label="中断步骤"
              w={220}
              value={crashStep}
              onChange={(value) => setCrashStep(value ?? "audit")}
              data={[
                { value: "write-version", label: "证据：写入新版本前" },
                { value: "invalidate-conclusions", label: "证据：失效旧结论前" },
                { value: "audit", label: "审计写入前" },
                { value: "create-version", label: "结论：写入版本前" },
                { value: "transition-case", label: "状态流转前" },
                { value: "link-alerts", label: "告警：关联写入前" },
                { value: "mark-review", label: "复核：写入结果前" },
              ]}
            />
            <Button
              variant="light"
              color="orange"
              leftSection={<Zap size={16} />}
              onClick={handleArmCrash}
            >
              布置一次中断
            </Button>
            <Button
              color="yellow"
              variant="filled"
              leftSection={<RotateCcw size={16} />}
              loading={isRecovering}
              disabled={interrupted.length === 0}
              onClick={handleRecover}
            >
              恢复中断批次{interrupted.length > 0 ? `（${interrupted.length}）` : ""}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Tabs defaultValue="batches">
        <Tabs.List>
          <Tabs.Tab value="batches">判定批次</Tabs.Tab>
          <Tabs.Tab value="audit">审计记录</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="batches" pt="md">
          <Paper withBorder>
            <Table.ScrollContainer minWidth={1080}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>批次</Table.Th>
                    <Table.Th>类型</Table.Th>
                    <Table.Th>案件</Table.Th>
                    <Table.Th>操作人</Table.Th>
                    <Table.Th>状态</Table.Th>
                    <Table.Th>步骤进度</Table.Th>
                    <Table.Th>时间</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {batches.map((batch) => {
                    const config =
                      batchStatusConfig[batch.status] ??
                      batchStatusConfig.committed;
                    const doneCount = batch.steps.filter(
                      (step) => step.status === "done",
                    ).length;
                    return (
                      <Table.Tr key={batch.id}>
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {batch.id}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          {batchKindLabels[batch.kind] ?? batch.kind}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {batch.caseId ?? "—"}
                          </Text>
                        </Table.Td>
                        <Table.Td>{batch.actor}</Table.Td>
                        <Table.Td>
                          <Badge color={config.color} variant="light">
                            {config.label}
                          </Badge>
                          {batch.note ? (
                            <Text size="xs" c="dimmed" mt={4}>
                              {batch.note}
                            </Text>
                          ) : null}
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4}>
                            {batch.steps.map((step) => (
                              <Badge
                                key={step.key}
                                size="xs"
                                variant={step.status === "done" ? "light" : "outline"}
                                color={step.status === "done" ? "teal" : "gray"}
                              >
                                {step.label}
                              </Badge>
                            ))}
                          </Group>
                          <Text size="xs" c="dimmed" mt={4}>
                            {doneCount}/{batch.steps.length}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">
                            {new Date(batch.createdAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                  {batches.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={7}>
                        <Text c="dimmed" size="sm" py="md" ta="center">
                          尚无判定批次；登记证据、提交结论或关联告警后会在此显示。
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : null}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="audit" pt="md">
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
            <Table.ScrollContainer minWidth={1040}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>时间</Table.Th>
                    <Table.Th>案件</Table.Th>
                    <Table.Th>操作人</Table.Th>
                    <Table.Th>动作</Table.Th>
                    <Table.Th>详情</Table.Th>
                    <Table.Th>批次</Table.Th>
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
                      <Table.Td maw={460}>
                        <Text size="sm">{item.detail}</Text>
                      </Table.Td>
                      <Table.Td>
                        {item.batchId ? (
                          <Text size="xs" ff="monospace" c="cyan.8">
                            {item.batchId}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
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
