/**
 * QR of the payment at the pickup point (decision Б28): the seller's screen shows it, the
 * client scans it. Rendered as an SVG data URI (CSP img-src allows data:), never sent to the
 * client by any channel.
 */
import QRCode from 'qrcode';

export async function qrSvgDataUri(data: string): Promise<string> {
  const svg = await QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * The QR as an SVG document (step 3, docs/reviews.md): the counter sign and the «Скачать QR
 * (SVG)» file for the paper return memo. Error correction Q, so a scuffed sign still scans. The
 * file keeps the full quiet zone of 4 modules (it goes into another layout); the sign draws its
 * own white margin around the code and asks for 1.
 */
export async function qrSvg(
  data: string,
  { margin = 4 }: { margin?: number } = {},
): Promise<string> {
  return QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'Q', margin });
}

/** qrSvg as a data URI for <img> (CSP img-src allows data:). */
export async function qrSvgPrintDataUri(
  data: string,
  options?: { margin?: number },
): Promise<string> {
  const svg = await qrSvg(data, options);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
