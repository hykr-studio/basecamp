import { DEFAULT_MAX_FILES, fileIdsIn } from '@hykr/contracts';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { errorMessage } from '../../framework/hooks';
import { space, styles } from '../../theme';
import { FileThumbs } from './FileThumbs';
import { fileFieldPolicy, type PickedFile, useFileUpload } from './hooks';
import { pickDocuments, pickPhotos } from './pick';

type Props = {
  label: string;
  /** The entity (its name, 'note') and its file field, as the spec's `files` trait names it. */
  entity: string;
  field: string;
  /** The record, when it exists: the upload is checked against it. */
  recordId?: string;
  /** The field's value: one file id (or null), or a list for a list field. */
  value: string | readonly string[] | null | undefined;
  onChange: (next: string | string[] | null) => void;
  /** A list field (`fileRefs()`). Default: a list when `value` is one. */
  multiple?: boolean;
  hint?: string;
};

/**
 * A record's file field in a form: its files (thumbnails for images), and buttons to add from
 * the photo library, the camera (on a phone) or the file picker, as the field's `accept` allows.
 * Each pick is uploaded at once; the record keeps the new ids when the form is saved, in the
 * same write as its other fields.
 */
export function FileField({
  label,
  entity,
  field,
  recordId,
  value,
  onChange,
  multiple = Array.isArray(value),
  hint,
}: Props) {
  const policy = fileFieldPolicy(entity, field) ?? {};
  const ids = fileIdsIn(value);
  const max = multiple ? (policy.max ?? DEFAULT_MAX_FILES) : 1;
  const room = Math.max(0, max - ids.length);
  const accept = policy.accept ?? [];
  const images = !accept.length || accept.some((a) => a.startsWith('image/') || a === '*/*');
  const others = !accept.length || accept.some((a) => !a.startsWith('image/'));
  const upload = useFileUpload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (pick: () => Promise<PickedFile[]>) => {
    setError(null);
    setBusy(true);
    try {
      const picked = (await pick()).slice(0, multiple ? room : 1);
      const added: string[] = [];
      for (const file of picked) {
        const done = await upload.mutateAsync({
          file,
          for: { entity, field, ...(recordId ? { id: recordId } : {}) },
        });
        added.push(done.id);
      }
      if (added.length) onChange(multiple ? [...ids, ...added] : added[0]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = (id: string) => onChange(multiple ? ids.filter((x) => x !== id) : null);

  const full = multiple ? room === 0 : false;
  return (
    <View style={{ gap: space.xs }}>
      <Text style={styles.label}>{label}</Text>
      <FileThumbs ids={ids} onRemove={remove} max={max} />
      {full ? null : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {images ? (
            <Button
              title={multiple ? 'Add photos' : 'Choose a photo'}
              icon="image"
              variant="secondary"
              busy={busy}
              onPress={() => add(() => pickPhotos({ multiple, limit: room }))}
            />
          ) : null}
          {images && Platform.OS !== 'web' ? (
            <Button
              title="Take a photo"
              icon="camera"
              variant="secondary"
              busy={busy}
              onPress={() => add(() => pickPhotos({ camera: true }))}
            />
          ) : null}
          {others ? (
            <Button
              title={multiple ? 'Add files' : 'Choose a file'}
              icon="paperclip"
              variant="secondary"
              busy={busy}
              onPress={() =>
                add(() =>
                  pickDocuments({
                    types: accept.filter((a) => !a.startsWith('image/')),
                    multiple,
                  }),
                )
              }
            />
          ) : null}
        </View>
      )}
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.muted}>{hint}</Text>
      ) : null}
    </View>
  );
}
