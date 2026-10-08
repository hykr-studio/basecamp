import { commands, entities } from '@app/contracts';

const pluralOf = (name: string) => Object.values(entities).find((s) => s.name === name)?.plural;

/**
 * Which cached lists a tool may have changed, so they refresh without a manual reload: a
 * command refreshes the entities it declares it touches; an entity write refreshes its own.
 */
export function touchedBy(tool: string): string[] {
  if (/^(list|get)-/.test(tool) || tool.startsWith('canvas-')) return [];
  const command = commands.find((c) => c.tool === tool);
  if (command)
    return (command.touches ?? Object.values(entities).map((s) => s.name)).flatMap(
      (name) => pluralOf(name) ?? [],
    );
  const entity = Object.values(entities).find((s) => tool.endsWith(`-${s.name}`));
  return entity ? [entity.plural] : [];
}

/** After a reply (typed or spoken): refresh every list its tool calls may have changed. */
export function refreshTouched(
  queryClient: { invalidateQueries: (q: { queryKey: string[] }) => unknown },
  parts: readonly { type: string }[],
) {
  const names = new Set<string>();
  for (const part of parts)
    if (part.type.startsWith('tool-')) for (const n of touchedBy(part.type.slice(5))) names.add(n);
  if (names.size > 0) names.add('approvals');
  for (const n of names) queryClient.invalidateQueries({ queryKey: [n] });
}
