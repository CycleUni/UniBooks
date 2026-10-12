import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { ConfirmService } from './services/confirm.service';
import { I18nService } from './i18n.service';

/**
 * Implemented by any component that holds work-in-progress the user would
 * lose on navigation (e.g. the multi-step listing form in `features/sell`).
 *
 * The component owns both halves of the decision — whether there is anything
 * worth warning about, and what the warning says — so this guard stays free
 * of any feature-specific state or i18n key.
 */
export interface HasUnsavedChanges {
  /** True only when the user has entered something that is not yet submitted. */
  hasUnsavedChanges(): boolean;
  /** Already-translated text for the leave confirmation. */
  unsavedChangesMessage(): string;
}

/**
 * Asks before leaving a route whose component reports unsaved changes.
 *
 * This used to call the native `confirm()`, on the theory that a
 * `CanDeactivate` guard must answer synchronously. Mobile browsers do not
 * reliably show that dialog — Chrome and Safari suppress dialogs a page
 * raises while handling a navigation — and a suppressed `confirm()` returns
 * false, which cancels the navigation. The page then looked frozen: tapping
 * another tab did nothing at all, with nothing on screen to explain why.
 *
 * The app's own dialog always renders, so the guard returns its promise.
 * Angular waits for it. For a cancelled *back* gesture the address bar has
 * already moved, so the router is configured with
 * `canceledNavigationResolution: 'computed'` (app.config.ts) to put it back.
 *
 * Tab close / reload is a different mechanism entirely and cannot be covered
 * here; components pair this with their own `beforeunload` listener.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component || typeof component.hasUnsavedChanges !== 'function') {
    return true;
  }
  if (!component.hasUnsavedChanges()) {
    return true;
  }
  const i18n = inject(I18nService);
  return inject(ConfirmService).ask({
    message: component.unsavedChangesMessage(),
    confirmLabel: i18n.t('common.leave'),
    cancelLabel: i18n.t('common.stay'),
    variant: 'danger',
  });
};
