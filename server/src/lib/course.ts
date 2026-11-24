/**
 * A course's identity: sellers type the name freely ("微積分 (一)", "微積分（一）",
 * "Calculus I"), so two spellings of one course must compare equal. The key drops
 * case, width, whitespace and punctuation; it is never shown, only compared.
 */
export function courseKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
