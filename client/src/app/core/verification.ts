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
 * The mailbox domains the verification form may prefill for a school: only
 * the ones the school's record lists, the usual student one first. A school
 * with none listed returns [] and the form asks for the whole address:
 * `email_domain` is the school's WEBSITE domain, and showing it as a fixed
 * "@domain" told students their address was on a domain it may not be on.
 */
export function getSchoolDomainChoices(school: SchoolOption | null | undefined): string[] {
  if (!school) return [];
  const listed = (school.email_domains || []).map((d) => (d || '').trim().toLowerCase()).filter(Boolean);
  if (!listed.length) return [];
  const preferred = (school.student_email_domain || '').trim().toLowerCase();
  const ordered = listed.includes(preferred) ? [preferred, ...listed] : listed;
  return [...new Set(ordered)];
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
    // Every domain the school accepts, not only the ones the form offers:
    // a pasted address on the website domain still belongs to that school.
    const choices = [s.email_domain, ...(s.email_domains || []), ...(s.accepted_domains || [])]
      .map((c) => (c || '').trim().toLowerCase())
      .filter(Boolean);
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
