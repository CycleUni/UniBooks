// The app's initializer loads the visitor's language before the first render
// (app.config.ts); unit tests don't run initializers, so load English here,
// the language tests render in and assert against.
import { TRANSLATIONS } from './app/core/i18n';
import { en } from './app/core/i18n/en';

TRANSLATIONS.en = en;

// A shared CI runner can stall a test past vitest's 5s default, failing a
// different spec on each run; a real hang still fails, just later.
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
