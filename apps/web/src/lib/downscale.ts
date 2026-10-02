/**
 * Browser-side photo downscale before upload (docs/phase-1c-implementation.md decision С19):
 * a 12-megapixel phone photo (4–8 MB) becomes a JPEG of at most 1600 px on the longer side,
 * quality 0.85 (~300–600 KB), so three photos fit the 12 MB form limit and a slow mobile
 * network. Re-encoding through a canvas also drops EXIF (GPS, phone model) before the photo
 * leaves the phone; the server re-encodes again anyway (@detaly/files ingestImage).
 *
 * Anything the browser cannot decode (HEIC outside Safari, a broken file) is sent as is, and
 * the server answers with a readable error.
 */

export const DOWNSCALE_MAX_SIDE = 1600;
export const DOWNSCALE_QUALITY = 0.85;

/** Size that fits into maxSide x maxSide keeping the ratio; never enlarges. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number = DOWNSCALE_MAX_SIDE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 'IMG_0042.HEIC' -> 'IMG_0042.jpg' */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '') || 'photo';
  return `${base}.jpg`;
}

/**
 * The photo as a downscaled JPEG File, or the original when the browser cannot decode it or has
 * no canvas support. Orientation from EXIF is applied by createImageBitmap.
 */
export async function downscaleImage(
  file: File,
  options: { maxSide?: number; quality?: number } = {},
): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  const maxSide = options.maxSide ?? DOWNSCALE_MAX_SIDE;
  const quality = options.quality ?? DOWNSCALE_QUALITY;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = fitWithin(bitmap.width, bitmap.height, maxSide);
    if (size.width === 0) return file;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context === null) return file;
    // JPEG has no transparency: paint white under PNG cut-outs.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (blob === null) return file;
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
