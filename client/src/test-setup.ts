// The app's initializer loads the visitor's language before the first render
// (app.config.ts); unit tests don't run initializers, so load English here,
// the language tests render in and assert against.
import { TRANSLATIONS } from './app/core/i18n';
import { en } from './app/core/i18n/en';

TRANSLATIONS.en = en;

// The unit-test builder runs jsdom specs without per-file isolation, so a timer
// patch one spec leaves behind freezes every setTimeout of the next spec in the
// same worker: it hangs until the timeout, and which spec that is changes with
// scheduling. Put the real timers back after each test and fail the leaking
// test, so the culprit is named instead of its victim.
import { afterEach } from 'vitest';

const globals = globalThis as { __realSetTimeout?: typeof setTimeout };
const realSetTimeout = (globals.__realSetTimeout ??= globalThis.setTimeout);

afterEach(() => {
  if (globalThis.setTimeout === realSetTimeout) return;
  globalThis.setTimeout = realSetTimeout;
  throw new Error('Test left a fake or patched setTimeout installed.');
});
