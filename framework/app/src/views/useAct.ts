import type { WriteResult } from '@hykr/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { applyCanvasIntent } from '../canvas/store';
import { touchedBy } from '../chat/touched';
import { type EntityName, entityApi, errorMessage, specs } from '../framework/hooks';
import { useToast } from '../framework/Toast';
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
    try {
      let result: WriteResult<unknown>;
      if (plural && verb === 'update') {
        const { id, ...patch } = args;
        result = await entityApi(plural).update(String(id), patch as never);
      } else if (plural && verb === 'delete') {
        result = await entityApi(plural).remove(String(args.id));
      } else if (plural && verb === 'create') {
        result = await entityApi(plural).create(args as never);
      } else {
        const spec = getCatalog().commandByName(action.command);
        if (!spec) throw new Error(`No command called ${action.command}`);
        result = await api.command(spec, args as never);
      }
      if (result.status === 'needs_approval')
        toast.show({
          message: `Waiting for your approval: ${result.approval.summary ?? 'a change'}`,
        });
    } catch (e) {
      toast.show({ tone: 'error', message: errorMessage(e) });
    } finally {
      // Every view of this data reads the same cache: the entity's own screen updates too.
      const spec = plural ? undefined : getCatalog().commandByName(action.command);
      const names = plural ? [plural] : spec?.tool ? touchedBy(spec.tool) : Object.keys(all);
      await Promise.all(
        [...names, 'approvals', 'history'].map((n) => client.invalidateQueries({ queryKey: [n] })),
      );
    }
  };
}
