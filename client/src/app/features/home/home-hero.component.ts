import { RegionLinkDirective } from '../../core/region-link.directive';
import { POPULAR_SEARCH_KEYS } from '../../core/search-suggestions';
import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { UiInput } from '../../shared/ui/input.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiBookCover } from '../../shared/ui/book-cover.component';
import { I18nService, TPipe } from '../../core/i18n.service';
import { CountCapPipe } from '../../shared/pipes/count-cap.pipe';
import { PublicAd } from '../../core/services/metadata.service';
import { RegionLinkService } from '../../core/region-link.service';
import { bookPreviewState, bookQueryParams } from '../../core/book-preview';


/** One book or ad in the hero's tilted cover stack. */
export interface HeroCover {
  id: any;
  isbn?: string;
  title: string;
  coverUrl?: string;
  count?: number;
  isAd?: boolean;
  targetUrl?: string;
  adData?: PublicAd;
}

/**
 * The home page's opening band: value proposition, search entry, popular
 * queries, the supply-side call to action, the trust line, and the tilted
 * cover stack.
 *
 * Split out of the home component because it was roughly 40% of that
 * component's stylesheet and carried its own interaction (search submission,
 * per-cover routing and detail-page cache priming) that had nothing to do
 * with the rest of the page. Home still owns the *data* — which books end up
 * in the stack is derived from the waitlist and recent-listings feeds — and
 * passes them in.
 */
