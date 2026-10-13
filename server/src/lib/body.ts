/**
 * Read a request body, refusing (null) anything past `max` bytes without
 * buffering it: a declared Content-Length over the cap is refused up front,
 * and a chunked body is cut off as soon as it crosses the cap.
 */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The media type of a request's Content-Type header, without parameters. */
export function declaredType(req: Request): string {
  return (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
}
