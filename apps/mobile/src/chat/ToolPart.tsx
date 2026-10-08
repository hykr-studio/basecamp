import type { Present } from '@app/contracts';
import { registry } from '@app/ui-registry';
import type { ToolCallMessagePartProps } from '@assistant-ui/react-native';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { applyCanvasIntent, useCanvas } from '../canvas/store';
import { useApprovalStatus } from '../framework/ApprovalCard';
import { Icon, type IconName } from '../framework/Icon';
import { colors } from '../theme';
import { InlineView } from '../views/InlineView';
import { toolWords } from './toolWords';

/** What every tool returns (packages/core/src/tools/tool-factory.ts). */
export type ToolOutput = {
  ok: boolean;
  result?: { status?: string; approval?: { id: string; summary: string | null } };
  error?: { reason?: string; message?: unknown } | null;
  present?: Present;
};

/**
 * One tool call, in people's words first ("Asked to delete a to-do"), with the tool id after
 * it as quiet metadata, so a developer can still see exactly what ran.
 */
function Line({
  icon,
  tone,
  tool,
  label,
}: {
  icon: IconName;
  tone: string;
  tool: string;
  label: string;
}) {
  return (
    <View className="flex-row items-start gap-1.5">
      <View className="pt-0.5">
        <Icon name={icon} color={tone} size={14} />
      </View>
      <Text variant="muted" className="shrink" style={{ color: tone }}>
        {label}
        {/* The id, for developers: lighter than the words, and never the lead. */}
        <Text variant="muted" style={{ color: colors.placeholder }}>
          {' · '}
          {tool}
        </Text>
      </Text>
    </View>
  );
}

/**
 * A parked call, followed: once the person decides, the line says what became of it. When
 * its card follows in the thread, the card carries the state and this line only says what
 * was asked.
 */
function ParkedLine({
  tool,
  approvalId,
  withCard,
}: {
  tool: string;
  approvalId: string;
  withCard: boolean;
}) {
  const { status } = useApprovalStatus(approvalId);
  const asked = toolWords(tool).asked;
  if (withCard) return <Line icon="clock" tone={colors.approvalText} tool={tool} label={asked} />;
  const [icon, tone, state]: [IconName, string, string] =
    status === 'approved'
      ? ['check-circle', colors.success, 'approved by you']
      : status === 'rejected'
        ? ['slash', colors.muted, 'rejected by you; nothing changed']
        : status === 'failed'
          ? ['x-circle', colors.danger, "approved, but it couldn't be done"]
          : status === 'expired'
            ? ['clock', colors.muted, 'expired; nothing changed']
            : ['clock', colors.approvalText, 'waiting for your approval'];
  return <Line icon={icon} tone={tone} tool={tool} label={`${asked}: ${state}`} />;
}

/** What a canvas intent did, in the thread; tapping it brings the canvas back. */
function CanvasChip({ present, toolCallId }: { present: Present; toolCallId: string }) {
  // Applied once, when the result arrives; history loaded from this device never reopens.
  useEffect(() => applyCanvasIntent(present, toolCallId), [present, toolCallId]);
  const label =
    present.kind === 'open'
      ? `Opened the ${registry.getScreenDef(present.screen)?.title ?? present.screen}`
      : present.kind === 'page'
        ? `Opened “${present.page.title}”`
        : 'Updated the page';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Show it`}
      onPress={() =>
        present.kind === 'patch' ? useCanvas.getState().reopen() : applyCanvasIntent(present)
      }
      className="min-h-11 flex-row items-center gap-2 self-start rounded-control border border-assistant-border bg-card px-3 web:hover:bg-bg"
    >
      <Icon name="layout" color={colors.assistant} size={16} />
      <Text className="font-semibold text-assistant">{label}</Text>
      <Icon name="chevron-right" color={colors.muted} size={16} />
    </Pressable>
  );
}

/** What a result shows: a registered view in the thread, or a chip for the canvas. */
function Shown({ present, toolCallId }: { present: Present; toolCallId: string }) {
  if (present.kind === 'inline')
    return <InlineView view={present.view} query={present.query} props={present.props} />;
  if (present.kind === 'text') return null; // words are for channels without a screen
  return <CanvasChip present={present} toolCallId={toolCallId} />;
}

/**
 * Every tool call in the thread renders here (assistant-ui's Fallback): a line saying what
 * it amounted to. What a result shows (a view, the canvas) is added by the present intent.
 */
export function ToolPart(props: ToolCallMessagePartProps) {
  const out = props.result as ToolOutput | undefined;
  return (
    <View className="gap-2">
      <ToolLine {...props} />
      {props.status.type !== 'running' && out?.ok && out.present ? (
        <Shown present={out.present} toolCallId={props.toolCallId} />
      ) : null}
    </View>
  );
}

function ToolLine({ toolName, result, status }: ToolCallMessagePartProps) {
  const said = toolWords(toolName);
  if (status.type === 'running') {
    return (
      <View className="flex-row items-center gap-1.5">
        <ActivityIndicator size="small" color={colors.assistant} />
        <Text variant="muted">{said.doing}</Text>
      </View>
    );
  }
  const out = result as ToolOutput | undefined;
  if (!out) return null;
  if (!out.ok) {
    const reason = out.error?.reason ?? out.error?.message;
    return (
      <Line
        icon="x-circle"
        tone={colors.danger}
        tool={toolName}
        label={`${said.refused}${typeof reason === 'string' ? `: ${reason}` : ''}`}
      />
    );
  }
  if (out.result?.status === 'needs_approval' && out.result.approval) {
    return (
      <ParkedLine
        tool={toolName}
        approvalId={out.result.approval.id}
        withCard={out.present?.kind === 'inline'}
      />
    );
  }
  return <Line icon="check" tone={colors.muted} tool={toolName} label={said.did} />;
}
