import { Component, OnInit, ViewChild, inject, effect, DestroyRef, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { UiInput } from '../../shared/ui/input.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiListingRow } from '../../shared/ui/listing-row.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiSearchField } from '../../shared/ui/search-field.component';
import { FormsModule } from '@angular/forms';
import { BookService, CourseFacet, SearchEngine, engineForSource, parseSearchEngine } from '../../core/services/book.service';
import { AuthStore } from '../../core/auth.store';
import { ChangeDetectorRef } from '@angular/core';
import { I18nService, TPipe } from '../../core/i18n.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { MetadataService } from '../../core/services/metadata.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { UiRecentListings } from '../../shared/ui/recent-listings.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiRadioGroup } from '../../shared/ui/radio-group.component';
import { UiBottomSheet } from '../../shared/ui/bottom-sheet.component';
import { UiBarcodeScanner } from '../../shared/ui/barcode-scanner.component';
import { UiPullToRefresh } from '../../shared/ui/pull-to-refresh.component';
import { UiInfiniteScroll } from '../../shared/ui/infinite-scroll.component';
import { injectIsPhone } from '../../core/viewport';
import { PhonePager } from '../../core/phone-pager';
import { isbnFromScan } from '../../core/isbn';
import { POPULAR_SEARCH_KEYS, RecentSearches } from '../../core/search-suggestions';
import { UiFacetList, FacetOption } from '../../shared/ui/facet-list.component';
import { Subject, combineLatest, merge, Subscription } from 'rxjs';
import { map, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { bookPreviewState, bookQueryParams } from '../../core/book-preview';
import { SeoService } from '../../core/services/seo.service';

type ConditionKey = 'new' | 'like_new' | 'noted' | 'damaged';
const CONDITION_KEYS: ConditionKey[] = ['new', 'like_new', 'noted', 'damaged'];

/**
 * 搜尋條件的完整形狀。存在的理由是「網址就是唯一狀態來源」：每個 handler 都
 * 以目前這一整組狀態為底、只覆寫自己那幾格，才不會像以前各自 `const params:
 * any = {}` 重建一份時把沒寫到的條件無聲清掉。
 */
interface SearchUrlState {
  q: string;
  category: string;
  course: string;
  /** null = no source asked for, so the backend runs its fallback chain. */
  engine: SearchEngine | null;
  page: number;
  /** 已勾選的書況。四個全勾等於沒有篩選。 */
  conditions: ConditionKey[];
  priceMin: string;
  priceMax: string;
  inStock: boolean;
}

/** 「一個書況都沒勾」的哨兵值 —— 空字串在網址裡和「沒有這個參數」分不出來，
 *  但兩者的意思相反（沒有參數＝全選，沒有勾＝結果為空）。 */
const CONDITION_NONE = 'none';

/** The filters the filter controls edit, as the page holds them before they
 *  go into the URL (prices as typed). */
type FilterDraft = Pick<SearchUrlState, 'conditions' | 'category' | 'course' | 'inStock' | 'priceMin' | 'priceMax'>;

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiInput, UiButton, UiSkeleton, UiRecentListings, UiPagination, UiBookTile, UiFacetList, UiRadioGroup, UiBottomSheet, UiBarcodeScanner, UiPullToRefresh, UiInfiniteScroll, UiSearchField, TPipe],
  template: `
    <ui-pull-to-refresh [refreshing]="refreshing" (refresh)="onRefresh()">
      <div class="search-header">
        <div class="header-inner container">
          <ng-container *ngIf="isPhone; else desktopSearchHeader">
            <ui-search-field
              class="phone-search-field"
              [showScan]="true"
              [(ngModel)]="searchQuery"
              (search)="onSearch($event)"
              (scan)="openScanner()"
            ></ui-search-field>
          </ng-container>
          <ng-template #desktopSearchHeader>
            <div class="search-page-input-wrap">
              <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5"/>
                <line x1="20" y1="20" x2="15.4" y2="15.4"/>
              </svg>
              <!-- No visible label: the placeholder was the only name, and it
                   stops naming anything once text is typed. -->
              <ui-input
                [ariaLabel]="'common.search' | t"
                [placeholder]="'common.searchPlaceholder' | t"
                [(ngModel)]="searchQuery"
                enterkeyhint="search"
                (keyup.enter)="onSearch()"
                class="search-page-input"
              ></ui-input>
            </div>
            <ui-button (onClick)="onSearch()" class="search-button"><span class="submit-label">{{ 'common.search' | t }}</span></ui-button>
          </ng-template>
        </div>
      </div>

      <div class="container search-layout">
        <!-- The filter groups, rendered in the sidebar on wide screens and in
             a bottom sheet on phones. -->
        <ng-template #filterGroups>
          <div class="filter-group">
            <ui-facet-list
              [title]="'common.condition' | t"
              [options]="conditionFacetOptions"
              selectionMode="multiple"
              (optionToggle)="toggleCondition($event)"
            ></ui-facet-list>
          </div>
          <div class="filter-group">
            <ui-facet-list
              [title]="'search.categoryTitle' | t"
              [options]="categoryFacetOptions"
              selectionMode="single"
              (optionToggle)="onCategoryChange($event)"
            ></ui-facet-list>
          </div>
          <div class="filter-group">
            <ui-facet-list
              [title]="'search.courseTitle' | t"
              [options]="courseFacetOptions"
              selectionMode="single"
              (optionToggle)="onCourseChange($event)"
            ></ui-facet-list>
          </div>
          <div class="filter-group">
            <h4 class="filter-title">{{ 'search.stockTitle' | t }}</h4>
            <!-- 單向綁定 + 明確的 handler：狀態由網址還原，radio 只負責發動導頁。 -->
            <ui-radio-group [options]="stockOptions" [ngModel]="shownFilters.inStock ? 'inStock' : 'all'" (ngModelChange)="onStockChange($event)"></ui-radio-group>
          </div>
          <div class="filter-group">
            <h4 class="filter-title">{{ 'search.priceTitle' | t }}</h4>
            <!-- ngModel 留著讓輸入當下就能重排目前這頁，但只有離開欄位或按
                 Enter 才寫進網址 —— 每個字元都 navigate 一次會塞爆上一頁紀錄，
                 而且 "1" / "12" / "120" 會各觸發一次狀態還原。
                 blur 不會冒泡，所以聽的是 ui-input 主機元素上的 focusout。 -->
            <div class="price-range">
              <ui-input [placeholder]="'search.priceMinPlaceholder' | t" [ngModel]="shownFilters.priceMin" (ngModelChange)="setPrice('priceMin', $event)" inputmode="decimal" enterkeyhint="done" (focusout)="commitPriceRange()" (keyup.enter)="commitPriceRange()" class="price-input"></ui-input>
              <span>-</span>
              <ui-input [placeholder]="'search.priceMaxPlaceholder' | t" [ngModel]="shownFilters.priceMax" (ngModelChange)="setPrice('priceMax', $event)" inputmode="decimal" enterkeyhint="done" (focusout)="commitPriceRange()" (keyup.enter)="commitPriceRange()" class="price-input"></ui-input>
            </div>
          </div>
        </ng-template>

        <!-- Phones: opens the filters as a bottom sheet. Choices there are a
             draft (filterDraft) that the sheet's button applies; closing the
             sheet any other way drops them, as in a native filter screen. -->
        <button
          type="button"
          class="filter-toggle"
          (click)="openFilters()"
          aria-haspopup="dialog"
        >
          <span>{{ 'search.filters' | t }}</span>
          <span class="filter-count" *ngIf="activeFilterCount > 0">{{ activeFilterCount }}</span>
          <svg class="filter-toggle-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <ui-bottom-sheet *ngIf="filtersOpen" [title]="'search.filters' | t" (closed)="discardFilters()">
          <div class="sheet-filters">
            <ng-container *ngTemplateOutlet="filterGroups"></ng-container>
          </div>
          <div sheetFooter class="sheet-footer">
            <ui-button block (onClick)="applyFilters()">{{ 'search.showResults' | t }}</ui-button>
          </div>
        </ui-bottom-sheet>

        <aside class="sidebar">
          <ng-container *ngTemplateOutlet="filterGroups"></ng-container>
        </aside>

        <main class="results">
          <!-- 保留在結果欄而不是側欄：這不是使用者選出來的條件，是後端自動降級
               後的通知，跟哪個篩選器都無關。 -->
          <p class="fallback-hint" *ngIf="googleUnavailable">{{ 'search.googleUnavailable' | t }}</p>
          <p class="fallback-hint" *ngIf="resultsTruncated">{{ 'search.resultsTruncated' | t }}</p>
          <h2 class="section-heading" *ngIf="activeQuery">{{ 'search.resultsFor' | t:{q: activeQuery} }}</h2>
          <h2 class="section-heading" *ngIf="!activeQuery && category">{{ 'search.categoryResults' | t }}</h2>
          <h2 class="section-heading" *ngIf="!activeQuery && !category && searching">{{ 'search.filterResults' | t }}</h2>
          <p class="scoped-count" *ngIf="searching && !loading && !fetchError && filteredResults.length > 0">
            <!-- The scoped count is books with a copy at this school. When that
                 is zero while catalogue matches are listed right below,
                 "Found 0 matching books" contradicted the page. -->
            <!-- Browsing found nothing at the school, so these are its city's. -->
            <ng-container *ngIf="currentSchool && isCityFallback">
              {{ 'home.cityFallbackNote' | t:{school: currentSchoolLabel, city: searchCityLabel} }}
              <button type="button" class="fallback-link" (click)="showAllSchools()">{{ 'home.showAllSchools' | t }}</button>
            </ng-container>
            <ng-container *ngIf="currentSchool && !isCityFallback && localResultsCount > 0">{{ 'search.foundCountScoped' | t:{school: currentSchoolLabel, n: localResultsCount} }}</ng-container>
            <ng-container *ngIf="currentSchool && !isCityFallback && localResultsCount === 0 && cityCount > 0">{{ 'search.foundCountNoneAtSchoolCity' | t:{school: currentSchoolLabel, n: totalCount, city: searchCityLabel, c: cityCount} }}</ng-container>
            <ng-container *ngIf="currentSchool && !isCityFallback && localResultsCount === 0 && cityCount === 0">{{ 'search.foundCountNoneAtSchool' | t:{school: currentSchoolLabel, n: totalCount} }}</ng-container>
            <ng-container *ngIf="!currentSchool">{{ 'search.foundCountAll' | t:{n: totalCount} }}</ng-container>
          </p>

          <!-- Nothing searched or filtered → recent listings. Only once the
               URL's parameters and the school are in: before that activeQuery
               is still empty, and the grid used to fetch "all schools" for a
               page that turned out to be a search. -->
          <ng-container *ngIf="paramsReady && !searching">
            <!-- Before a search: the visitor's recent searches and a few
                 popular ones, as a search screen in an app offers. -->
            <section class="suggestions" *ngIf="recentSearches.items().length > 0">
              <div class="suggestions-head">
                <h2 class="suggestions-title">{{ 'search.recentSearches' | t }}</h2>
                <button type="button" class="suggestions-clear" (click)="recentSearches.clear()">{{ 'search.clearRecent' | t }}</button>
              </div>
              <ul class="recent-list">
                <li *ngFor="let q of recentSearches.items()">
                  <button type="button" class="recent-query" (click)="searchFor(q)">{{ q }}</button>
                  <button type="button" class="recent-remove" (click)="recentSearches.remove(q)" [attr.aria-label]="'search.removeRecent' | t:{q: q}">×</button>
                </li>
              </ul>
            </section>
            <section class="suggestions">
              <h2 class="suggestions-title">{{ 'search.popularSearches' | t }}</h2>
              <div class="popular-list">
                <button type="button" class="popular-chip" *ngFor="let key of popularSearchKeys" (click)="searchForKey(key)">{{ key | t }}</button>
              </div>
            </section>
            <ui-recent-listings [school]="currentSchool"></ui-recent-listings>
          </ng-container>

          <ui-bottom-sheet *ngIf="scanning" [title]="'search.scanBarcode' | t" (closed)="closeScanner()">
            <ui-barcode-scanner (decoded)="onScanned($event)" (failed)="onScannerFailed()"></ui-barcode-scanner>
            <p class="scan-hint" [class.error]="scanError">{{ scanError || ('search.scanHint' | t) }}</p>
          </ui-bottom-sheet>

          <!-- Loading state with animation -->
          <ng-container *ngIf="loading">
            <ui-skeleton variant="discover-grid" [count]="8"></ui-skeleton>
          </ng-container>

          <!-- Results loaded successfully -->
          <ng-container *ngIf="!loading && !fetchError">
            <div *ngIf="filteredResults.length > 0" class="discover-grid has-feature">
              <ui-book-tile
                *ngFor="let item of filteredResults; let i = index"
                [class.feature-tile]="i === 0"
                [coverUrl]="item.coverUrl"
                [title]="item.title"
                [author]="item.author"
                [isbn]="item.isbn"
                [feature]="i === 0"
                [mode]="item.activeListings > 0 ? 'sellers' : 'waitlist'"
                [minPrice]="item.minPrice"
                [sellerCount]="item.activeListings"
                [waitingCount]="item.waitlistCount"
                [link]="['/book']"
                [linkParams]="bookLinkParams(item)"
                [linkState]="previewState"
                (tileClick)="goToBook(item)"
              >
                <div tile-actions class="tile-actions-inner">
                  <ng-container *ngIf="item.activeListings === 0">
                    <ui-button *ngIf="!item.is_subscribed" variant="ghost" (onClick)="$event.stopPropagation(); subscribeBook(item)">{{ 'search.notifyMe' | t }}</ui-button>
                    <ui-button *ngIf="item.is_subscribed" variant="ghost"  style="color: var(--muted); border-color: var(--muted);" (onClick)="$event.stopPropagation(); unsubscribeBook(item)">{{ 'search.cancelNotify' | t }}</ui-button>
                  </ng-container>
                  <ng-container *ngIf="item.activeListings > 0">
                    <ui-button>{{ 'search.viewAll' | t }}</ui-button>
                    <span class="local-badge" *ngIf="currentSchool && item.localActiveListings === 0">
                      <ng-container *ngIf="item.cityActiveListings > 0">{{ 'search.inCity' | t:{city: searchCityLabel} }}</ng-container>
                      <ng-container *ngIf="!(item.cityActiveListings > 0)">{{ 'search.noLocalListings' | t:{school: currentSchoolLabel} }}</ng-container>
                    </span>
                  </ng-container>
                </div>
              </ui-book-tile>
            </div>

            <ui-pagination *ngIf="!isPhone && totalCount > 20" [total]="totalCount" [pageSize]="20" [currentPage]="currentPage" (pageChange)="onPageChange($event)"></ui-pagination>
            <ui-infinite-scroll *ngIf="isPhone && filteredResults.length > 0" [loading]="loadingMore" [hasMore]="hasMoreResults" [error]="loadMoreError" (loadMore)="onLoadMore()"></ui-infinite-scroll>

            <div *ngIf="results.length === 0 && activeQuery" class="empty-state">
              <h3>{{ 'search.notFound' | t }}</h3>
              <p>{{ 'search.notFoundDesc' | t }}</p>
            </div>

            <div *ngIf="filteredResults.length === 0 && (results.length > 0 || (searching && !activeQuery))" class="empty-state">
              <h3>{{ 'search.noFilterMatch' | t }}</h3>
              <p>{{ 'search.adjustFilters' | t }}</p>
            </div>
          </ng-container>

          <!-- Error state after load failure -->
          <div class="error-box" *ngIf="!loading && fetchError">
            <h3>{{ 'search.errorTitle' | t }}</h3>
            <p>{{ 'search.errorDesc' | t }}</p>
            <ui-button variant="ghost" (onClick)="fetchResults()">{{ 'common.retry' | t }}</ui-button>
          </div>
        </main>
      </div>
    </ui-pull-to-refresh>
  `,
  styles: [`
    /* The band is full-bleed and its inner element carries .container, so the
       gutter is the shared one rather than a second 16px added on top of it. */
    .search-header { background-color: var(--paper-warm); border-bottom: 1px solid var(--line); padding-block: 24px; margin-bottom: 32px; }
    .header-inner { display: flex; gap: 8px; }
    .phone-search-field { width: 100%; }
    .search-page-input-wrap { position: relative; width: 400px; max-width: 100%; }
    .search-page-input-wrap .search-icon { position: absolute; left: 2px; bottom: 10px; color: var(--muted); pointer-events: none; }
    .search-page-input { display: inline-block !important; width: 100%; }
    .search-page-input ::ng-deep .input-wrapper { margin-bottom: 0; }
    .search-page-input ::ng-deep input {
      border: none;
      border-bottom: 1.5px solid var(--ink);
      border-radius: 0;
      background: none;
      padding-left: 24px;
      font-size: var(--text-md);
    }
    .search-page-input ::ng-deep input:focus {
      border-bottom-color: var(--accent);
      box-shadow: none;
    }
    .search-button { flex-shrink: 0; }
    /* Layout only. This used to redeclare .container at 1120px, which with
       border-box padding yields a 1088px column — 16px narrower than the
       header above it, so the filter rail started 16px inside the logo. */
    .search-layout { display: flex; gap: 48px; }
    .filter-toggle { display: none; }
    /* Before a search: recent and popular searches. */
    .suggestions { margin-bottom: var(--space-6); }
    .suggestions-head { display: flex; align-items: baseline; justify-content: space-between; }
    .suggestions-title { margin: 0 0 var(--space-3); font-size: var(--text-base); font-weight: 600; color: var(--ink); }
    .suggestions-clear { background: none; border: none; padding: 4px 0; color: var(--muted); font: inherit; font-size: var(--text-sm); cursor: pointer; }
    .recent-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
    .recent-list li { display: flex; align-items: center; border-bottom: 1px solid var(--line); }
    .recent-query { flex: 1; min-width: 0; min-height: 44px; padding: 0 4px; background: none; border: none; font: inherit; color: var(--ink); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .recent-remove { flex-shrink: 0; width: 44px; height: 44px; background: none; border: none; color: var(--muted); font-size: var(--text-lg); cursor: pointer; }
    .popular-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .popular-chip { min-height: 36px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 18px; background: var(--paper); font: inherit; color: var(--ink); cursor: pointer; }
    .scan-hint { margin: 12px 8px 4px; text-align: center; color: var(--muted); font-size: var(--text-sm); }
    .scan-hint.error { color: var(--flag); }
    .sidebar { width: 240px; flex-shrink: 0; }
    .filter-group { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
    .filter-group:last-of-type { border-bottom: none; }
    .filter-title { font-size: var(--text-base); font-weight: 500; margin-top: 0; margin-bottom: 12px; color: var(--ink); }
    .filter-label { display: block; margin-bottom: 12px; font-size: var(--text-base); color: var(--ink); cursor: pointer; }
    .filter-label input { margin-right: 8px; }
    .fallback-hint { margin: 0 0 16px; font-size: var(--text-xs); color: var(--flag); }
    .price-range { display: flex; gap: 8px; align-items: center; }
    /* Price stays a plain numeric range, not a facet list — strip ui-input's
       boxed border for an underline look consistent with the lighter facet
       treatment above it. */
    .price-input { width: 80px; }
    .price-input ::ng-deep .input-wrapper { margin-bottom: 0; }
    .price-input ::ng-deep input { border: none; border-bottom: 1px solid var(--line); border-radius: 0; padding: 4px 0; background: transparent; }
    .price-input ::ng-deep input:focus { border-color: var(--accent); }
    .results { flex: 1; }
    .scoped-count { margin: -16px 0 24px; font-size: var(--text-base); color: var(--muted); }
    .fallback-link {
      display: inline-flex; align-items: center; min-height: var(--tap-min); padding: 0 var(--space-1);
      border: 0; background: none; font: inherit; color: var(--ink); text-decoration: underline; cursor: pointer;
    }

    .tile-actions-inner { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 8px; }
    .local-badge { display:inline-block; padding:4px 8px; font-size: var(--text-xs); font-weight:500; color:var(--danger); background-color:var(--danger-light); border-radius:4px; }

    .error-box { padding: 32px 24px; text-align: center; border: 1px solid var(--flag); border-radius: var(--radius-sm); background-color: var(--warn-bg); }
    .error-box h3 { margin-top: 0; margin-bottom: 12px; color: var(--warn-ink); }
    .error-box p { color: var(--muted); margin-bottom: 24px; }

    @media (max-width: 1024px) {
      .header-inner { flex-wrap:wrap; } .search-page-input-wrap { flex:1; width:auto; min-width:200px; }
    }
    /* Phones (the app's 900px breakpoint, core/viewport.ts): filters open as a
       bottom sheet, and a pill-shaped search field replaces the desktop header. */
    @media (max-width: 900px) {
      /* No band: the pill carries its own fill and border, and sits on the
         page as it does on the phone home page, so the two screens match. */
      .search-header { background-color: transparent; border-bottom: none; padding-block: var(--space-3) 0; margin-bottom: var(--space-4); }
      .search-layout { flex-direction:column; gap:0; }
      /* --line-strong, not --line: this is a real button, i.e. an
         interactive boundary, and --line is 1.48:1 — below the 3:1
         WCAG 1.4.11 asks of non-text UI. */
      .filter-toggle { display:flex; align-items:center; justify-content:space-between; width:100%; padding:12px 16px; margin-bottom:16px; border:1px solid var(--line-strong); border-radius:4px; background-color:var(--paper); color:var(--ink); font-size: var(--text-base); font-weight:500; font-family:inherit; cursor:pointer; }
      .filter-toggle-caret { flex-shrink:0; margin-left:auto; color:var(--muted); }
      .filter-count { margin-left:8px; min-width:20px; height:20px; padding:0 6px; border-radius:10px; background-color:var(--btn-primary-bg); color:var(--btn-primary-ink); font-size:var(--text-xs); line-height:20px; text-align:center; }
      .sidebar { display:none; }
      .sheet-filters { padding: 8px 8px 0; }
      .sheet-filters .filter-group { margin-bottom:20px; padding-bottom:20px; }
      .sheet-footer { flex: 1; }
    }
  `]
})
export class Search implements OnInit {
  searchQuery = ''; activeQuery = ''; category = ''; course = '';
  engine: SearchEngine | null = null;
  googleUnavailable = false;
  /** Browsing a category reads the local catalogue up to a cap; past it the
   *  pages simply stop, so say so rather than let the list end unexplained. */
  resultsTruncated = false;
  loading = true; fetchError = false;
  filtersOpen = false;
  /** Whether the URL asks for a list of books — a keyword, category, course
   *  or listing filter — rather than the search screen's suggestions. */
  searching = false;

