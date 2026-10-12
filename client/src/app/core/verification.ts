import { isSameRegion } from './region-path';

export function isUserVerifiedIn(verifications: any[] | undefined | null, regionCode: string | null): boolean {
  if (!verifications || !Array.isArray(verifications) || !regionCode) return false;
  return verifications.some(v => isSameRegion(v.region, regionCode) && !!v.verified_at);
}
