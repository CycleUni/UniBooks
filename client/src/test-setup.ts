// The app's initializer loads the visitor's language before the first render
// (app.config.ts); unit tests don't run initializers, so load English here,
// the language tests render in and assert against.
import { TRANSLATIONS } from './app/core/i18n';
import { en } from './app/core/i18n/en';

TRANSLATIONS.en = en;