  /** How many filters narrow the results, shown on the phone Filters button
   *  so a filtered list isn't mistaken for everything there is. */
  get activeFilterCount(): number {
    return [
      Object.values(this.conditionFilters).some(on => !on),
      !!this.category,
      !!this.course,
      this.stockFilter !== 'all',
      !!(this.priceMin || this.priceMax),
    ].filter(Boolean).length;
  }
  results: any[] = []; categories: any[] = []; courses: CourseFacet[] = []; currentSchool = ''; currentPage = 1; totalCount = 0;
  private isPhoneSignal = injectIsPhone();
  get isPhone(): boolean { return this.isPhoneSignal(); }
  set isPhone(v: boolean) { this.isPhoneSignal.set(v); }
  refreshing = false;

  @ViewChild(UiRecentListings) recentListings?: UiRecentListings;

  get loadingMore(): boolean { return this.pager.loading; }
  get loadMoreError(): boolean { return this.pager.error; }
  get hasMoreResults(): boolean { return this.pager.hasMore; }
  get loadedPhonePage(): number { return this.pager.loadedPage; }
  /** Set once the query parameters and the opening school have both arrived. */
  paramsReady = false;
  private searchSub?: Subscription;
  /** 上一次真的送進 API 的那組欄位。網址變了但這組沒變（例如只換了 engine
   *  以外的顯示狀態）就不重打一次回傳完全相同的請求。 */
  private lastFetchKey?: string;

