import { DEFAULT_MAX_FILES, type FileInfo } from '@hykr/contracts';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../../framework/Icon';
import { colors, space, styles } from '../../theme';
import { useFiles } from './hooks';

const THUMB = 72;

/** A raster image a browser and a phone can draw. */
const drawable = (f: FileInfo) =>
  /^image\/(jpeg|png|gif|webp)$/.test(f.mime) && typeof f.url === 'string';

const open = (f: FileInfo) => {
  if (f.url) void Linking.openURL(f.url);
};

/**
 * A record's files: images as thumbnails, other files by name. Each opens its file (a fresh,
 * short-lived URL). With `onRemove`, each has a remove button. Files the person cannot reach
 * (another business's, a hidden field's) never show.
 */
export function FileThumbs({
  ids,
  onRemove,
  max = DEFAULT_MAX_FILES,
}: {
  ids: readonly string[];
  onRemove?: (id: string) => void;
  max?: number;
}) {
  const files = useFiles(ids.slice(0, max));
  if (!ids.length) return null;
  if (files.isLoading) return <Text style={styles.muted}>Loading files…</Text>;
  const byId = new Map((files.data ?? []).map((f) => [f.id, f]));
  const shown = ids.flatMap((id) => byId.get(id) ?? []);
  return (
    <View style={s.row}>
      {shown.map((f) => (
        <View key={f.id} style={s.item}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open ${f.name}`}
            onPress={() => open(f)}
          >
            {drawable(f) ? (
              <Image source={{ uri: f.url }} style={s.thumb} accessibilityIgnoresInvertColors />
            ) : (
              <View style={[s.thumb, s.doc]}>
                <Icon
                  name={f.mime.startsWith('audio/') ? 'mic' : 'file-text'}
                  color={colors.muted}
                />
                <Text numberOfLines={2} style={s.name}>
                  {f.name}
                </Text>
              </View>
            )}
          </Pressable>
          {onRemove ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${f.name}`}
              onPress={() => onRemove(f.id)}
              style={s.remove}
              hitSlop={8}
            >
              <Icon name="x" size={14} color={colors.primaryText} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  item: { position: 'relative' },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  doc: { alignItems: 'center', justifyContent: 'center', padding: space.xs, gap: 2 },
  name: { fontSize: 11, color: colors.muted, textAlign: 'center' },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.inverseBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
