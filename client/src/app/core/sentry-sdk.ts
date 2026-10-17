import * as Sentry from '@sentry/angular';
import { environment } from '../../environments/environment';
import { redactSensitiveUrl } from './sensitive-url';

/**
 * The Sentry SDK itself. Nothing but core/sentry.ts imports this file, and
 * only through a dynamic import, so the ~340 kB SDK is a lazy chunk rather
 * than part of the initial bundle.
 */
export const { captureException, setUser, TraceService } = Sentry;

/** Angular's ErrorHandler for the SDK. The facade logs to the console itself. */
export const errorHandler = Sentry.createErrorHandler({ logErrors: false });

function scrubEventUrls<T extends Sentry.Event>(event: T): T {
  if (event.request?.url) event.request.url = redactSensitiveUrl(event.request.url);
  if (event.transaction) event.transaction = redactSensitiveUrl(event.transaction);
  return event;
}

export function initSentry(): void {
  Sentry.init({
    dsn: environment.sentryDsn,
    environment: environment.production ? 'production' : 'development',
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: environment.production ? 0.1 : 1.0,
    // sentry-trace and baggage go on this origin's API calls only, so the
    // Worker (same origin, same Sentry project) continues the page's trace.
    // A regex on the path: for a same-origin request the SDK also matches
    // the pathname, and no cross-origin URL starts with /api/.
    tracePropagationTargets: [/^\/api\//],
    // Replays mask all text and block media by default; chats and order
    // details stay masked. Sample sessions lightly, but keep every error.
    replaysSessionSampleRate: 0.05,
    replaysOnErrorSampleRate: 1.0,
    // Google Identity Services throws minified errors (e.g. "pa") from its
    // own event handlers when the account chooser is closed or blocked. They
    // are not ours to fix and reach Sentry through Angular's error handler.
    denyUrls: [/\/gsi\/client/],
    // Reset and email-change links carry their token in the address, and
    // every event records the page URL; see core/sensitive-url.
    beforeSend: (event) => scrubEventUrls(event),
    beforeSendTransaction: (event) => scrubEventUrls(event),
    beforeBreadcrumb: (breadcrumb) => {
      const data = breadcrumb.data;
      if (data) {
        for (const field of ['from', 'to', 'url']) {
          if (typeof data[field] === 'string') data[field] = redactSensitiveUrl(data[field]);
        }
      }
      return breadcrumb;
    },
  });
}
