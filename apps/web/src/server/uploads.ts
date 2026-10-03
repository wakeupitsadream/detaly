/**
 * Forms with photos (VIN request, claim, admin uploads; docs/phase-1c-implementation.md
 * decisions С18 and С19). The body is read as a bounded stream (a declared Content-Length over
 * the limit is refused before reading), parsed as multipart/form-data, and every photo goes
 * through ingestImage: re-encoded JPEG without metadata. Nothing here is logged: the fields
 * carry personal data.
 *
 *   const form = await readPhotoForm(request, { maxFiles: 3, maxFileBytes, maxTotalBytes });
 *   form.fields.get('vin'); form.photos[0] // JPEG bytes ready for FileStore.put
 */
import { ImageRejectedError, ingestImage } from '@detaly/files';

/** Total body of a photo form: three photos of up to 8 MB downscaled on the client fit easily. */
export const PHOTO_FORM_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/** One text field: longer values are not a human typing into our forms. */
export const PHOTO_FORM_MAX_FIELD_CHARS = 10_000;

export type UploadErrorReason = 'too_large' | 'too_many' | 'not_image' | 'bad_form';

export class UploadError extends Error {
  readonly reason: UploadErrorReason;

  constructor(reason: UploadErrorReason) {
    super(`upload rejected: ${reason}`);
    this.name = 'UploadError';
    this.reason = reason;
  }
}

export interface PhotoFormLimits {
  /** Photos accepted (0 when photo storage is off: any photo is then `too_many`). */
  maxFiles: number;
  /** One photo, bytes (FILES_MAX_UPLOAD_MB). */
  maxFileBytes: number;
  /** The whole body, bytes (default PHOTO_FORM_MAX_TOTAL_BYTES). */
  maxTotalBytes?: number;
  /** Form field of the photos (default 'photos'); a file in any other field is `bad_form`. */
  photoField?: string;
  /** Longest side of a stored photo (ingestImage default 2000 px). */
  maxSide?: number;
}

export interface PhotoForm {
  /** Text fields; the first value of a repeated name wins. */
  fields: Map<string, string>;
  /** Re-encoded JPEGs, in form order. */
  photos: Uint8Array[];
}

async function readBoundedBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new UploadError('too_large');
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UploadError('too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** FormData entry type without the DOM lib (the worker typechecks this file through its flow harness). */
type FormEntry = ReturnType<FormData['get']> & {};

function isFileEntry(value: FormEntry): value is Exclude<FormEntry, string> {
  return typeof value !== 'string';
}

/**
 * Reads a photo form (multipart/form-data, or urlencoded without photos). Throws UploadError:
 * `too_large` (the body, or one photo over its limit), `too_many` (more photos than maxFiles),
 * `not_image` (a file that is not an accepted image), `bad_form` (another content type, an
 * unparsable body, a file outside the photo field, an overlong text field).
 */
export async function readPhotoForm(request: Request, limits: PhotoFormLimits): Promise<PhotoForm> {
  const maxTotalBytes = limits.maxTotalBytes ?? PHOTO_FORM_MAX_TOTAL_BYTES;
  const photoField = limits.photoField ?? 'photos';
  const contentType = request.headers.get('content-type') ?? '';
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== 'multipart/form-data' && type !== 'application/x-www-form-urlencoded') {
    throw new UploadError('bad_form');
  }
  const bytes = await readBoundedBytes(request, maxTotalBytes);

  let entries: [string, FormEntry][];
  try {
    const parsed = await new Response(bytes, {
      headers: { 'content-type': contentType },
    }).formData();
    entries = [...parsed.entries()];
  } catch {
    throw new UploadError('bad_form');
  }

  const fields = new Map<string, string>();
  const files: File[] = [];
  for (const [name, value] of entries) {
    if (isFileEntry(value)) {
      // An empty file input (nothing chosen) arrives as a nameless empty file.
      if (value.size === 0 && value.name === '') continue;
      if (name !== photoField) throw new UploadError('bad_form');
      files.push(value);
      continue;
    }
    if (name === photoField) {
      // An empty file input may also arrive as an empty text part (no filename).
      if (value === '') continue;
      throw new UploadError('bad_form');
    }
    if (value.length > PHOTO_FORM_MAX_FIELD_CHARS) throw new UploadError('bad_form');
    if (!fields.has(name)) fields.set(name, value);
  }
  if (files.length > limits.maxFiles) throw new UploadError('too_many');
  for (const file of files) {
    if (file.size > limits.maxFileBytes) throw new UploadError('too_large');
  }

  const photos: Uint8Array[] = [];
  for (const file of files) {
    try {
      const image = await ingestImage(new Uint8Array(await file.arrayBuffer()), {
        maxBytes: limits.maxFileBytes,
        maxSide: limits.maxSide,
      });
      photos.push(image.bytes);
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        throw new UploadError(error.reason === 'not_image' ? 'not_image' : 'too_large');
      }
      throw error;
    }
  }
  return { fields, photos };
}

/** HTTP status of a rejected upload. */
export function uploadErrorStatus(reason: UploadErrorReason): number {
  switch (reason) {
    case 'too_large':
    case 'too_many':
      return 413;
    case 'not_image':
      return 422;
    case 'bad_form':
      return 400;
  }
}

/** What the visitor reads (Russian, no field values). */
export function uploadErrorMessage(
  reason: UploadErrorReason,
  limits: { maxFiles: number; maxFileMb: number },
): string {
  switch (reason) {
    case 'too_large':
      return `Фото слишком большие — до ${limits.maxFileMb} МБ каждое`;
    case 'too_many':
      return limits.maxFiles > 0
        ? `Не больше ${limits.maxFiles} фото`
        : 'Сейчас фото не принимаем — отправьте форму без них';
    case 'not_image':
      return 'Файл не похож на фото — пришлите снимок JPEG или PNG';
    case 'bad_form':
      return 'Форма не прочиталась — обновите страницу и отправьте ещё раз';
  }
}