  get currentSchoolLabel(): string {
    return this.schoolStateService.getSchoolLabel(this.currentSchool);
  }

  get categoryOptions() {
    return [
      { label: this.i18n.t('search.allCategories'), value: '' },
      ...this.categories.map(c => ({ label: c.title, value: c.slug }))
    ];
  }

  get courseOptions(): Array<{ label: string; value: string; count?: number }> {
    return [
      { label: this.i18n.t('search.allCourses'), value: '' },
      ...this.courses.map(c => ({ label: c.value, value: c.value, count: c.count }))
    ];
  }

  conditionFilters = { new: true, like_new: true, noted: true, damaged: true };
  stockFilter: 'all' | 'inStock' = 'all';
  priceMin = ''; priceMax = '';

  get stockOptions() {
    return [
      { label: this.i18n.t('search.all'), value: 'all' },
      { label: this.i18n.t('search.inStockOnly'), value: 'inStock' }
    ];
  }

  get conditionFacetOptions(): FacetOption[] {
    return [
      { label: this.i18n.t('cond.new'), value: 'new', selected: this.shownFilters.conditions.includes('new') },
      { label: this.i18n.t('cond.like_new'), value: 'like_new', selected: this.shownFilters.conditions.includes('like_new') },
      { label: this.i18n.t('cond.noted'), value: 'noted', selected: this.shownFilters.conditions.includes('noted') },
      { label: this.i18n.t('cond.damaged'), value: 'damaged', selected: this.shownFilters.conditions.includes('damaged') },
    ];
  }

