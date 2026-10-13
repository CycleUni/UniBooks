/**
 * Store `bytes` at `key` only if nothing is stored there yet, in one
 * conditional write (If-None-Match: *), so two racing PUTs with the same
 * upload token cannot both succeed. False when the key already existed.
 */
export async function putOnce(r2: R2Bucket, key: string, bytes: Uint8Array, httpMetadata: R2HTTPMetadata): Promise<boolean> {
  const stored = await r2.put(key, bytes, { httpMetadata, onlyIf: new Headers({ 'If-None-Match': '*' }) });
  return stored !== null;
}
