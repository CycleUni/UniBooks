import { ErrorHandler, Injectable, Injector } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';

/**
 * Sentry without its weight. The SDK (core/sentry-sdk.ts) is about a third of
 * the initial bundle, so it is loaded once the first page has settled (main.ts,
 * core/page-settled): loaded on idle alone, its three-second timeout fired
 * while a slow phone was still drawing the page, and parsing it was the
 * longest task before the first paint. Until then, calls made through this
 * file wait in a short queue and are replayed once it is ready, so nothing
 * reported early is lost.
 *
 * Errors thrown before the SDK exists reach the queue through two window
 * listeners; the SDK's own handlers take over when it loads. With no DSN
 * configured Sentry stays off and every call here does nothing.
 */
type Sdk = typeof import('./sentry-sdk');
type Job = (sdk: Sdk) => void;

const QUEUE_LIMIT = 30;
let sdk: Sdk | null = null;
let queue: Job[] = [];
let started = false;

const enabled = () => !!environment.sentryDsn;

function run(job: Job): void {
  if (!enabled()) return;
  if (sdk) job(sdk);
  else if (queue.length < QUEUE_LIMIT) queue.push(job);
}

function captureException(error: unknown, hint?: Parameters<Sdk['captureException']>[1]): void {
  run((s) => s.captureException(error, hint));
}

function setUser(user: { id: string } | null): void {
  run((s) => s.setUser(user));
}

/** Connects Sentry's router tracing once the SDK is there. */
function traceRouter(injector: Injector): void {
  run((s) => {
    Injector.create({ providers: [{ provide: s.TraceService, deps: [Router] }], parent: injector }).get(s.TraceService);
  });
}

/** What the rest of the app calls; an object so specs can spy on it. */
export const sentry = { captureException, setUser, traceRouter };

@Injectable()
export class LazySentryErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error(error);
    run((s) => s.errorHandler.handleError(error));
  }
}

const onError = (e: ErrorEvent) => run((s) => s.captureException(e.error ?? e.message));
const onRejection = (e: PromiseRejectionEvent) => run((s) => s.captureException(e.reason));

/** Starts listening for early errors; call before bootstrapping the app. */
export function watchEarlyErrors(): void {
  if (!enabled() || typeof window === 'undefined') return;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
}

/** Loads the SDK, then replays what was queued. Call once the page has settled. */
export function startSentry(): void {
  if (!enabled() || started || typeof window === 'undefined') return;
  started = true;
  import('./sentry-sdk')
    .then((loaded) => {
      loaded.initSentry();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      sdk = loaded;
      const pending = queue;
      queue = [];
      pending.forEach((job) => job(loaded));
    })
    .catch(() => {
      // The chunk could not load (offline, blocked): reporting stays off.
      queue = [];
    });
}