@Component({
  selector: 'app-home-hero',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, UiInput, UiButton, TPipe, UiBookCover, CountCapPipe],
  template: `
      <section class="hero-search" aria-labelledby="hero-title">
        <div class="hero-inner container">
          <div class="hero-copy">
            <h1 class="search-title" id="hero-title">{{ 'home.heroTitle' | t }}</h1>
            <p class="hero-subtitle">{{ 'home.heroSubtitle' | t }}</p>

            <div class="search-bar">
              <div class="hero-input-wrap">
                <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6.5"/>
                  <line x1="20" y1="20" x2="15.4" y2="15.4"/>
                </svg>
                <!-- The placeholder was this field's only name, and a
                     placeholder stops naming anything once text is typed. -->
                <ui-input
                  [ariaLabel]="'common.search' | t"
                  [placeholder]="'common.searchPlaceholder' | t"
                  [(ngModel)]="searchQuery"
                  enterkeyhint="search"
                  (keyup.enter)="onSearch()"
                  class="hero-input"
                  [noMargin]="true"
                ></ui-input>
              </div>
              <ui-button size="lg" (onClick)="onSearch()" class="search-submit"><span class="submit-label sr-only-mobile">{{ 'common.search' | t }}</span><svg class="submit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="20" y1="20" x2="15.4" y2="15.4"/></svg></ui-button>
            </div>

            <div class="popular-tags">
              <span class="tag-label">{{ 'home.popularSearches' | t }}</span>
              <button type="button" class="tag-btn" *ngFor="let key of popularSearchKeys" (click)="setSearchQueryFromKey(key)">{{ key | t }}</button>
            </div>

            <!-- The supply side had exactly one entry point on this page, a
                 ghost button buried under the waitlist card, even though a
                 marketplace this young needs sellers more than buyers. It
                 gets a peer slot to search instead. -->
            <p class="hero-sell">
              <span>{{ 'home.sellPrompt' | t }}</span>
              <a regionLink="/sell" class="hero-sell-link">{{ 'home.sellCtaHero' | t }}<span aria-hidden="true"> &#8594;</span></a>
            </p>

            <ul class="hero-trust">
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"  style="color:var(--accent); flex-shrink:0;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                {{ 'home.trustVerified' | t }}
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" width="16" height="16"  style="color:var(--accent); flex-shrink:0;"><path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.6l6.1-.9z"/></svg>
                {{ 'home.trustReviews' | t }}
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"  style="color:var(--accent); flex-shrink:0;"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                {{ 'home.trustFree' | t }}
              </li>
            </ul>
          </div>

          <!-- While the waitlist is still loading, hold the stack's space
               empty. Rendering the "no books yet" call to action first and
               then replacing it with covers told every visitor the shelf was
               bare for a moment. -->
          <div class="hero-stack" *ngIf="loading && !covers.length" aria-hidden="true"></div>

          <div class="hero-stack" *ngIf="covers.length">
            <ng-container *ngFor="let cover of covers; let i = index">
              <!-- Ad card -->
              <a
                *ngIf="cover.isAd"
                class="cover-card"
                [style.z-index]="covers.length - i"
                [style.--r]="heroCoverRotations(i)"
                [style.--x]="heroCoverOffsets(i)"
                [style.--hover-dir]="heroCoverHoverDir(i)"
                [href]="cover.targetUrl || null"
                target="_blank"
                rel="noopener noreferrer"
                (click)="onHeroAdClick(cover)"
              >
                <ui-book-cover
                  [coverUrl]="cover.coverUrl"
                  [title]="cover.title"
                  [zoom]="3"
                ></ui-book-cover>
                <span class="stamp-tag sponsor-tag">{{ 'home.sponsored' | t }}</span>
              </a>

              <!-- Book cover card -->
              <a
                *ngIf="!cover.isAd"
                class="cover-card"
                [style.z-index]="covers.length - i"
                [style.--r]="heroCoverRotations(i)"
                [style.--x]="heroCoverOffsets(i)"
                [style.--hover-dir]="heroCoverHoverDir(i)"
                [regionLink]="['/book']"
                [queryParams]="heroBookParams(cover)"
                [state]="previewState"
                (click)="cacheHeroBook(cover)"
              >
                <ui-book-cover
                  [coverUrl]="cover.coverUrl"
                  [title]="cover.title"
                  [isbn]="cover.isbn"
                  [zoom]="3"
                ></ui-book-cover>
                <span class="demand-tag stamp-tag" *ngIf="cover.count">{{ 'home.waitingCount' | t:{n: cover.count | countCap} }}</span>
              </a>
            </ng-container>
          </div>

          <div class="hero-cta" *ngIf="!loading && !covers.length">
            <div class="hero-cta-inner">
              <div class="hero-cta-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="28" height="28">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
                  <path d="M6 6h10"/>
                  <path d="M6 10h7"/>
                </svg>
              </div>
              <h2 class="hero-cta-title">{{ 'home.requestCtaTitle' | t }}</h2>
              <p class="hero-cta-desc">{{ 'home.requestCtaDesc' | t }}</p>
              <ui-button [link]="['/search']" size="md" class="hero-cta-btn">{{ 'home.requestCtaButton' | t }}</ui-button>
            </div>
          </div>
        </div>
      </section>  `,
  styles: [`
    :host { display: block; }
    @media (max-width: 900px) {
      :host(.sr-only-phone) {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        padding: 0 !important;
        margin: -1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
        border: 0 !important;
      }
    }

    /* ---- hero ------------------------------------------------------- */
    .hero-search {
      padding-block: var(--space-5);
      background-color: var(--paper-warm);
      border-bottom: 1px solid var(--line);
      margin-bottom: var(--space-4);
    }
    .hero-inner {
      display: grid;
      grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
      align-items: center;
      gap: var(--space-5);
    }
    .hero-copy { text-align: left; min-width: 0; width: 100%; }
    .search-title {
      font-family: 'Noto Serif TC', serif;
      font-size: var(--text-hero);
      font-weight: 700;
      line-height: 1.25;
      letter-spacing: normal;
      margin: 0 0 var(--space-2);
      max-width: 16em;
      text-wrap: balance;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .hero-subtitle {
      margin: 0 0 var(--space-4);
      font-size: var(--text-lg);
      line-height: 1.5;
      color: var(--ink-soft);
      max-width: 32em;
    }
    .search-bar {
      display: flex;
      align-items: stretch;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
      max-width: 560px;
    }
    .hero-input-wrap { position: relative; flex: 1; min-width: 0; }
    .hero-input-wrap .search-icon {
      position: absolute;
      left: 2px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--muted);
      pointer-events: none;
    }
    .hero-input { display: block; width: 100%; height: 100%; }
    .search-submit .submit-icon { display: none; }
    .hero-input ::ng-deep .input-wrapper, .hero-input ::ng-deep input { height: 100%; }
    .hero-input ::ng-deep input {
      min-height: 44px;
      border: none;
      border-bottom: 2px solid var(--ink);
      border-radius: 0;
      background: none;
      padding: var(--space-2) var(--space-1) var(--space-2) var(--space-6);
      font-size: var(--text-base);
    }
    .hero-input ::ng-deep input:focus-visible {
      border-bottom-color: var(--accent);
      outline: 2px solid transparent;
    }

    .popular-tags {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-sm);
      color: var(--muted);
      margin-bottom: var(--space-3);
    }
    .tag-btn {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: var(--space-1) var(--space-2);
      background: var(--paper);
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--ink-soft);
      cursor: pointer;
      font-size: var(--text-sm);
      font-family: inherit;
      transition: background-color var(--motion-base), color var(--motion-base), border-color var(--motion-base);
    }
    @media (pointer: coarse) {
      .tag-btn { min-height: var(--tap-min); padding-inline: var(--space-3); }
    }
    .tag-btn:hover {
      background: var(--accent-soft);
    }

    .hero-sell, .hero-trust {
      display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4);
      font-size: var(--text-base); color: var(--ink-soft);
    }
    .hero-sell { gap: var(--space-2); margin: 0 0 var(--space-3); }
    .hero-sell-link {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      color: var(--accent);
      font-weight: 700;
      text-decoration: none;
      border-bottom: 2px solid transparent;
    }
    .hero-sell-link:hover { border-bottom-color: var(--accent); }
    @media (pointer: coarse) {
      .hero-sell-link { min-height: var(--tap-min); }
    }

    .hero-trust {
      margin: 0; padding: 0; list-style: none;
      font-weight: 500;
    }
    .hero-trust li { display: flex; align-items: center; gap: 6px; }

    /* ---- hero cover stack -------------------------------------------- */
    .hero-stack {
      position: relative;
      width: 100%;
      max-width: 368px;
      aspect-ratio: 1 / 1;
      justify-self: end;
      margin-inline: auto;
      container-type: inline-size;
      --card-scale: clamp(0.85, calc(0.11 + 0.242cqi / 1px), 1);
      --card-shift: clamp(50px, max(50cqi - 98px, 11.875vw - 66px), 130px);
    }
    .cover-card {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 210px;
      height: 294px;
      margin: -147px 0 0 -105px;
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card-lg);
      background-color: var(--surface-card);
      border: 1px solid var(--line-strong);
      cursor: pointer;
      transition: transform var(--motion-base) ease, box-shadow var(--motion-base) ease;
      transform: translateX(var(--x)) rotate(var(--r));
      /* A resting card must not start the fan-out by itself. On narrower
         desktops its tilted corners poke outside .hero-stack, and hovering
         one fanned the cards out from under the pointer, which dropped the
         hover, which brought them back: a loop that shook the stack and ate
         clicks. Only the stack's own box, which never moves, starts the
         fan-out; the cards take the pointer once they are fanned. */
      pointer-events: none;
    }
    .hero-stack:is(:hover, :focus-within) .cover-card { pointer-events: auto; }
    /* The lift below moves the card's hit box up; this strip keeps its old
       bottom edge under the pointer, or the last few pixels of the card
       flicker between lifted and resting the same way. It exists only while
       the card is lifted, so it cannot start the lift itself. */
    .cover-card:is(:hover, :focus-visible)::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 100%;
      height: 12px;
    }
    /* shape comes from the global .stamp-tag */
    .demand-tag, .sponsor-tag {
      left: -8px; bottom: -8px;
      transition: opacity var(--motion-base) ease;
    }
    .demand-tag { color: var(--flag); }
    .sponsor-tag { color: var(--sponsor); z-index: 2; }
    .cover-card:not(:first-child) :is(.demand-tag, .sponsor-tag) {
      opacity: 0;
      pointer-events: none;
    }
    
    .hero-stack:is(:hover, :focus-within) .cover-card {
      transform: translateX(calc(var(--hover-dir) * var(--card-shift))) scale(var(--card-scale));
    }
    .hero-stack:is(:hover, :focus-within) .cover-card:not(:first-child) :is(.demand-tag, .sponsor-tag) {
      opacity: 1;
      pointer-events: auto;
    }
    .hero-stack:is(:hover, :focus-within) .cover-card:is(:hover, :focus-visible) {
      transform: translateX(calc(var(--hover-dir) * var(--card-shift))) scale(var(--card-scale)) translateY(-6px) !important;
      z-index: 10 !important;
    }

    @media (hover: none) {
      .cover-card {
        transform: translateX(calc(var(--hover-dir) * var(--card-shift))) scale(var(--card-scale));
        pointer-events: auto;
      }
      .cover-card:not(:first-child) :is(.demand-tag, .sponsor-tag) {
        opacity: 1;
        pointer-events: auto;
      }
      .cover-card:hover {
        transform: translateX(calc(var(--hover-dir) * var(--card-shift))) scale(var(--card-scale)) !important;
      }
    }

    /* ---- hero cta ---------------------------------------------------- */
    .hero-cta {
      width: 100%;
      max-width: 368px;
      justify-self: end;
      margin-inline: auto;
    }
    .hero-cta-inner {
      background-color: var(--surface-card);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card-lg);
      padding: var(--space-6) var(--space-5);
      text-align: left;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }
    .hero-cta-mark {
      color: var(--accent);
      margin-bottom: var(--space-1);
    }
    .hero-cta-title {
      font-family: 'Noto Serif TC', serif;
      font-size: var(--text-xl);
      font-weight: 700;
      line-height: 1.3;
      margin: 0;
      color: var(--ink);
    }
    .hero-cta-desc {
      font-size: var(--text-sm);
      line-height: 1.6;
      color: var(--ink-soft);
      margin: 0;
    }
    .hero-cta-btn {
      margin-top: var(--space-2);
    }

    @media (max-width: 768px) {
      .hero-search { padding-block: var(--space-4); margin-bottom: var(--space-4); }
      .hero-inner { grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: var(--space-3); }
      .hero-stack, .hero-cta { display: none; }
      .search-title { line-height: 1.2; max-width: 100%; overflow-wrap: anywhere; }
      .hero-subtitle { font-size: var(--text-sm); margin-bottom: var(--space-3); }
      .search-bar { max-width: none; margin-bottom: var(--space-2); }
      .hero-input-wrap { flex: 1; min-width: 0; }
      .hero-input-wrap .search-icon { display: none; }
      .hero-input ::ng-deep input { padding-left: var(--space-2); min-height: 40px; }
      .search-submit { flex: 0 0 40px; align-self: stretch; }
      .search-submit ::ng-deep .ui-btn.lg { padding-inline: 0; min-height: 40px; height: 100%; }
      .search-submit .submit-icon { display: block; }
      .hero-sell, .tag-label { display: none; }
      .popular-tags { margin-bottom: var(--space-2); }
      .hero-trust { gap: var(--space-1) var(--space-2); margin-top: 0; font-size: var(--text-sm); }
      .hero-trust li { gap: var(--space-1); }
    }
  `]
})
export class HomeHero {
  /** Books to show in the stack; the page decides which ones. */
  @Input() covers: HeroCover[] = [];
  /** True until the page knows whether there are covers at all. */
  @Input() loading = false;
  @Output() adClick = new EventEmitter<PublicAd>();

