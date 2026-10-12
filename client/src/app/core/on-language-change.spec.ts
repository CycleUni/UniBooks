import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { onLanguageChange } from './on-language-change';
import { I18nService } from './i18n.service';

describe('onLanguageChange', () => {
  it('reloads when the language changes, but not as the page starts', () => {
    // The book, listing and seller pages load from their route; an effect
    // also running at start-up fetched them a second time.
    const lang = signal('zh-TW');
    const other = signal(0);
    const reload = vi.fn(() => other());   // reads a signal, as loaders do
    TestBed.runInInjectionContext(() => onLanguageChange({ lang } as unknown as I18nService, reload));

    TestBed.tick();
    expect(reload).not.toHaveBeenCalled();

    lang.set('en');
    TestBed.tick();
    expect(reload).toHaveBeenCalledTimes(1);

    other.set(1);      // a signal the loader read must not re-run it
    TestBed.tick();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