  toggleCondition(value: string) {
    const key = value as ConditionKey;
    if (!CONDITION_KEYS.includes(key)) return;
    // 刻意不直接改 conditionFilters：勾選狀態一律由網址還原回來，元件自己先
    // 改一份會讓兩邊各有一個真相，重整後又對不起來。
    const shown = this.shownFilters.conditions;
    const next = shown.includes(key) ? shown.filter(k => k !== key) : [...shown, key];
    this.changeFilters({ conditions: CONDITION_KEYS.filter(k => next.includes(k)) });
  }

  onStockChange(value: 'all' | 'inStock') {
    this.changeFilters({ inStock: value === 'inStock' });
  }

  /**
   * Phones: the filters chosen in the open sheet, not yet applied. While it
   * is set the filter controls show and change it instead of the URL, so the
   * results behind the sheet stay as they were until Show results.
   */
  filterDraft: FilterDraft | null = null;
  /** The category whose courses the course filter lists, while a draft
   *  has picked one the URL doesn't have yet. */
  private draftCategory$ = new Subject<string>();

  /** What the filter controls show: the sheet's draft, or what is applied. */
  get shownFilters(): FilterDraft {
    return this.filterDraft ?? {
      conditions: CONDITION_KEYS.filter(k => this.conditionFilters[k]),
      category: this.category,
      course: this.course,
      inStock: this.stockFilter === 'inStock',
      priceMin: this.priceMin,
      priceMax: this.priceMax,
    };
  }

