import type { WriteResult } from '@hykr/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { applyCanvasIntent } from '../canvas/store';
import { touchedBy } from '../chat/touched';
import {
  type EntityName,
  errorMessage,
  specs,
  writeCommand,
  writeEntity,
} from '../framework/hooks';
import { useT } from '../framework/lang';
import { useToast } from '../framework/Toast';
import { isQueued, type QueuedWrite } from '../framework/write-queue';
import { getCatalog, getRegistry } from '../runtime';

/**
 * act(name, item) for a view: runs the action the view declared, through the framework.
 * An entity action or command goes to the API as the person (so approvals, rules and the
 * audit trail apply, with actor_kind = user); a screen opens in the canvas. Views contain
 * no fetch code of their own.
 */
export function useAct(viewName: string) {
  const client = useQueryClient();
  const toast = useToast();
  const { t } = useT();
  const view = getRegistry().getViewDef(viewName);

  return async (name: string, item: unknown) => {
    const action = view?.actions[name];
    if (!action) return;
    if ('screen' in action) {
      applyCanvasIntent({
        kind: 'open',
        screen: action.screen,
        params: action.params(item as never),
      });
      return;
    }
    const args = action.args(item as never);
    const [entity, verb] = action.command.split('.');
    const all = specs();
    const plural = (Object.keys(all) as EntityName[]).find((n) => all[n].name === entity);
    // An entity write or a command, through the outbox when its module marks it `offline`.
    let result: WriteResult<unknown> | QueuedWrite | undefined;
    try {
      if (plural && verb === 'update') {
        const { id, ...patch } = args;
        result = await writeEntity(client, plural, 'update', { id: String(id), input: patch });
      } else if (plural && verb === 'delete') {
        result = await writeEntity(client, plural, 'delete', { id: String(args.id) });
      } else if (plural && verb === 'create') {
        result = await writeEntity(client, plural, 'create', { input: args });
      } else {
        const spec = getCatalog().commandByName(action.command);
        if (!spec) throw new Error(`No command called ${action.command}`);
        result = await writeCommand(spec, args as never);
      }
      if (isQueued(result)) toast.show({ message: t('offline.queued') });
      else if (result.status === 'needs_approval')
        // Who decides it: them, or someone else (a capability's holders, a named person).
        toast.show({
          message: t(result.approval.canDecide === false ? 'said.cardTeam' : 'said.cardWaiting', {
            summary: result.approval.summary ?? t('said.aChange'),
          }),
        });
    } catch (e) {
      toast.show({ tone: 'error', message: errorMessage(e) });
    } finally {
      // Every view of this data reads the same cache: the entity's own screen updates too. A
      // write kept on the device refreshes nothing yet (the outbox does once it syncs).
      if (!isQueued(result)) {
        const spec = plural ? undefined : getCatalog().commandByName(action.command);
        const names = plural ? [plural] : spec?.tool ? touchedBy(spec.tool) : Object.keys(all);
        await Promise.all(
          [...names, 'approvals', 'history'].map((n) =>
            client.invalidateQueries({ queryKey: [n] }),
          ),
        );
      }
    }
  };
}
