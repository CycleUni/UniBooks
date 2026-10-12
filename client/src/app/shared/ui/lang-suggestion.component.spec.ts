import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { UiLangSuggestion } from './lang-suggestion.component';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { TRANSLATIONS } from '../../core/i18n';
import { en } from '../../core/i18n/en';
import { zhTW } from '../../core/i18n/zh-TW';

describe('UiLangSuggestion', () => {
  const region = signal<any>({ code: 'TW', languages: ['zh-TW', 'en'], default_language: 'zh-TW' });
  let languages: string[];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'zh-TW');
    TRANSLATIONS['en'] = en;
    TRANSLATIONS['zh-TW'] = zhTW;
    languages = ['en-US', 'en'];
    vi.spyOn(navigator, 'languages', 'get').mockImplementation(() => languages);
    TestBed.configureTestingModule({
      imports: [UiLangSuggestion],
      providers: [{ provide: RegionService, useValue: { currentRegionObj: region } }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function render() {
    const fixture = TestBed.createComponent(UiLangSuggestion);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('asks an English device, in English, whether to leave the region language', async () => {
    const fixture = await render();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.lang-suggestion')?.getAttribute('lang')).toBe('en');
    expect(el.textContent).toContain('Switch to English');
    expect(el.textContent).toContain('Keep 中文 (繁體)');
  });

  it('switches the language and stops asking once accepted', async () => {
    const fixture = await render();
    const i18n = TestBed.inject(I18nService);
    (fixture.nativeElement.querySelector('.ui-btn.primary') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(i18n.lang()).toBe('en');
    expect(i18n.suggestionSettled()).toBe(true);
    expect(fixture.nativeElement.querySelector('.lang-suggestion')).toBeNull();
  });

  it('keeps the language and stops asking once declined', async () => {
    const fixture = await render();
    const i18n = TestBed.inject(I18nService);
    (fixture.nativeElement.querySelector('.ui-btn.ghost') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(i18n.lang()).toBe('zh-TW');
    expect(i18n.suggestionSettled()).toBe(true);
    expect(fixture.nativeElement.querySelector('.lang-suggestion')).toBeNull();
  });

  it('goes away when a language is picked in the footer', async () => {
    const fixture = await render();
    const i18n = TestBed.inject(I18nService);
    i18n.settleSuggestion();
    await i18n.setLang('en');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.lang-suggestion')).toBeNull();
  });

  it('does not ask a device already in the page language', async () => {
    languages = ['zh-TW'];
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('.lang-suggestion')).toBeNull();
  });

  it('does not ask again after an answer', async () => {
    localStorage.setItem('langSuggestion', '1');
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('.lang-suggestion')).toBeNull();
  });
});