  /** Applies a filter change at once (sidebar), or to the sheet's draft. */
  private changeFilters(patch: Partial<FilterDraft>) {
    if (!this.filterDraft) {
      this.navigateWithState(patch);
      return;
    }
    this.filterDraft = { ...this.filterDraft, ...patch };
    if (patch.category !== undefined) this.draftCategory$.next(patch.category);
  }

  openFilters() {
    this.filterDraft = { ...this.shownFilters };
    this.filtersOpen = true;
  }

  applyFilters() {
    const draft = this.filterDraft;
    this.filterDraft = null;
    this.filtersOpen = false;
    if (!draft) return;
    this.navigateWithState({
      ...draft,
      priceMin: this.normalizePrice(draft.priceMin),
      priceMax: this.normalizePrice(draft.priceMax),
    });
  }

  discardFilters() {
    if (this.filterDraft && this.filterDraft.category !== this.category) this.draftCategory$.next(this.category);
    this.filterDraft = null;
    this.filtersOpen = false;
  }

  setPrice(field: 'priceMin' | 'priceMax', value: string) {
    if (this.filterDraft) this.filterDraft = { ...this.filterDraft, [field]: value };
    else this[field] = value;
  }

  /** 價格改由 blur / Enter 提交，見樣板中的說明。草稿中的價格則等按下
   *  Show results 才一起套用。 */
  commitPriceRange() {
    if (this.filterDraft) return;
    const min = this.normalizePrice(this.priceMin);
    const max = this.normalizePrice(this.priceMax);
    const current = this.route.snapshot.queryParams;
    // 只是點進點出輸入框不算改條件。少了這道判斷，使用者在第 3 頁碰一下價格
    // 欄就會因為「改條件回第 1 頁」的規則被丟回第 1 頁。
    if (min === (current['price_min'] || '') && max === (current['price_max'] || '')) return;
    this.navigateWithState({ priceMin: min, priceMax: max });
  }

  /** 只有真的是數字才進網址：打到一半的 "1a" 沒有篩選意義，寫進去只是噪音。 */
  private normalizePrice(value: string): string {
    const n = parseInt((value || '').trim(), 10);
    return isNaN(n) || n < 0 ? '' : String(n);
  }

  get categoryFacetOptions(): FacetOption[] {
    return this.categoryOptions.map(o => ({ label: o.label, value: o.value, selected: o.value === this.shownFilters.category }));
  }

  get courseFacetOptions(): FacetOption[] {
    return this.courseOptions.map(o => ({ label: o.label, value: o.value, count: o.count, selected: o.value === this.shownFilters.course }));
  }

  // Template getters run on every change-detection pass (each keystroke,
  // scroll and pointer move), and this one filters the whole result set.
  // Memoised on the inputs it actually reads: the results array identity and
  // the filter controls. `results` is only ever reassigned, never mutated in
  // place, so identity is a sound key.
  private filteredMemo: { results: any[]; key: string; value: any[] } | null = null;

