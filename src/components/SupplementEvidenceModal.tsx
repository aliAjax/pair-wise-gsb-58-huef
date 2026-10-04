import {
  Badge,
  Button,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { GitBranchPlus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Evidence, EvidenceStrength } from "../models/types";
import { EvidenceStrengthBadge } from "./Badges";

export interface SupplementFormValues {
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  attachment: string;
  note: string;
}

const toLocalInput = (iso: string): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(
    parsed.getDate(),
  )}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
};

export function SupplementEvidenceModal({
  opened,
  evidence,
  submitting,
  onClose,
  onSubmit,
}: {
  opened: boolean;
  evidence?: Evidence;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: SupplementFormValues) => void;
}) {
  const [form, setForm] = useState<SupplementFormValues>({
    title: "",
    source: "",
    strength: "medium",
    occurredAt: "",
    attachment: "",
    note: "",
  });

  useEffect(() => {
    if (evidence && opened) {
      setForm({
        title: evidence.title,
        source: evidence.source,
        strength: evidence.strength,
        occurredAt: toLocalInput(evidence.occurredAt),
        attachment: evidence.attachment,
        note: evidence.note,
      });
    }
  }, [evidence, opened]);

  if (!evidence) {
    return null;
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`证据补版 · ${evidence.title}`}
      size="lg"
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          证据编号保持不变，提交后生成 V{evidence.version + 1}；引用旧版本的草稿与待复核结论将失效重算，已通过版本保留提交快照。
        </Text>
        <Table.ScrollContainer minWidth={480}>
          <Table horizontalSpacing="sm" verticalSpacing={4}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>版本</Table.Th>
                <Table.Th>附件</Table.Th>
                <Table.Th>提交</Table.Th>
                <Table.Th>状态</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {evidence.versions.map((version) => (
                <Table.Tr key={version.version}>
                  <Table.Td>
                    <Badge
                      size="sm"
                      variant={version.version === evidence.version ? "light" : "outline"}
                      color={version.version === evidence.version ? "teal" : "gray"}
                    >
                      V{version.version}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {version.attachment}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {version.submittedBy} ·{" "}
                      {new Date(version.submittedAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {version.supersededAt ? (
                      <Badge size="xs" color="gray">
                        已被取代
                      </Badge>
                    ) : (
                      <EvidenceStrengthBadge value={version.strength} />
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="证据名称"
            required
            value={form.title}
            onChange={(event) =>
              setForm((current) => ({ ...current, title: event.currentTarget.value }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={form.source}
            onChange={(event) =>
              setForm((current) => ({ ...current, source: event.currentTarget.value }))
            }
          />
          <Select
            label="证据强度"
            value={form.strength}
            onChange={(value) =>
              setForm((current) => ({
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
            required
            value={form.occurredAt}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="新版本附件标识"
            required
            value={form.attachment}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                attachment: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="版本说明"
          minRows={3}
          value={form.note}
          onChange={(event) =>
            setForm((current) => ({ ...current, note: event.currentTarget.value }))
          }
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            leftSection={<GitBranchPlus size={16} />}
            loading={submitting}
            onClick={() => onSubmit(form)}
          >
            提交 V{evidence.version + 1} 并失效重算
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
