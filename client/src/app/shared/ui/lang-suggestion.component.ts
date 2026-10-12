import { Component, computed, effect, inject, signal } from '@angular/core';
import { I18nService, suggestedLang } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { LANG_LABELS, Lang } from '../../core/i18n';
import { UiButton } from './button.component';

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
  imports: [UiButton],
  template: `
    @if (offer(); as lang) {
      <div
        class="lang-suggestion"
        role="region"
        [attr.lang]="lang"
        [attr.aria-label]="i18n.tIn(lang, 'app.langSuggestTitle')"
      >
        <div class="lang-suggestion-inner container">
          <svg
            class="lang-suggestion-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path
              d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"
            />
          </svg>
          <span class="lang-suggestion-text">{{ i18n.tIn(lang, 'app.langSuggestTitle') }}</span>
          <div class="lang-suggestion-actions">
            <ui-button variant="primary" (onClick)="accept(lang)">{{
              i18n.tIn(lang, 'app.langSuggestSwitch')
            }}</ui-button>
            <ui-button variant="ghost" (onClick)="dismiss()">{{
              i18n.tIn(lang, 'app.langSuggestKeep', { lang: currentLabel() })
            }}</ui-button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .lang-suggestion {
        background-color: var(--info-bg);
        border-bottom: 1px solid var(--info-border);
        color: var(--ink);
      }
      .lang-suggestion-inner {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
        padding-block: var(--space-2);
      }
      .lang-suggestion-icon {
        flex: none;
        color: var(--info-ink);
      }
      .lang-suggestion-text {
        flex: 1 1 12rem;
        min-width: 0;
        font-size: var(--text-sm);
        font-weight: 500;
      }
      .lang-suggestion-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      /* Phones: the buttons wrap under the question, so the banner needs room
         around and between its two rows, and the buttons share the full width
         instead of huddling at the left. */
      @media (max-width: 600px) {
        .lang-suggestion-inner {
          gap: var(--space-3);
          padding-block: var(--space-4);
        }
        .lang-suggestion-actions {
          flex: 1 1 100%;
          gap: var(--space-3);
        }
        .lang-suggestion-actions ui-button {
          flex: 1 1 0;
          min-width: 0;
        }
      }
    `,
  ],
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
