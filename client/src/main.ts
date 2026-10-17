import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { startSentry, watchEarlyErrors } from './app/core/sentry';

// Errors thrown while the app boots are queued; the SDK itself loads once the
// app is up (core/sentry.ts).
watchEarlyErrors();

// iOS Safari only applies :active to a tapped element when a touchstart
// listener exists; this empty one turns on the press styles in styles.css.
document.addEventListener('touchstart', () => {}, { passive: true });

bootstrapApplication(App, appConfig)
  .then(() => startSentry())
  .catch((err) => console.error(err));
