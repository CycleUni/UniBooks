import { Component, computed, effect, inject, signal } from '@angular/core';
import { I18nService, suggestedLang } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { LANG_LABELS, Lang } from '../../core/i18n';
import { UiFloatingPrompt } from './floating-prompt.component';

/** Crawlers render with an English browser; offering them English would only put the offer in the index. */
const CRAWLER_UA = /bot|crawl|spider|slurp|lighthouse|headless/i;

/**
 * Offers the visitor's device language when the page opened in another.
 *
 * A region page opens in the region's language whatever the browser says
 * (langFromPath), which is right for search engines and for most visitors,
 * and leaves an English-speaking student on /tw/ reading Chinese with the
 * language picker down in the footer. This asks once instead of switching
 * for them: the page stays as the region serves it until they say so.
 *
 * Written in the offered language, not the current one — it is for the
 * reader who cannot read the page yet. Only languages the region offers are
 * suggested, since RegionService puts any other back to the region default.
 * Answered either way (or a language picked in the footer), it does not
 * come back.
 */
@Component({
  selector: 'ui-lang-suggestion',
  standalone: true,
  imports: [UiFloatingPrompt],
  template: `
    @if (offer(); as lang) {
      <!-- First in line: until it is answered the page may not be readable. -->
      <ui-floating-prompt
        icon="globe"
        [lang]="lang"
        [priority]="1"
        [title]="i18n.tIn(lang, 'app.langSuggestTitle')"
        [acceptLabel]="i18n.tIn(lang, 'app.langSuggestSwitch')"
        [dismissLabel]="i18n.tIn(lang, 'app.langSuggestKeep', { lang: currentLabel() })"
        (accept)="accept(lang)"
        (dismiss)="dismiss()"
      ></ui-floating-prompt>
    }
  `,
})
export class UiLangSuggestion {
  readonly i18n = inject(I18nService);
  private regionService = inject(RegionService);

  /** The language on offer once its table has loaded, else null. */
  readonly offer = signal<Lang | null>(null);
  readonly currentLabel = computed(() => LANG_LABELS[this.i18n.lang()]);

  private settled =
    typeof navigator === 'undefined' ||
    CRAWLER_UA.test(navigator.userAgent || '') ||
    this.i18n.suggestionSettled();

  constructor() {
    effect(() => {
      // Waits for the region list: until it arrives there is no telling
      // which languages this region's pages come in.
      const region = this.regionService.currentRegionObj();
      const current = this.i18n.lang();
      // Re-read on every language change: a language picked in the footer
      // answers the offer too (UiPrefsSelector settles it).
      if (this.settled || this.i18n.suggestionSettled()) {
        this.settled = true;
        this.offer.set(null);
        return;
      }
      if (!region) return;
      const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
      const lang = suggestedLang(tags, region.languages, current);
      if (!lang) {
        this.offer.set(null);
        return;
      }
      this.i18n.loadLang(lang).then(() => {
        if (!this.settled && this.i18n.lang() === current) this.offer.set(lang);
      });
    });
  }

  accept(lang: Lang) {
    this.settle();
    this.i18n.setLang(lang);
  }

  dismiss() {
    this.settle();
  }

  private settle() {
    this.settled = true;
    this.offer.set(null);
    this.i18n.settleSuggestion();
  }
}
