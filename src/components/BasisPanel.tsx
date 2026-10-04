import { Badge, Group, Paper, Stack, Text, ThemeIcon } from "@mantine/core";
import { AlertTriangle, BellRing, FileCheck2, GitCompare } from "lucide-react";
import type { ConclusionView } from "../models/types";
import { BasisStateBadge, EvidenceStrengthBadge } from "./Badges";

const formatTime = (value: string): string =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

interface BasisPanelProps {
  view: ConclusionView;
  /** 是否并排展示先入库版本的依据（并发冲突草稿）。 */
  showWinner?: boolean;
}

const BasisList = ({
  title,
  view,
}: {
  title: string;
  view: ConclusionView;
}) => (
  <Stack gap={6}>
    <Group gap={6}>
      <FileCheck2 size={14} />
      <Text size="xs" fw={700}>
        {title}（{view.evidenceBasis.length}）
      </Text>
    </Group>
    {view.evidenceBasis.length === 0 ? (
      <Text size="xs" c="red">
        未冻结任何证据版本
      </Text>
    ) : (
      view.evidenceBasis.map((ref) => {
        const stale = view.staleEvidence.find(
          (item) => item.ref.evidenceId === ref.evidenceId,
        );
        return (
          <Group
            key={ref.evidenceId}
            gap={8}
            wrap="nowrap"
            align="flex-start"
          >
            <Text size="xs" ff="monospace" style={{ flexShrink: 0 }}>
              V{ref.version}
            </Text>
            <div style={{ flex: 1 }}>
              <Group gap={6}>
                <Text size="xs" fw={600}>
                  {ref.title}
                </Text>
                <EvidenceStrengthBadge value={ref.strength} />
              </Group>
              <Text size="xs" c="dimmed">
                {formatTime(ref.submittedAt)}
              </Text>
              {stale ? (
                <Text size="xs" c="yellow.8" fw={600}>
                  已更新到 V{stale.latest.version}（
                  {formatTime(stale.latest.submittedAt)}），本快照保留旧依据
                </Text>
              ) : null}
            </div>
          </Group>
        );
      })
    )}
  </Stack>
);

const AlertList = ({ view }: { view: ConclusionView }) => (
  <Stack gap={6}>
    <Group gap={6}>
      <BellRing size={14} />
      <Text size="xs" fw={700}>
        冻结告警（{view.alertBasis.length}）
      </Text>
    </Group>
    {view.alertBasis.length === 0 ? (
      <Text size="xs" c="dimmed">
        提交时案件未关联告警
      </Text>
    ) : (
      view.alertBasis.map((snapshot) => {
        const changed = view.changedAlerts.find(
          (item) => item.snapshot.id === snapshot.id,
        );
        return (
          <Group key={snapshot.id} gap={8} wrap="nowrap" align="flex-start">
            <Text size="xs" ff="monospace" style={{ flexShrink: 0 }}>
              v{snapshot.version}
            </Text>
            <div style={{ flex: 1 }}>
              <Text size="xs" fw={600}>
                {snapshot.title}
              </Text>
              <Text size="xs" c="dimmed">
                {snapshot.id} · {snapshot.status}
              </Text>
              {changed ? (
                <Text size="xs" c="yellow.8" fw={600}>
                  现版本 v{changed.current?.version ?? "?"}，差异：
                  {changed.changed.join("、")}
                </Text>
              ) : null}
            </div>
          </Group>
        );
      })
    )}
  </Stack>
);

/**
 * 结论判定依据面板：展示提交时冻结的证据版本、告警快照、
 * 依据失效信息以及并发冲突时两边依据的对比。
 * 案件页、导出均使用同一份数据。
 */
export function BasisPanel({ view, showWinner = true }: BasisPanelProps) {
  const hasWinner = showWinner && view.winner;
  return (
    <Paper
      withBorder
      bg={view.basisState === "missing" ? "var(--mantine-color-red-0)" : "var(--mantine-color-gray-0)"}
      p="sm"
    >
      <Group justify="space-between" mb={8}>
        <Group gap={6}>
          <ThemeIcon size="sm" variant="light" color="cyan">
            <FileCheck2 size={13} />
          </ThemeIcon>
          <Text size="xs" fw={700}>
            判定依据快照
          </Text>
        </Group>
        <BasisStateBadge value={view.basisState} />
      </Group>

      {view.conclusion.staleReason ? (
        <Group gap={6} mb={8} align="flex-start">
          <AlertTriangle size={14} color="var(--mantine-color-yellow-7)" />
          <Text size="xs" c="yellow.8">
            {view.conclusion.staleReason}
          </Text>
        </Group>
      ) : null}

      <Stack gap="md">
        <BasisList title="冻结证据版本" view={view} />
        <AlertList view={view} />
      </Stack>

      {hasWinner && view.winner && view.winnerEvidenceBasis && view.winnerAlertBasis ? (
        <Paper withBorder p="sm" mt="sm" bg="white">
          <Group gap={6} mb={8}>
            <GitCompare size={14} />
            <Badge size="xs" color="grape" variant="light">
              先入库版本 V{view.winner.version} · {view.winner.createdBy}
            </Badge>
            <Text size="xs" c="dimmed">
              先到提交保留的依据，供并排核对
            </Text>
          </Group>
          <Stack gap="sm">
            <Stack gap={4}>
              {view.winnerEvidenceBasis.map((ref) => (
                <Group key={ref.evidenceId} gap={8} wrap="nowrap">
                  <Text size="xs" ff="monospace">V{ref.version}</Text>
                  <Text size="xs">{ref.title}</Text>
                  <EvidenceStrengthBadge value={ref.strength} />
                </Group>
              ))}
            </Stack>
            <Stack gap={4}>
              {view.winnerAlertBasis.map((snapshot) => (
                <Group key={snapshot.id} gap={8} wrap="nowrap">
                  <Text size="xs" ff="monospace">v{snapshot.version}</Text>
                  <Text size="xs">{snapshot.title}</Text>
                </Group>
              ))}
            </Stack>
          </Stack>
        </Paper>
      ) : null}
    </Paper>
  );
}
