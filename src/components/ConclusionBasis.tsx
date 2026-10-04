import {
  Alert,
  Badge,
  Group,
  List,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import {
  AlertTriangle,
  FileClock,
  GitCompareArrows,
  History,
  Link2,
  ShieldCheck,
} from "lucide-react";
import type {
  ConclusionVersion,
  Evidence,
  FrozenAlertRef,
  FrozenEvidenceRef,
} from "../models/types";
import { basisCurrent } from "../services/decisionEngine";
import { EvidenceStrengthBadge } from "./Badges";

const formatAt = (value: string): string =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

const modeLabel = (mode: FrozenEvidenceRef["mode"]): string =>
  mode === "frozen" ? "提交冻结" : "按时间回填";

const EvidenceRefList = ({
  refs,
}: {
  refs: FrozenEvidenceRef[];
}) => {
  if (refs.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        未关联证据版本。
      </Text>
    );
  }
  return (
    <List spacing={4} size="xs">
      {refs.map((ref) => (
        <List.Item
          key={`${ref.evidenceId}-${ref.version}`}
          icon={<FileClock size={14} />}
        >
          <Group gap={6}>
            <Text component="span" fw={600}>
              {ref.title}
            </Text>
            <Badge size="xs" variant="light" color="blue">
              V{ref.version}
            </Badge>
            <EvidenceStrengthBadge value={ref.strength} />
            <Badge size="xs" variant="outline" color="gray">
              {modeLabel(ref.mode)}
            </Badge>
          </Group>
          <Text component="span" size="xs" c="dimmed">
            {ref.source} · {formatAt(ref.occurredAt)}
          </Text>
        </List.Item>
      ))}
    </List>
  );
};

const AlertRefList = ({ refs }: { refs: FrozenAlertRef[] }) => {
  if (refs.length === 0) {
    return null;
  }
  return (
    <Group gap={6} mt={6}>
      <Link2 size={14} />
      {refs.map((ref) => (
        <Badge key={ref.alertId} size="xs" variant="light" color="gray">
          {ref.alertId}
          <Text component="span" c="dimmed" ml={4}>
            {ref.mode === "frozen" ? "告警快照" : "回填"}
          </Text>
        </Badge>
      ))}
    </Group>
  );
};

/** 结论提交时冻结的依据：证据版本 + 告警快照 */
export function ConclusionBasis({
  conclusion,
  evidence,
}: {
  conclusion: ConclusionVersion;
  evidence: Evidence[];
}) {
  const current = basisCurrent(conclusion, evidence);

  return (
    <Paper
      withBorder
      bg="var(--mantine-color-gray-0)"
      p="sm"
      mt="sm"
    >
      <Group justify="space-between" mb={6}>
        <Group gap={6}>
          <History size={15} />
          <Text size="sm" fw={600}>
            判定依据快照
          </Text>
        </Group>
        {conclusion.basisStatus === "evidence_pending" ? (
          <Badge color="red" variant="light" leftSection={<AlertTriangle size={12} />}>
            待补证
          </Badge>
        ) : current ? (
          <Badge color="teal" variant="light" leftSection={<ShieldCheck size={12} />}>
            依据版本与台账一致
          </Badge>
        ) : (
          <Badge color="yellow" variant="light" leftSection={<AlertTriangle size={12} />}>
            台账已有新版本
          </Badge>
        )}
      </Group>
      <EvidenceRefList refs={conclusion.evidenceRefs} />
      <AlertRefList refs={conclusion.alertRefs} />
      {conclusion.basisStatus === "evidence_pending" ? (
        <Alert color="red" mt="sm" icon={<AlertTriangle size={16} />}>
          该结论提交时没有可回放的证据版本，需补证后重新提交，复核不能通过。
        </Alert>
      ) : null}
      {conclusion.status === "stale" && conclusion.staleReason ? (
        <Alert color="yellow" mt="sm" icon={<AlertTriangle size={16} />}>
          {conclusion.staleReason}
        </Alert>
      ) : null}
      {conclusion.conflictBasis ? (
        <Stack gap={6} mt="sm">
          <Group gap={6}>
            <GitCompareArrows size={15} />
            <Text size="sm" fw={600}>
              并发先到者依据 · {conclusion.conflictBasis.createdBy}
            </Text>
            {conclusion.conflictBasis.conclusionId ? (
              <Badge size="xs" color="teal">
                已入库 {conclusion.conflictBasis.conclusionId}
              </Badge>
            ) : (
              <Badge size="xs" color="orange">
                对端批次中断
              </Badge>
            )}
          </Group>
          <EvidenceRefList refs={conclusion.conflictBasis.evidenceRefs} />
          <AlertRefList refs={conclusion.conflictBasis.alertRefs} />
          <Text size="xs" c="dimmed">
            本版为后到者保留草稿，可对照双方依据后重新提交；重新提交将生成新版本。
          </Text>
        </Stack>
      ) : null}
    </Paper>
  );
}
