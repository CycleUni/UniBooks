/**
 * A course's identity, as the server computes it (server/src/lib/course.ts):
 * sellers type course names freely, so two spellings of one course compare
 * equal once case, width, whitespace and punctuation are dropped.
 */
export function courseKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
