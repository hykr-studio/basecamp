import type { DocumentInfo, DocumentKindInfo } from '@hykr/contracts';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { SectionHeading } from '../../components/ScreenTitle';
import { errorMessage } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import { useDocumentKinds, useDocuments, useRenderDocument, useSendDocument } from './hooks';

/** Open a document: a fresh URL each time (they are short-lived). */
async function open(id: string) {
  const fresh = await api.documents.get(id);
  if (fresh.url) await Linking.openURL(fresh.url);
}

function DocumentRow({ doc, kind }: { doc: DocumentInfo; kind?: DocumentKindInfo }) {
  const { t } = useT();
  const toast = useToast();
  const send = useSendDocument();
  const ready = doc.status === 'ready';
  const state =
    doc.status === 'pending'
      ? t('document.making')
      : doc.status === 'failed'
        ? t('document.failed')
        : t('document.pages', { pages: doc.pages ?? 1 });
  return (
    <View style={s.row}>
      <Icon name="file-text" color={doc.status === 'failed' ? colors.danger : colors.muted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text} numberOfLines={1}>
          {doc.name}
        </Text>
        <Text style={styles.muted}>
          {t('document.version', { version: doc.version })} · {doc.lang} · {state}
        </Text>
      </View>
      {doc.status === 'pending' && <ActivityIndicator color={colors.muted} />}
      {ready && (
        <Button
          title={t('document.open', { name: doc.name })}
          icon="external-link"
          iconOnly
          variant="ghost"
          onPress={() =>
            void open(doc.id).catch((e) => toast.show({ message: errorMessage(e), tone: 'error' }))
          }
        />
      )}
      {doc.status !== 'failed' && (kind?.channels.length ?? 0) > 0 && (
        <Button
          title={t('document.sendToMe')}
          icon="send"
          iconOnly
          variant="ghost"
          busy={send.isPending}
          onPress={() =>
            send.mutate(
              { documentId: doc.id, to: { self: true } },
              {
                onSuccess: () => toast.show({ message: t('document.sentToYou'), tone: 'success' }),
                onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
              },
            )
          }
        />
      )}
    </View>
  );
}

/**
 * A record's documents: a button to make each kind its module declares, and every version the
 * person may open (each made in the background, then opened with a fresh link or sent to them).
 * Nothing shows for an entity without documents.
 */
export function RecordDocuments({ entity, id }: { entity: string; id: string }) {
  const { t, lang, pick } = useT();
  const kinds = useDocumentKinds(entity);
  const docs = useDocuments(entity, id);
  const render = useRenderDocument();
  if (!kinds.data?.length) return null;
  const byName = new Map(kinds.data.map((k) => [k.name, k]));
  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{t('document.heading')}</SectionHeading>
      <View style={[styles.row, { flexWrap: 'wrap', gap: space.sm }]}>
        {kinds.data.map((k) => (
          <Button
            key={k.name}
            title={t('document.make', { label: pick(k.label) })}
            icon="file-plus"
            variant="secondary"
            busy={render.isPending && render.variables?.document === k.name}
            onPress={() => render.mutate({ document: k.name, id, lang })}
          />
        ))}
      </View>
      {render.error && <Text style={styles.error}>{errorMessage(render.error)}</Text>}
      {docs.data?.length ? (
        docs.data.map((d) => <DocumentRow key={d.id} doc={d} kind={byName.get(d.document)} />)
      ) : (
        <Text style={styles.muted}>{t('document.none')}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
});
