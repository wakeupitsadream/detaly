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