  get filteredResults(): any[] {
    const key = `${this.stockFilter}|${this.priceMin}|${this.priceMax}|${JSON.stringify(this.conditionFilters)}`;
    if (this.filteredMemo && this.filteredMemo.results === this.results && this.filteredMemo.key === key) {
      return this.filteredMemo.value;
    }
    const allChecked = Object.values(this.conditionFilters).every(v => v);
    const min = parseInt(this.priceMin, 10);
    const max = parseInt(this.priceMax, 10);
    const filterPrice = !isNaN(min) || !isNaN(max);
    const value = this.results.filter(item => {
      const inStock = item.activeListings > 0;
      if (this.stockFilter === 'inStock' && !inStock) return false;
      if (filterPrice) {
        if (!inStock) return false;
        if (!isNaN(min) && (item.minPrice === null || item.minPrice === undefined || item.minPrice < min)) return false;
        if (!isNaN(max) && (item.minPrice === null || item.minPrice === undefined || item.minPrice > max)) return false;
      }
      if (!allChecked) {
        const checked = this.conditionFilters as Record<string, boolean>;
        const conds: string[] = item.conditions || [];
        if (!conds.some(c => checked[c])) return false;
      }
      return true;
    });
    this.filteredMemo = { results: this.results, key, value };
    return value;
  }

  /** Books with a copy at the school across every page, as the backend
   *  counts them; this page's own count only when it doesn't say. Counting
   *  just the page read "found 20" for every search longer than a page. */
  private localCount: number | null = null;

  get localResultsCount(): number {
    return this.localCount ?? this.filteredResults.filter(item => item.localActiveListings > 0).length;
  }

  /** 'city' when browsing found nothing at the school and fell back to its city. */
  private searchScope: string | null = null;
  /** Code of the school's city, from the response. */
  private searchCity: string | null = null;
  /** Books with a copy anywhere in the school's city, across every page. */
  cityCount = 0;

  get isCityFallback(): boolean {
    return this.searchScope === 'city';
  }

  get searchCityLabel(): string {
    return this.schoolStateService.getCityLabel(this.searchCity);
  }

  /** Leave the school for every university's books, as the header picker would. */
  showAllSchools() {
    this.schoolStateService.setManualSchool('');
  }

  private bookService = inject(BookService);
  private auth = inject(AuthStore);
  private cdr = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  readonly recentSearches = inject(RecentSearches);
  readonly popularSearchKeys = POPULAR_SEARCH_KEYS;
  private schoolStateService = inject(SchoolStateService);
  private metadataService = inject(MetadataService);
  private ga = inject(GoogleAnalyticsService);

  private regionLink = inject(RegionLinkService);
  private seo = inject(SeoService);

  readonly pager = new PhonePager<any>({
    fetchPage: (page) => this.bookService.searchBooks(
      this.activeQuery,
      this.category,
      this.course,
      this.schoolStateService.currentSchool,
      page,
      this.engine,
      this.listingFilterParams
    ).pipe(
      map(data => ({
        items: data.results || data || [],
        total: data.count || this.totalCount
      }))
    ),
    onAppend: (items) => {
      this.results = [...this.results, ...items];
    },
    currentCount: () => this.results.length,
    total: () => this.totalCount,
    cdr: this.cdr,
    destroyRef: this.destroyRef
  });

  constructor(private route: ActivatedRoute, private router: Router) {
    effect(() => { this.i18n.lang(); untracked(() => this.loadMetadata()); });
  }

  loadMetadata(onComplete?: () => void) {
    this.metadataService.getMetadata().subscribe({
      next: data => {
        if (data.categories) {
          this.categories = data.categories;
          this.cdr.markForCheck();
        }
      },
      error: err => {
        console.error('Failed to load metadata', err);
        onComplete?.();
      },
      complete: () => {
        onComplete?.();
      }
    });
  }

