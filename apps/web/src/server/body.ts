/**
 * Bounded request body reading for the write handlers (cart, checkout, cancel). Nothing in
 * front of web caps request bodies for route handlers, so `request.text()`, `json()` or
 * `formData()` would buffer whatever a client sends. The body is read as a stream and dropped
 * past `maxBytes`; a declared Content-Length above the limit is refused before reading.
 */

export type BoundedBody = { ok: true; text: string } | { ok: false; reason: 'too_large' };

export async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
  if (request.body === null) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/** JSON body within `maxBytes`, or undefined when it is missing, too large or not JSON. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  try {
    const body = await readBoundedText(request, maxBytes);
    if (!body.ok || body.text.trim() === '') return undefined;
    return JSON.parse(body.text) as unknown;
  } catch {
    return undefined;
  }
}
