import { SELL_DRAFT_STORAGE_KEY } from './storage-keys';

/**
 * What one signed-in person typed into this browser, removed on an explicit
 * sign-out so the next person on a shared computer does not find it. (Recent
 * searches live in RecentSearches, which clears its own copy.)
 */
const PER_USER_KEYS = [SELL_DRAFT_STORAGE_KEY];

export function forgetSignedOutUser(): void {
  try {
    for (const key of PER_USER_KEYS) localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was kept in it either.
  }
}