  ngOnInit() {

    this.schoolStateService.schools$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.cdr.markForCheck();
    });

    combineLatest([
      // resolvedSchool$: waits for the opening school rather than asking for
      // "all schools" first and then again for the settled one.
      this.schoolStateService.resolvedSchool$.pipe(distinctUntilChanged()),
      // The applied category, or the one picked in the filter sheet's draft,
      // so its course list matches the category chosen there.
      merge(
        this.route.queryParams.pipe(map(params => params['category'] || '')),
        this.draftCategory$
      ).pipe(distinctUntilChanged())
    ]).pipe(
      switchMap(([school, category]) => this.bookService.getTopCourses(school, category)),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: data => { this.courses = data; this.cdr.markForCheck(); },
      error: err => console.error('Failed to load courses', err)
    });

    // queryParams and selectedSchool$ both outlive this routed component, so
    // without this every visit to /search left another live subscription
    // calling markForCheck() on a destroyed view.
    combineLatest([this.route.queryParams, this.schoolStateService.resolvedSchool$]).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(([params, school]) => {
      this.paramsReady = true;
      this.currentSchool = school;
      this.restoreStateFromParams(params);
      this.describePage();

      // 只有真正送進 searchBooks() 的欄位變了才重查（書況／價格／庫存也在
      // 內：後端在分頁前篩，只在前端篩的話第 2 頁以後都沒篩到，而且沒有關鍵字
      // 時根本沒有資料可篩）。
      // 用 JSON 而不是 join()：關鍵字本身可能含有分隔字元，"a b" 配沒有分類
      // 和 "a" 配分類 "b" 會串成同一個 key，然後該重查的時候不重查。
      const fetchKey = JSON.stringify([school, this.activeQuery, this.category, this.course, this.engine, this.currentPage, this.listingFilterParams]);
      this.searching = !!(this.activeQuery || this.category || this.course) || Object.keys(this.listingFilterParams).length > 0;
      if (fetchKey === this.lastFetchKey) { this.cdr.markForCheck(); return; }
      this.lastFetchKey = fetchKey;

      if (this.searching) {
        this.fetchResults();
      } else {
        this.results = []; this.totalCount = 0; this.localCount = null; this.loading = false; this.fetchError = false;
        this.pager.reset(1, 0);
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Tab title and canonical for the search being shown. The canonical keeps
   * only what changes the result set — q, category, course — so filter,
   * paging and engine variants of one search are not indexed as separate
   * pages.
   */
  private describePage() {
    const queryParams: Record<string, string> = {};
    if (this.activeQuery) queryParams['q'] = this.activeQuery;
    if (this.category) queryParams['category'] = this.category;
    if (this.course) queryParams['course'] = this.course;
    const canonicalPath = this.router.serializeUrl(
      this.router.createUrlTree(this.regionLink.path(['/search']), { queryParams })
    );
    this.seo.setPage(this.activeQuery
      ? { titleKey: 'seo.searchTitle', titleParams: { q: this.activeQuery }, canonicalPath }
      : { titleKey: 'nav.search', canonicalPath });
  }

  /**
   * 網址 → 元件狀態。這條路徑只讀不導頁（navigate 一律由使用者操作的 handler
   * 發動），所以「寫入網址 → 訂閱觸發 → 還原狀態」不會繞回自己形成迴圈。
   */
  private restoreStateFromParams(params: Record<string, any>) {
    const q = params['q'] || '';
    // 只有 q 真的變了才覆寫輸入框。現在勾書況、改價格也會導頁，若無條件覆寫，
    // 使用者打到一半還沒按 Enter 的字會被自己按下的篩選吃掉。
    if (q !== this.activeQuery) {
      this.searchQuery = q;
      // Every way a search starts ends here (typed, the home hero, a
      // suggestion, a scan), so this is the one place it is remembered.
      if (q) this.recentSearches.add(q);
    }
    this.activeQuery = q;
    this.category = params['category'] || '';
    this.course = params['course'] || '';
    this.engine = parseSearchEngine(params['engine']);
    // 壞掉的 ?page=abc 當第 1 頁，別讓 NaN 一路傳到 API。
    // 手機版一律從第 1 頁開始，忽略 ?page（不改寫網址，桌機開同一連結仍看得到該頁）
    const pageParam = Math.max(1, parseInt(params['page'], 10) || 1);
    this.currentPage = this.isPhone ? 1 : pageParam;

    // 沒有 condition 參數＝四個全選＝不篩選；有參數就只認得出來的值，因此
    // 序列化時用的 'none' 會如預期還原成「一個都沒勾」。
    const raw = params['condition'];
    const picked: string[] = (raw === undefined || raw === null)
      ? [...CONDITION_KEYS]
      : String(raw).split(',').filter(v => (CONDITION_KEYS as string[]).includes(v));
    CONDITION_KEYS.forEach(k => { this.conditionFilters[k] = picked.includes(k); });

    this.priceMin = params['price_min'] || '';
    this.priceMax = params['price_max'] || '';
    this.stockFilter = params['in_stock'] === '1' ? 'inStock' : 'all';
    this.pager.reset(this.currentPage);
  }

  /** 目前畫面上完整的搜尋條件，navigateWithState() 以它為底。 */
  private get urlState(): SearchUrlState {
    return {
      q: this.activeQuery,
      category: this.category,
      course: this.course,
      engine: this.engine,
      page: this.currentPage,
      conditions: CONDITION_KEYS.filter(k => this.conditionFilters[k]),
      priceMin: this.normalizePrice(this.priceMin),
      priceMax: this.normalizePrice(this.priceMax),
      inStock: this.stockFilter === 'inStock',
    };
  }

  /**
   * 所有導頁的唯一入口：以目前完整狀態為底，只覆寫呼叫端指名的欄位。
   *
   * 沒有指名 page 就一律回到第 1 頁 —— 換了篩選條件之後第 3 頁的內容跟原本
   * 完全無關，留在第 3 頁只會看到空結果。這是刻意的決定，寫在這裡而不是散在
   * 各個 handler，才不會像以前那樣分不清是規則還是忘了帶 page。
   */
  private navigateWithState(patch: Partial<SearchUrlState>) {
    const state: SearchUrlState = { ...this.urlState, page: 1, ...patch };
    this.router.navigate(this.regionLink.path(['/search']), { queryParams: this.serializeState(state) });
  }

  /** 預設值不寫進網址：網址是要能貼給別人的，塞滿 page=1 之類的噪音只會讓人
   *  看不出哪些條件才是真的有在作用。engine 沒有預設值可省：寫了
   *  engine=googlebooks 就是只查 Google，跟不寫（依序換來源）意思不同。 */
  private serializeState(state: SearchUrlState): Record<string, string> {
    const params: Record<string, string> = {};
    if (state.q) params['q'] = state.q;
    if (state.category) params['category'] = state.category;
    if (state.course) params['course'] = state.course;
    if (state.engine) params['engine'] = state.engine;
    if (state.page > 1) params['page'] = String(state.page);
    if (state.conditions.length < CONDITION_KEYS.length) {
      params['condition'] = state.conditions.length ? state.conditions.join(',') : CONDITION_NONE;
    }
    if (state.priceMin) params['price_min'] = state.priceMin;
    if (state.priceMax) params['price_max'] = state.priceMax;
    if (state.inStock) params['in_stock'] = '1';
    return params;
  }

  /** The listing filters as the URL carries them, sent on to the API. */
  private get listingFilterParams(): Record<string, string> {
    const params = this.serializeState(this.urlState);
    const filters: Record<string, string> = {};
    for (const key of ['condition', 'price_min', 'price_max', 'in_stock']) {
      if (params[key]) filters[key] = params[key];
    }
    return filters;
  }

  fetchResults() {
    this.loading = true;
    this.fetchError = false;
    this.pager.reset(this.currentPage, this.totalCount);
    this.cdr.markForCheck();

    if (this.searchSub) {
      this.searchSub.unsubscribe();
    }

    this.searchSub = this.bookService.searchBooks(this.activeQuery, this.category, this.course, this.schoolStateService.currentSchool, this.currentPage, this.engine, this.listingFilterParams).subscribe({
      next: data => {
        this.results = data.results || data;
        this.totalCount = data.count || this.results.length;
        this.localCount = typeof data.local_count === 'number' ? data.local_count : null;
        this.searchScope = data.scope ?? null;
        this.searchCity = data.city ?? null;
        this.cityCount = typeof data.city_count === 'number' ? data.city_count : 0;
        this.googleUnavailable = !!data.google_unavailable;
        this.resultsTruncated = !!data.results_truncated;
        this.loading = false;
        this.fetchError = false;
        this.refreshing = false;
        this.pager.reset(this.currentPage, this.totalCount);
        if (this.activeQuery || this.category || this.course) {
          this.ga.trackSearch(this.activeQuery || `${this.category} ${this.course}`.trim(), this.totalCount, this.currentSchool);
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.fetchError = true;
        this.refreshing = false;
        // Keep any previously-loaded results showing (don't blank them)
        this.cdr.markForCheck();
      }
    });
  }

  onRefresh() {
    this.refreshing = true;
    this.pager.reset(1);
    if (this.searching) {
      if (this.isPhone) {
        this.currentPage = 1;
      }
      this.fetchResults();
    } else {
      let pending = 1;
      const checkDone = () => {
        pending--;
        if (pending <= 0) {
          this.refreshing = false;
          this.cdr.markForCheck();
        }
      };
      if (this.recentListings) {
        pending++;
        this.recentListings.reload(checkDone);
      }
      this.loadMetadata(checkDone);
    }
  }

  onLoadMore() {
    this.pager.loadMore();
  }

  /** 換頁是唯一「不重設 page」的操作，所以它是唯一要明講 page 的呼叫端。 */
  onPageChange(page: number) {
    this.navigateWithState({ page });
  }

  /** The barcode scanner sheet (phones): scan a book to search its ISBN. */
  scanning = false;
  scanError = '';

  openScanner() {
    this.scanError = '';
    this.scanning = true;
  }

  closeScanner() {
    this.scanning = false;
    this.scanError = '';
  }

  onScanned(decodedText: string) {
    const isbn = isbnFromScan(decodedText);
    if (!isbn) {
      // Keep scanning: the reader may simply have caught another code.
      this.scanError = this.i18n.t('sell.invalidBarcodeScanned');
      this.cdr.markForCheck();
      return;
    }
    this.closeScanner();
    this.searchFor(isbn);
  }

  onScannerFailed() {
    this.closeScanner();
    this.toast.error(this.i18n.t('sell.cameraPermission'));
  }

  /** Runs a remembered search. */
  searchFor(query: string) {
    this.searchQuery = query;
    this.onSearch();
  }

  /** Runs a popular search, given as an i18n key. */
  searchForKey(key: string) {
    this.searchFor(this.i18n.t(key));
  }

  onSearch(query?: string) {
    if (typeof query === 'string') {
      this.searchQuery = query;
    }
    const q = this.searchQuery.trim();
    // 保留 category / course：在某個分類底下再打關鍵字，使用者的預期是
    // 「在這個分類裡找」，而不是被丟回全站搜尋。
    if (q) this.navigateWithState({ q });
  }

  onCategoryChange(cat: string) {
    // course 仍然刻意清掉：課程清單是依 category 重新載入的，換了分類之後
    // 舊課程多半不在新清單裡，留著會變成一個選不掉的隱形條件。
    this.changeFilters({ category: cat, course: '' });
  }

  onCourseChange(course: string) {
    this.changeFilters({ course });
  }

  /** Route params for a result tile; the tile's own anchor does the navigating. */
  /** Lets the book page show what goToBook() stashed; carried outside the URL. */
  readonly previewState = bookPreviewState();

  bookLinkParams(item: any): Record<string, any> {
    const params: Record<string, any> = bookQueryParams(item);
    // Belt-and-suspenders alongside goToBook()'s sessionStorage priming:
    // if the cache entry is missing (cleared tab, private browsing) the
    // book page falls back to a live lookup, which must use the same
    // engine this tile's data came from — otherwise the two pages can show
    // different covers/titles for the same ISBN. Read off the result, not
    // this.engine: without an engine the backend picks the source per
    // search, so one found in the ISBN registry would otherwise be looked
    // up again in Google.
    const engine = engineForSource(item.source);
    if (engine) params['engine'] = engine;
    return params;
  }

  /** Cache priming only — must not navigate, or the anchor fires twice. */
  goToBook(item: any) {
    const key = item.isbn || item.id; if (!key) return;
    if (typeof sessionStorage !== 'undefined') {
      try { sessionStorage.setItem(`cachedBook_${key}`, JSON.stringify(item)); }
      catch (e) { /* ok — cache is optional */ }
    }
  }

  subscribeBook(item: any) {
    if (!this.auth.isLoggedIn()) {
      this.toast.info(this.i18n.t('alert.loginToSubscribe')); this.router.navigate(this.regionLink.path(['/login'])); return;
    }
    const doSubscribe = (id: string) => {
      this.bookService.subscribe(id).subscribe({
        next: res => {
          this.ga.trackRequestBook(id, 'search');
          this.toast.success(this.i18n.t('alert.subscribed'));
          item.waitlistCount++; item.is_subscribed = true; item.subscription_id = res.id; item.id = id;
          this.cdr.markForCheck();
        },
        error: () => this.toast.error(this.i18n.t('alert.unsubscribeFailed'))
      });
    };
    if (item.id) { doSubscribe(item.id); } else {
      const bookData = { isbn13: item.isbn || '', title: item.title, authors: item.author || '', publisher: item.publisher || '', published_date: item.published_date || '', cover_url: item.coverUrl || '', source: item.source || 'manual' };
      this.bookService.createManualBook(bookData).subscribe({
        next: created => doSubscribe(created.id),
        error: () => this.toast.error(this.i18n.t('alert.subscribeFailed'))
      });
    }
  }

  unsubscribeBook(item: any) {
    if (item.subscription_id) {
      this.bookService.unsubscribe(item.subscription_id).subscribe({
        next: () => {
          this.toast.success(this.i18n.t('alert.unsubscribed'));
          item.waitlistCount--; item.is_subscribed = false; item.subscription_id = null;
          this.cdr.markForCheck();
        },
        error: () => this.toast.error(this.i18n.t('alert.unsubscribeFailed'))
      });
    }
  }
}