  searchQuery = '';

  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private i18n = inject(I18nService);

  onSearch() {
    if (this.searchQuery.trim()) {
      this.router.navigate(this.regionLink.path(['/search']), {
        queryParams: { q: this.searchQuery.trim() },
        replaceUrl: true
      });
    }
  }

  setSearchQuery(tag: string) { this.searchQuery = tag; this.onSearch(); }

  /** Shared with the search screen's suggestions. */
  readonly popularSearchKeys = POPULAR_SEARCH_KEYS;

  setSearchQueryFromKey(key: string) {
    const translated = this.i18n.t(key);
    if (translated && translated !== key) {
      this.setSearchQuery(translated);
    }
  }

  heroCoverRotations(i: number): string {
    const total = this.covers.length;
    if (total <= 1) return '0deg';
    if (total === 2) {
      const rotations = [-5, 4];
      return `${rotations[i % rotations.length]}deg`;
    }
    const rotations = [-6, 4, -10];
    return `${rotations[i % rotations.length]}deg`;
  }

  heroCoverOffsets(i: number): string {
    const total = this.covers.length;
    if (total <= 1) return '0px';
    if (total === 2) {
      const offsets = [-18, 24];
      return `${offsets[i % offsets.length]}px`;
    }
    const offsets = [0, 42, -32];
    return `${offsets[i % offsets.length]}px`;
  }

  heroCoverHoverDir(i: number): number {
    const total = this.covers.length;
    if (total <= 1) return 0;
    if (total === 2) {
      const dirs = [-0.6, 0.6];
      return dirs[i % dirs.length];
    }
    const dirs = [0, 1, -1];
    return dirs[i % dirs.length];
  }

  /** Route params for a hero cover; the anchor's href does the navigating. */
  heroBookParams(cover: HeroCover): Record<string, any> {
    return bookQueryParams(cover);
  }

  /** Lets the book page show what cacheHeroBook() stashed; carried outside the URL. */
  readonly previewState = bookPreviewState();

  /** Primes the detail-page cache on the way out; navigation is the link's job. */
  cacheHeroBook(cover: HeroCover) {
    if (typeof sessionStorage === 'undefined') return;
    const cached = {
      id: cover.id,
      title: cover.title,
      author: '',
      isbn: cover.isbn,
      coverUrl: cover.coverUrl,
      activeListings: 1
    };
    sessionStorage.setItem(`cachedBook_${cover.isbn || cover.id}`, JSON.stringify(cached));
  }

  onHeroAdClick(cover: HeroCover) {
    if (cover.adData) {
      this.adClick.emit(cover.adData);
    }
  }
}
