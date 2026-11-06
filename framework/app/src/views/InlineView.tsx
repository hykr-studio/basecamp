import type { ViewQuery } from '@hykr/contracts';
import type { ViewDef } from '@hykr/ui-registry';
import { getView, wordsOf } from '@hykr/ui-registry/react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from '../components/ui/text';
import {
  type EntityName,
  errorMessage,
  useEntity,
  useEntityList,
  useEntitySummary,
} from '../framework/hooks';
import { useLang } from '../framework/lang';
import { getRegistry } from '../runtime';
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
  const words = wordsOf(def, useLang().lang);
  if (list.loading || list.error) return <Status loading={list.loading} error={list.error} />;
  return Component ? (
    <Component {...props} {...{ [source.into]: list.items }} act={act} words={words} />
  ) : null;
}

/** Counts and totals: the entity's summary for the view's query, with the person's session. */
function BySummary({ def, query, props }: { def: ViewDef; query?: ViewQuery; props?: object }) {
  const source = def.source as NonNullable<ViewDef['source']>;
  const summary = useEntitySummary(source.entity.plural, query ?? {});
  const Component = getView(def.name);
  const act = useAct(def.name);
  const words = wordsOf(def, useLang().lang);
  if (!summary.data) return <Status loading={summary.isLoading} error={summary.error} />;
  return Component ? (
    <Component {...props} {...{ [source.into]: summary.data }} act={act} words={words} />
  ) : null;
}

/** One record by id. */
function ById({ def, props }: { def: ViewDef; props?: Record<string, unknown> }) {
  const source = def.source as NonNullable<ViewDef['source']>;
  const one = useEntity(source.entity.plural as EntityName, props?.id as string | undefined);
  const Component = getView(def.name);
  const act = useAct(def.name);
  const words = wordsOf(def, useLang().lang);
  if (!one.data) return <Status loading={one.isLoading} error={one.error} />;
  return Component ? (
    <Component {...props} {...{ [source.into]: one.data }} act={act} words={words} />
  ) : null;
}

/** Props only (approval.card, kpi.row): the intent carried everything, or the view fetches. */
function ByProps({ def, props }: { def: ViewDef; props?: object }) {
  const Component = getView(def.name);
  const act = useAct(def.name);
  const words = wordsOf(def, useLang().lang);
  return Component ? <Component {...props} act={act} words={words} /> : null;
}

/**
 * A registered view, rendered from an intent. The data is fetched here, live, through the
 * same query cache as the rest of the app: tick an item in the chat and its own screen
 * shows it too. The server already checked the view, its query and its props.
 */
export function InlineView({ view, query, props }: Props) {
  const def = getRegistry().getViewDef(view);
  if (!def || !getView(view)) return null;
  if (def.source?.by === 'query') return <ByQuery def={def} query={query} props={props} />;
  if (def.source?.by === 'id') return <ById def={def} props={props} />;
  if (def.source?.by === 'summary') return <BySummary def={def} query={query} props={props} />;
  return <ByProps def={def} props={props} />;
}
