import type { ViewQuery } from '@app/contracts';
import { registry, type ViewDef } from '@app/ui-registry';
import { getView } from '@app/ui-registry/react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { type EntityName, errorMessage, useEntity, useEntityList } from '../framework/hooks';
import { colors } from '../theme';
import { useAct } from './useAct';

type Props = { view: string; query?: ViewQuery; props?: Record<string, unknown> };

function Status({ loading, error }: { loading: boolean; error: unknown }) {
  if (loading)
    return (
      <View className="flex-row items-center gap-2 py-2">
        <ActivityIndicator size="small" color={colors.muted} />
        <Text variant="muted">Loading…</Text>
      </View>
    );
  return <Text variant="error">Couldn't load this: {errorMessage(error)}</Text>;
}

/** A list view: the same query, run by this client with the person's own session. */
function ByQuery({ def, query, props }: { def: ViewDef; query?: ViewQuery; props?: object }) {
  const source = def.source as NonNullable<ViewDef['source']>;
  const list = useEntityList(source.entity.plural as EntityName, query ?? {});
  const Component = getView(def.name);
  const act = useAct(def.name);
  if (list.loading || list.error) return <Status loading={list.loading} error={list.error} />;
  return Component ? <Component {...props} {...{ [source.into]: list.items }} act={act} /> : null;
}

/** One record by id. */
function ById({ def, props }: { def: ViewDef; props?: Record<string, unknown> }) {
  const source = def.source as NonNullable<ViewDef['source']>;
  const one = useEntity(source.entity.plural as EntityName, props?.id as string | undefined);
  const Component = getView(def.name);
  const act = useAct(def.name);
  if (!one.data) return <Status loading={one.isLoading} error={one.error} />;
  return Component ? <Component {...props} {...{ [source.into]: one.data }} act={act} /> : null;
}

/** Props only (kpi.row, approval.card): the intent carried everything. */
function ByProps({ def, props }: { def: ViewDef; props?: object }) {
  const Component = getView(def.name);
  const act = useAct(def.name);
  return Component ? <Component {...props} act={act} /> : null;
}

/**
 * A registered view, rendered from an intent. The data is fetched here, live, through the
 * same query cache as the rest of the app: tick a to-do in the chat and the To-dos screen
 * shows it too. The server already checked the view, its query and its props.
 */
export function InlineView({ view, query, props }: Props) {
  const def = registry.getViewDef(view);
  if (!def || !getView(view)) return null;
  if (def.source?.by === 'query') return <ByQuery def={def} query={query} props={props} />;
  if (def.source?.by === 'id') return <ById def={def} props={props} />;
  return <ByProps def={def} props={props} />;
}
