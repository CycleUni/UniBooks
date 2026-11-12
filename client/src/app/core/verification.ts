import { isSameRegion } from './region-path';
import { SchoolOption } from './services/school-state.service';

export function isUserVerifiedIn(verifications: any[] | undefined | null, regionCode: string | null): boolean {
  if (!verifications || !Array.isArray(verifications) || !regionCode) return false;
  return verifications.some(v => isSameRegion(v.region, regionCode) && !!v.verified_at);
}

/**
 * Whether `domain` is a region's campus suffix (written with or without a
 * leading dot) or a subdomain of it: ".hku.hk" covers hku.hk and
 * connect.hku.hk, not evilhku.hk. The server's rule (services/accounts/edu.ts).
 */
export function domainMatchesSuffix(domain: string, suffix: string): boolean {
  const d = domain.toLowerCase();
  const s = suffix.trim().toLowerCase().replace(/^[.@]+/, '');
  return !!s && (d === s || d.endsWith(`.${s}`));
}

/**
 * Return all distinct accepted domains for a school, placing student_email_domain first if set.
 */
export function getSchoolDomainChoices(school: SchoolOption | null | undefined): string[] {
  if (!school) return [];
  // A school that lists its mailbox domains offers only those: nobody's
  // address is on the bare website domain there, and choosing it would
  // send the link nowhere. The server still accepts it if typed in full.
  const listed = (school.email_domains || []).filter(Boolean);
  const list = (
    listed.length
      ? [school.student_email_domain, ...listed]
      : [school.student_email_domain, school.email_domain, ...(school.accepted_domains || [])]
  ).filter(Boolean) as string[];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const d of list) {
    const norm = d.trim().toLowerCase();
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      result.push(norm);
    }
  }
  return result;
}

/**
 * Split an email address into local part and lowercase domain, or null if not a valid user@domain format.
 */
export function splitEmailAddress(email: string): { localPart: string; domain: string } | null {
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const localPart = trimmed.slice(0, at).trim();
  const domain = trimmed.slice(at + 1).trim().toLowerCase();
  if (!localPart || !domain || domain.includes('@')) return null;
  return { localPart, domain };
}

/**
 * Find the best matching school for a domain (exact match or most specific parent domain).
 */
export function findSchoolForDomain(schools: SchoolOption[], domain: string): { school: SchoolOption; matchedDomain: string } | null {
  const d = domain.trim().toLowerCase();
  if (!d) return null;
  let bestSchool: SchoolOption | null = null;
  let bestDomain = '';
  let bestDepth = -1;

  for (const s of schools) {
    const choices = getSchoolDomainChoices(s);
    for (const choice of choices) {
      if (domainMatchesSuffix(d, choice)) {
        const depth = choice.split('.').length;
        if (depth > bestDepth) {
          bestDepth = depth;
          bestSchool = s;
          bestDomain = choice;
        }
      }
    }
  }
  if (!bestSchool) return null;
  return { school: bestSchool, matchedDomain: bestDomain };
}
