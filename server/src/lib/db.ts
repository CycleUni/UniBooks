/** Whether a write failed on a UNIQUE constraint; D1 wraps the driver error, so the message may sit in `cause`. */
export function isUniqueViolation(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e) + String((e as { cause?: unknown })?.cause ?? '');
  return /UNIQUE constraint failed/i.test(msg);
}
