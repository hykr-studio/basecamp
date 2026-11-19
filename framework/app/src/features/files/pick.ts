import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { PickedFile } from './hooks';

/** The bytes behind a picked asset: the browser's File, or the local file a phone gave. */
const blobOf = async (uri: string, file?: File | null): Promise<Blob> =>
  file ?? (await (await fetch(uri)).blob());

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/**
 * Photos from the library, or one from the camera. Photos are re-encoded at 0.8 quality, which
 * keeps them small on a phone's network. Nothing picked: an empty list.
 */
export async function pickPhotos(o: {
  camera?: boolean;
  multiple?: boolean;
  limit?: number;
}): Promise<PickedFile[]> {
  if (o.camera) {
    const allowed = await ImagePicker.requestCameraPermissionsAsync();
    if (!allowed.granted) throw new Error('The camera is not allowed for this app');
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 0.8,
    ...(o.multiple && !o.camera
      ? { allowsMultipleSelection: true, selectionLimit: o.limit ?? 0 }
      : {}),
  };
  const result = o.camera
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map(async (a) => ({
      body: await blobOf(a.uri, a.file),
      name: a.fileName ?? `photo-${stamp()}.jpg`,
      mime: a.mimeType ?? 'image/jpeg',
    })),
  );
}

/** Documents (any type the field takes). Nothing picked: an empty list. */
export async function pickDocuments(o: {
  types?: readonly string[];
  multiple?: boolean;
}): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: o.types?.length ? [...o.types] : '*/*',
    multiple: o.multiple ?? false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map(async (a) => ({
      body: await blobOf(a.uri, a.file),
      name: a.name,
      mime: a.mimeType ?? 'application/octet-stream',
    })),
  );
}
