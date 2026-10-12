import { effect, untracked } from '@angular/core';
import { I18nService } from './i18n.service';

/**
 * Runs `reload` each time the language changes — not when the page starts.
 *
 * Pages that load from their route parameters used a plain effect for this,
 * and an effect also runs once as the component starts, by which time the
 * route subscription had already loaded the page: the book, listing and
 * seller pages each fetched their data twice on every visit. `reload` also
 * runs untracked, so signals it reads cannot re-run it either.
 *
 * Call from an injection context (a constructor or field initializer).
 */
export function onLanguageChange(i18n: I18nService, reload: () => void): void {
  let started = false;
  effect(() => {
    i18n.lang();
    if (!started) {
      started = true;
      return;
    }
    untracked(reload);
  });
}
