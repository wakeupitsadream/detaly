// Every uploaded photo is re-encoded before it is stored (decision С18): rotated by its EXIF
// orientation, fitted into maxSide, saved as JPEG q82 WITHOUT metadata (GPS coordinates, phone
// model, owner name in EXIF/XMP/IPTC are personal data we do not need). `sharp` is imported
// lazily inside the function, so the demo build and pages that never upload never load it.
import { ImageRejectedError } from './types';

/** Decoded formats we accept: no SVG (scripts, external references) and no PDF. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'gif', 'tiff']);

export const DEFAULT_MAX_SIDE = 2000;
/** 40 megapixels: bigger photos are refused before decoding (decompression bombs). */
export const DEFAULT_MAX_PIXELS = 40_000_000;
export const JPEG_QUALITY = 82;

export interface IngestOptions {
  /** Upload size limit in bytes (FILES_MAX_UPLOAD_MB x 1 MiB). */
  maxBytes: number;
  /** The longer side of the stored image, px (default 2000). */
  maxSide?: number;
  /** Pixel limit of the input (default 40 MP). */
  maxPixels?: number;
}

export interface IngestedImage {
  bytes: Uint8Array;
  contentType: 'image/jpeg';
  width: number;
  height: number;
}

/**
 * Validates and re-encodes an uploaded image. Throws ImageRejectedError: `too_large` (more than
 * maxBytes), `not_image` (not a decodable image of an accepted format, e.g. a text file, SVG,
 * HEIC that libvips cannot read — the browser-side downscale turns those into JPEG first),
 * `too_many_pixels` (more than maxPixels).
 */
export async function ingestImage(
  input: Uint8Array,
  options: IngestOptions,
): Promise<IngestedImage> {
  const maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (input.byteLength === 0) throw new ImageRejectedError('not_image');
  if (input.byteLength > options.maxBytes) throw new ImageRejectedError('too_large');

  const { default: sharp } = await import('sharp');
  // limitInputPixels: false here, checked below against the header, so the reason is precise.
  const constructorOptions = { failOn: 'error' as const, limitInputPixels: false as const };
  let width: number;
  let height: number;
  try {
    const meta = await sharp(input, constructorOptions).metadata();
    if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
      throw new ImageRejectedError('not_image');
    }
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch (error) {
    if (error instanceof ImageRejectedError) throw error;
    throw new ImageRejectedError('not_image');
  }
  if (width <= 0 || height <= 0) throw new ImageRejectedError('not_image');
  if (width * height > maxPixels) throw new ImageRejectedError('too_many_pixels');

  try {
    const { data, info } = await sharp(input, {
      ...constructorOptions,
      limitInputPixels: maxPixels,
    })
      .autoOrient()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      // No keepMetadata()/withMetadata(): sharp drops EXIF, XMP, IPTC and ICC by default.
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      contentType: 'image/jpeg',
      width: info.width,
      height: info.height,
    };
  } catch {
    // A header that parses but pixel data that does not (a truncated file).
    throw new ImageRejectedError('not_image');
  }
}
