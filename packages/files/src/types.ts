/**
 * File storage of photos (docs/phase-1c-implementation.md decision С18): VIN request photos,
 * claim photos, packaging / handover / return photos. Every stored object is a JPEG produced
 * by ingestImage (EXIF and other metadata removed); keys follow FILE_KEY_PATTERN.
 */

export type FileStoreKind = 'none' | 'local' | 'memory' | 's3';

export interface FileObject {
  bytes: Uint8Array;
  /** Always 'image/jpeg' for objects written by this system. */
  contentType: string;
}

export interface FileStore {
  readonly kind: FileStoreKind;
  /** Stores (or overwrites) the object. Throws FileKeyError for a key outside the mask. */
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  /** The object, or null when it does not exist. */
  get(key: string): Promise<FileObject | null>;
  /** Deletes the object; a missing object is not an error (idempotent). */
  delete(key: string): Promise<void>;
}

/** FILES_STORAGE=none: photos are switched off (forms hide the photo field). */
export class FilesDisabledError extends Error {
  constructor() {
    super('file storage is disabled (FILES_STORAGE=none)');
    this.name = 'FilesDisabledError';
  }
}

/** A key outside FILE_KEY_PATTERN (never echoes the key: it may come from a request). */
export class FileKeyError extends Error {
  constructor() {
    super('invalid file key');
    this.name = 'FileKeyError';
  }
}

export type ImageRejectReason = 'not_image' | 'too_large' | 'too_many_pixels';

/** An upload that is not an accepted image or exceeds the limits. */
export class ImageRejectedError extends Error {
  readonly reason: ImageRejectReason;

  constructor(reason: ImageRejectReason) {
    super(`image rejected: ${reason}`);
    this.name = 'ImageRejectedError';
    this.reason = reason;
  }
}
