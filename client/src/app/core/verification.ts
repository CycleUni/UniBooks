import { isSameRegion } from './region-path';

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
