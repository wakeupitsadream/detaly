// Site icons from src/app/icon.svg (the letter «Д» drawn as a path, no font): favicon.ico with
// 16 and 32 px PNG images (Yandex takes the .ico most reliably) and apple-icon.png 180 px.
// Run once after changing icon.svg: node apps/web/scripts/gen-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const app = fileURLToPath(new URL('../src/app/', import.meta.url));
const svg = readFileSync(`${app}icon.svg`);

const png = (size, density = 72 * (size / 32) * 4) =>
  sharp(svg, { density }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** An ICO container of PNG images (Windows Vista+ and every browser read PNG inside ICO). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const images = [];
for (const size of [16, 32]) images.push({ size, data: await png(size) });
writeFileSync(`${app}favicon.ico`, ico(images));
// The touch icon: a full square (iOS rounds the corners itself), the letter on the brand red.
const square = Buffer.from(svg.toString('utf8').replace('rx="7" ', ''));
writeFileSync(
  `${app}apple-icon.png`,
  await sharp(square, { density: 72 * (180 / 32) * 2 })
    .resize(180, 180)
    .png()
    .toBuffer(),
);
console.log('[gen-icons] wrote favicon.ico, apple-icon.png');
