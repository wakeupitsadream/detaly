// server/uploads.ts: bounded multipart reading with photo re-encoding (decisions С18, С19).
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DOWNSCALE_MAX_SIDE, downscaleImage, fitWithin, jpegName } from '@/lib/downscale';
import {
  readPhotoForm,
  UploadError,
  uploadErrorMessage,
  uploadErrorStatus,
  type PhotoFormLimits,
} from '@/server/uploads';

const MB = 1024 * 1024;
const LIMITS: PhotoFormLimits = { maxFiles: 3, maxFileBytes: 8 * MB };

async function jpegWithExif(): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#cc3333' },
  })
    .withExifMerge({ IFD0: { Model: 'Secret Phone 15' } })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

function formRequest(form: FormData): Request {
  return new Request('http://localhost:3000/api/vin', { method: 'POST', body: form });
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof UploadError ? error.reason : String(error);
  }
}

describe('readPhotoForm', () => {
  it('returns the text fields and photos re-encoded without metadata', async () => {
    const form = new FormData();
    form.set('vin', 'XTA21099012345678');
    form.set('need', 'Колодки передние');
    form.append('photos', new Blob([await jpegWithExif()], { type: 'image/jpeg' }), 'a.jpg');
    form.append('photos', new Blob([await jpegWithExif()], { type: 'image/jpeg' }), 'b.jpg');
    const result = await readPhotoForm(formRequest(form), LIMITS);
    expect(result.fields.get('vin')).toBe('XTA21099012345678');
    expect(result.fields.get('need')).toBe('Колодки передние');
    expect(result.photos).toHaveLength(2);
    for (const photo of result.photos) {
      const meta = await sharp(photo).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(Buffer.from(photo).includes('Secret Phone 15')).toBe(false);
    }
  });

  it('accepts a form without photos and an empty file input', async () => {
    const form = new FormData();
    form.set('need', 'фильтр');
    form.append('photos', new Blob([]), '');
    const result = await readPhotoForm(formRequest(form), LIMITS);
    expect(result.photos).toEqual([]);
    expect([...result.fields.keys()]).toEqual(['need']);
    const urlencoded = new Request('http://localhost:3000/api/vin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'need=%D1%84%D0%B8%D0%BB%D1%8C%D1%82%D1%80',
    });
    expect((await readPhotoForm(urlencoded, LIMITS)).fields.get('need')).toBe('фильтр');
  });

  it('refuses more photos than allowed, and any photo when storage is off', async () => {
    const form = new FormData();
    for (let i = 0; i < 4; i += 1) {
      form.append('photos', new Blob([await jpegWithExif()], { type: 'image/jpeg' }), `${i}.jpg`);
    }
    expect(await reason(readPhotoForm(formRequest(form), LIMITS))).toBe('too_many');
    const one = new FormData();
    one.append('photos', new Blob([await jpegWithExif()]), 'a.jpg');
    expect(await reason(readPhotoForm(formRequest(one), { ...LIMITS, maxFiles: 0 }))).toBe(
      'too_many',
    );
  });

  it('refuses a big photo and a big body before parsing', async () => {
    const photo = await jpegWithExif();
    const form = new FormData();
    form.append('photos', new Blob([photo]), 'a.jpg');
    expect(
      await reason(readPhotoForm(formRequest(form), { ...LIMITS, maxFileBytes: photo.length - 1 })),
    ).toBe('too_large');
    const declared = new Request('http://localhost:3000/api/vin', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '99999999' },
      body: 'x',
    });
    expect(await reason(readPhotoForm(declared, LIMITS))).toBe('too_large');
    const streamed = new FormData();
    streamed.append('photos', new Blob([new Uint8Array(2048)]), 'a.jpg');
    expect(
      await reason(readPhotoForm(formRequest(streamed), { ...LIMITS, maxTotalBytes: 1024 })),
    ).toBe('too_large');
  });

  it('refuses text files, foreign file fields, other content types and broken bodies', async () => {
    const text = new FormData();
    text.append('photos', new Blob(['не фото'], { type: 'image/jpeg' }), 'a.jpg');
    expect(await reason(readPhotoForm(formRequest(text), LIMITS))).toBe('not_image');
    const foreign = new FormData();
    foreign.append('avatar', new Blob([await jpegWithExif()]), 'a.jpg');
    expect(await reason(readPhotoForm(formRequest(foreign), LIMITS))).toBe('bad_form');
    const json = new Request('http://localhost:3000/api/vin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(await reason(readPhotoForm(json, LIMITS))).toBe('bad_form');
    const broken = new Request('http://localhost:3000/api/vin', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=zzz' },
      body: '--nope\r\nbroken',
    });
    expect(await reason(readPhotoForm(broken, LIMITS))).toBe('bad_form');
    const long = new FormData();
    long.set('need', 'а'.repeat(10_001));
    expect(await reason(readPhotoForm(formRequest(long), LIMITS))).toBe('bad_form');
  });
});

describe('upload error answers', () => {
  it('maps reasons to statuses and Russian messages without field values', () => {
    expect(uploadErrorStatus('too_large')).toBe(413);
    expect(uploadErrorStatus('too_many')).toBe(413);
    expect(uploadErrorStatus('not_image')).toBe(422);
    expect(uploadErrorStatus('bad_form')).toBe(400);
    expect(uploadErrorMessage('too_large', { maxFiles: 3, maxFileMb: 8 })).toBe(
      'Фото слишком большие — до 8 МБ каждое',
    );
    expect(uploadErrorMessage('too_many', { maxFiles: 3, maxFileMb: 8 })).toBe('Не больше 3 фото');
    expect(uploadErrorMessage('too_many', { maxFiles: 0, maxFileMb: 8 })).toMatch(/без них/);
  });
});

describe('lib/downscale (browser side)', () => {
  it('fits into 1600 px keeping the ratio and never enlarges', () => {
    expect(DOWNSCALE_MAX_SIDE).toBe(1600);
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 3)).toEqual({ width: 1600, height: 1 });
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
  });

  it('names the result .jpg', () => {
    expect(jpegName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(jpegName('photo')).toBe('photo.jpg');
    expect(jpegName('.png')).toBe('photo.jpg');
  });

  it('sends the original when there is no canvas (server side, old browsers)', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' });
    expect(await downscaleImage(file)).toBe(file);
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(await downscaleImage(text)).toBe(text);
  });
});
