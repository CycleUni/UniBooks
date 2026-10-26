import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { startSentry, watchEarlyErrors } from './app/core/sentry';
import { whenPageSettled } from './app/core/page-settled';

// Errors thrown while the app boots are queued; the SDK itself loads once the
// first page has settled (core/sentry.ts).
watchEarlyErrors();

// iOS Safari only applies :active to a tapped element when a touchstart
// listener exists; this empty one turns on the press styles in styles.css.
document.addEventListener('touchstart', () => {}, { passive: true });

bootstrapApplication(App, appConfig)
  .then((appRef) => whenPageSettled(appRef))
  .then(() => startSentry())
  .catch((err) => console.error(err));
