/**
 * A failure that says the backend could not answer right now, not what the
 * answer is: the connection dropped (0), it asked us to slow down (429), or it
 * failed on its side (5xx) — on a serverless backend, typically a cold start.
 *
 * Worth telling apart from a real answer (401, 403, 404…) wherever a failure
 * would otherwise be taken as a verdict: waiting and asking again can change
 * this one, and it says nothing about the visitor's session or permissions.
 */
export function isTransientHttpFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 0 || status === 429 || status >= 500);
}
