import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { DatabaseZap, Play } from "lucide-react";
import {
  useGetBatchesQuery,
  useRecoverBatchesMutation,
} from "../services/api";

const batchKindLabels: Record<string, string> = {
  submit_conclusion: "提交结论",
  supplement_evidence: "证据补充版本",
  register_evidence: "登记证据",
  review_conclusion: "结论复核",
  link_alerts: "关联告警",
  update_alert_status: "更新告警状态",
};

/**
 * 写库中断横幅：存在未完成判定批次时全局出现，
 * 一键从最近完整批次继续，恢复只补未完成步骤。
 */
export function RecoveryBanner() {
  const { data: batches } = useGetBatchesQuery();
  const [recover, { isLoading }] = useRecoverBatchesMutation();

  const interrupted = (batches ?? []).filter(
    (item) => item.status === "interrupted",
  );

  if (interrupted.length === 0) {
    return null;
  }

  const handleRecover = async () => {
    try {
      const result = await recover().unwrap();
      notifications.show({
        color: "teal",
        title: "判定批次已恢复",
        message: `从最近完整批次继续，补完 ${result.recovered.length} 个批次的未完成步骤，未产生重复版本或审计。`,
      });
    } catch {
      notifications.show({
        color: "red",
        title: "恢复失败",
        message: "请再次尝试恢复；已完成步骤不会重复执行。",
      });
    }
  };

  return (
    <Alert
      color="yellow"
      icon={<DatabaseZap size={18} />}
      mb="md"
      styles={{ message: { flex: 1 } }}
    >
      <Group justify="space-between" align="center" wrap="nowrap">
        <Stack gap={2}>
          <Text size="sm" fw={700}>
            检测到 {interrupted.length} 个写库中断的判定批次
          </Text>
          <Text size="xs" c="dimmed">
            {interrupted
              .map(
                (item) =>
                  `${batchKindLabels[item.kind] ?? item.kind}（${item.id}）`,
              )
              .join("、")}
            ；进度已持久化，恢复只会补完未完成步骤。
          </Text>
        </Stack>
        <Button
          size="xs"
          color="yellow"
          variant="filled"
          leftSection={<Play size={14} />}
          loading={isLoading}
          onClick={handleRecover}
        >
          从最近完整批次继续
        </Button>
      </Group>
    </Alert>
  );
}
