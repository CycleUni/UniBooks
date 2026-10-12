import { Component, inject, OnInit, ChangeDetectorRef, DestroyRef } from '@angular/core';
import { RegionService } from '../../core/region.service';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { UiListingRow } from '../../shared/ui/listing-row.component';
import { UiDropdown, DropdownOption } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiPullToRefresh } from '../../shared/ui/pull-to-refresh.component';
import { UiInfiniteScroll } from '../../shared/ui/infinite-scroll.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { injectIsPhone } from '../../core/viewport';
import { PhonePager } from '../../core/phone-pager';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { ListingService } from '../../core/services/listing.service';
import { MetadataService } from '../../core/services/metadata.service';

import { AccountService } from '../../core/services/account.service';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { parseApiError } from '../../core/api-error.util';
import { SELL_MAX_PHOTOS } from '../sell/sell';
import { firstValueFrom, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * The photos an edit starts from: the listing's whole `photos` list, since
 * saving sends the list back as-is. Not trimmed to SELL_MAX_PHOTOS — a listing
 * that already has more (the backend allows 6) keeps them unless the seller
 * removes some; the cap only stops new ones being added. `photo_url` (the
 * cover alone) is just a fallback for a payload without the list.
 */
export function editablePhotos(listing: { photos?: unknown; photo_url?: string | null }): string[] {
  if (Array.isArray(listing.photos)) {
    return listing.photos.filter((url): url is string => typeof url === 'string' && url.length > 0);
  }
  return listing.photo_url ? [listing.photo_url] : [];
}

/** Tabs, in the order a seller cares about them. '' is "everything". */
const STATUSES = ['', 'active', 'reserved', 'sold', 'removed'] as const;
type StatusTab = typeof STATUSES[number];

const SORTS = ['newest', 'oldest', 'price_desc', 'price_asc'] as const;
type ListingSort = typeof SORTS[number];

const PAGE_SIZE = 20;

@Component({
  selector: 'app-account-listings',
  standalone: true,
  imports: [
    CommonModule, FormsModule, UiButton, UiEmpty, UiInput, UiTextarea, UiListingRow, UiDropdown,
    UiPagination, UiPullToRefresh, UiInfiniteScroll, UiSearchBarComponent, UiSkeleton, UiErrorState, TPipe,
  ],
  template: `
    <ui-pull-to-refresh [refreshing]="refreshing" (refresh)="onRefresh()">
      <div class="section-head-row">
      <h2 class="section-heading">{{ 'acct.tabListings' | t }}</h2>
      <div class="section-head-actions">
        <ui-dropdown
          [label]="'acct.sortBy' | t"
          [inlineLabel]="true"
          [compact]="true"
          [options]="sortOptions"
          [searchable]="false"
          [ngModel]="sort"
          (ngModelChange)="onSortChange($event)"
        ></ui-dropdown>
        <ui-button (onClick)="goToSell()">+ {{ 'acct.addListing' | t }}</ui-button>
      </div>
    </div>

    <!-- One tab per status, labelled with how many are in it, so "what is
         still up for sale" is one tap rather than a scroll through sold ones. -->
    <div class="status-tabs" role="tablist" [attr.aria-label]="'acct.filterByStatus' | t">
      <button
        *ngFor="let tab of statuses"
        type="button"
        role="tab"
        class="status-tab"
        [class.active]="tab === status"
        [attr.aria-selected]="tab === status"
        (click)="onStatusChange(tab)"
      >{{ tabLabel(tab) | t }} <span class="tab-count">{{ counts[tab || 'all'] ?? 0 }}</span></button>
    </div>

    <ui-search-bar
      class="list-search"
      [placeholder]="'acct.searchListings' | t"
      [value]="searchQuery"
      (search)="onSearchQuery($event)">
    </ui-search-bar>

    <p class="result-note" *ngIf="!loading && myListings.length > 0">
      {{ 'acct.listingCount' | t:{ n: totalListings } }}
    </p>

    <ui-skeleton *ngIf="loading" [count]="3"></ui-skeleton>

    <div class="list-container" *ngIf="!loading && myListings.length > 0">
      <ui-listing-row
        *ngFor="let item of myListings"
        [id]="item.id"
        [title]="item.book_title"
        [titleLink]="['/listing', item.id]"
        [price]="item.price"
        [condition]="item.condition"
        [status]="item.status"
        [adminLocked]="item.admin_locked"
        [adminLockReason]="item.admin_lock_reason"
        [isEditable]="true"
        (action)="onListingAction($event)"
        [metaInfo]="item.isbn ? 'ISBN: ' + item.isbn : ''"
        [courseInfo]="courseLine(item)"
        [listedAt]="(item.created_at | date: 'yyyy/MM/dd') || ''"
        [coverUrl]="item.photo_url || item.book_cover_url"
      ></ui-listing-row>
    </div>

    <ui-error-state
      *ngIf="!loading && loadFailed && myListings.length === 0"
      [message]="'acct.errLoadFailed' | t"
      (retry)="loadMyListings()"
    ></ui-error-state>

    <ui-empty
      *ngIf="!loading && !loadFailed && myListings.length === 0"
      [message]="(hasFilters ? 'acct.noListingsMatch' : 'acct.noListings') | t"
      [actionText]="(hasFilters ? 'acct.clearFilters' : 'acct.addListing') | t"
      (onAction)="hasFilters ? clearFilters() : goToSell()"
    ></ui-empty>

    <ui-pagination
      *ngIf="!isPhone && totalListings > pageSize"
      [total]="totalListings"
      [pageSize]="pageSize"
      [currentPage]="currentPage"
      (pageChange)="onPageChange($event)"
    ></ui-pagination>

    <ui-infinite-scroll
      *ngIf="isPhone && !loading && myListings.length > 0"
      [loading]="loadingMore"
      [hasMore]="hasMoreListings"
      [error]="loadMoreError"
      (loadMore)="onLoadMore()"
    ></ui-infinite-scroll>
    </ui-pull-to-refresh>

    <!-- Edit Modal Overlay -->
    <div class="edit-modal" *ngIf="editingListing">
      <div class="modal-overlay" (click)="closeEdit()"></div>
      <div class="modal-content app-modal">
        <h3 class="app-modal-title">{{ 'acct.editTitle' | t }}</h3>

        <div class="modal-body app-modal-body">
          <p class="edit-book">{{ editingListing.book_title }}</p>

          <!-- What a seller actually comes here to change. -->
          <ui-input
            type="number"
            [label]="'acct.priceLabel' | t:{currency: regionService.currency().symbol}"
            [(ngModel)]="editForm.price"
            class="mb-4"
          ></ui-input>
          <ui-dropdown [label]="'common.condition' | t" [(ngModel)]="editForm.condition" [options]="conditionOptions" [searchable]="false" class="mb-4"></ui-dropdown>
          <ui-dropdown [label]="'acct.statusLabel' | t" [(ngModel)]="editForm.status" [options]="statusOptions" [searchable]="false" class="mb-4"></ui-dropdown>

          <!-- Every photo the listing carries, not just the cover: saving sends
               this whole list back, so showing only the first one meant an
               edit quietly dropped the rest. -->
          <div class="photo-upload mb-4">
            <label class="photo-label">
              {{ 'acct.photoLabel' | t }}
              <span class="photo-count">{{ editForm.photos?.length ?? 0 }}/{{ maxPhotos }}</span>
            </label>
            <div class="photo-grid" *ngIf="editForm.photos?.length">
              <div class="photo-preview" *ngFor="let url of editForm.photos; let i = index">
                <img [src]="url" loading="lazy" alt="" />
                <button class="delete-photo-btn" type="button" (click)="removePhoto(i)" [title]="'common.delete' | t" [attr.aria-label]="'common.delete' | t">✕</button>
              </div>
            </div>
            <div *ngIf="editForm.photos.length < maxPhotos || isUploadingPhoto">
              <input type="file" accept="image/*" multiple (change)="onFileSelected($event)" #fileInput style="display: none;" />
              <ui-button variant="ghost" (onClick)="fileInput.click()" [disabled]="isUploadingPhoto">{{ (isUploadingPhoto ? 'sell.uploading' : 'acct.uploadPhoto') | t }}</ui-button>
            </div>
            <div *ngIf="photoError" class="photo-error" role="alert">{{ photoError }}</div>
          </div>

          <!-- Everything else, folded away: filled in once when listing,
               rarely touched again. -->
          <details class="more" [open]="showAdvanced">
            <summary (click)="showAdvanced = !showAdvanced">{{ 'acct.moreFields' | t }}</summary>
            <div class="more-body">
              <div *ngIf="editingListing.book_source === 'manual'" class="manual-book-edit mb-4">
                <p class="manual-note">{{ 'acct.manualBookDesc' | t }}</p>
                <ui-input [label]="'acct.bookTitleLabel' | t" [(ngModel)]="editForm.book_title" class="mb-3"></ui-input>
                <ui-input [label]="'acct.bookAuthorsLabel' | t" [(ngModel)]="editForm.book_authors" class="mb-3"></ui-input>
                <ui-input [label]="'acct.isbnLabel' | t" [(ngModel)]="editForm.isbn"></ui-input>
              </div>

              <ui-dropdown [label]="'sell.categoryLabel' | t" [(ngModel)]="editForm.category" [options]="categoryOptions" class="mb-4"></ui-dropdown>
              <ui-input [label]="'sell.courseLabel' | t" [(ngModel)]="editForm.course_name" class="mb-4"></ui-input>
              <ui-input [label]="'sell.professorLabel' | t" [(ngModel)]="editForm.professor_name" class="mb-4"></ui-input>
              <ui-textarea [label]="'sell.descriptionLabel' | t" [(ngModel)]="editForm.description" [rows]="3" class="mb-4"></ui-textarea>
              <ui-textarea [label]="'sell.privateNoteLabel' | t" [(ngModel)]="editForm.private_note" [rows]="2"></ui-textarea>
            </div>
          </details>
        </div>
        <div class="actions app-modal-actions modal-footer-actions">
          <ui-button variant="ghost" class="text-danger" (onClick)="onDelete(editingListing.id)">{{ 'common.delete' | t }}</ui-button>
          <div class="modal-footer-right">
            <ui-button variant="ghost" (onClick)="closeEdit()">{{ 'common.cancel' | t }}</ui-button>
            <ui-button [disabled]="saving" (onClick)="submitEdit()">{{ (saving ? 'acct.saving' : 'acct.save') | t }}</ui-button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .status-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .status-tab {
      appearance: none; background: none; border: none; cursor: pointer;
      padding: 8px 12px; margin-bottom: -1px; font: inherit; font-size: var(--text-base);
      color: var(--muted); border-bottom: 2px solid transparent;
    }
    .status-tab:hover { color: var(--ink); }
    .status-tab.active { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
    .status-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .tab-count { color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 400; }
    .status-tab.active .tab-count { color: var(--accent); }

    .list-search { display: block; margin-bottom: 8px; }
    .result-note { margin: 0 0 8px; font-size: var(--text-sm); color: var(--muted); }

    .edit-modal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
    }
    .modal-content {
      position: relative;
      width: 100%;
      max-width: 420px;
      z-index: 1001;
    }
    .edit-book { margin: 0 0 16px; color: var(--muted); overflow-wrap: anywhere; word-break: break-word; }
    .photo-label { display: block; margin-bottom: 8px; font-weight: 500; font-size: var(--text-base); }
    .photo-count { margin-left: 6px; font-weight: 400; font-size: var(--text-sm); color: var(--muted); font-variant-numeric: tabular-nums; }
    /* Fixed-width tracks that wrap: five fit on one row in the 420px dialog
       and fall to two rows on a phone rather than shrinking the thumbnails.
       The gap leaves room for each corner delete button. */
    .photo-grid { display: flex; flex-wrap: wrap; gap: 14px; margin: 8px 0 12px; }
    .photo-preview { position: relative; width: 60px; height: 84px; flex: none; }
    .photo-preview img { display: block; width: 100%; height: 100%; object-fit: cover; border: 1px solid var(--line); border-radius: 4px; }
    .photo-error { margin-top: 8px; font-size: var(--text-sm); color: var(--danger); }
    .more { border-top: 1px solid var(--line); padding-top: 12px; }
    .more summary { cursor: pointer; color: var(--muted); font-size: var(--text-base); width: fit-content; }
    .more-body { padding-top: 16px; }
    .manual-book-edit { padding: 16px; border: 1px solid var(--line); border-radius: 4px; background-color: var(--paper-warm); }
    .manual-note { margin: 0 0 12px; font-weight: 500; font-size: var(--text-base); }
    .delete-photo-btn {
      position: absolute;
      top: -8px;
      right: -8px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background-color: var(--flag);
      color: var(--on-flag);
      border: none;
      font-size: var(--text-base);
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .delete-photo-btn:hover { opacity: 0.9; }
    .modal-footer-actions { justify-content: space-between; }
    .modal-footer-right { display: flex; gap: 8px; }
    @media (max-width: 768px) {
      .edit-modal { padding: 16px; }
    }
  `]
})
export class ListingsComponent implements OnInit {
  regionService = inject(RegionService);
  readonly statuses = STATUSES;
  readonly pageSize = PAGE_SIZE;

  myListings: any[] = [];
  counts: Record<string, number> = {};
  editingListing: any = null;
  editForm: any = {};
  showAdvanced = false;
  readonly maxPhotos = SELL_MAX_PHOTOS;
  /** Picked files not uploaded yet, counted against the cap like in sell.ts. */
  private pendingUploads = 0;
  photoError = '';
  isUploadingPhoto = false;
  saving = false;
  loading = true;
  /** The last load failed: an empty list here is unknown, not "none yet". */
  loadFailed = false;
  categoryOptions: any[] = [];
  totalListings = 0;
  currentPage = 1;
  private isPhoneSignal = injectIsPhone();
  get isPhone(): boolean { return this.isPhoneSignal(); }
  set isPhone(v: boolean) { this.isPhoneSignal.set(v); }
  refreshing = false;

  private destroyRef = inject(DestroyRef);
  private accountService = inject(AccountService);
  private listingService = inject(ListingService);
  private metadataService = inject(MetadataService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private regionLink = inject(RegionLinkService);
  readonly i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);

  readonly pager = new PhonePager<any>({
    fetchPage: (page) => this.accountService
      .getMyProfile(page, this.searchQuery, { status: this.status, sort: this.sort === 'newest' ? undefined : this.sort })
      .pipe(
        map((data: any) => {
          let items: any[] = [];
          let total = this.totalListings;
          if (data.myListings && !Array.isArray(data.myListings)) {
            items = data.myListings.results || [];
            total = data.myListings.count || total;
          } else {
            items = data.myListings || [];
          }
          if (data.myListingCounts) this.counts = data.myListingCounts;
          return { items, total };
        })
      ),
    onAppend: (items) => {
      this.myListings = [...this.myListings, ...items];
    },
    currentCount: () => this.myListings.length,
    total: () => this.totalListings,
    cdr: this.cdr,
    destroyRef: this.destroyRef
  });

  get loadingMore(): boolean { return this.pager.loading; }
  get loadMoreError(): boolean { return this.pager.error; }
  get hasMoreListings(): boolean { return this.pager.hasMore; }
  get loadedPhonePage(): number { return this.pager.loadedPage; }

  searchQuery = '';
  status: StatusTab = '';
  sort: ListingSort = 'newest';

  get conditionOptions(): DropdownOption[] {
    return ['new', 'like_new', 'noted', 'damaged'].map(value => ({
      value,
      label: this.i18n.t(`cond.${value}`)
    }));
  }

  get sortOptions(): DropdownOption[] {
    return SORTS.map(value => ({ value, label: this.i18n.t(`acct.sort.${value}`) }));
  }

  get hasFilters(): boolean {
    return !!this.searchQuery || !!this.status;
  }

  tabLabel(tab: StatusTab): string {
    return tab ? `row.${tab}` : 'acct.statusAll';
  }

  /** The course and school that tell two listings of the same book apart. */
  courseLine(item: any): string | undefined {
    return [item.course_name, item.school_name].filter(Boolean).join(' · ') || undefined;
  }

  ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    const status = qp.get('status') as StatusTab;
    if (STATUSES.includes(status)) this.status = status;
    const sort = qp.get('sort') as ListingSort;
    if (SORTS.includes(sort)) this.sort = sort;
    this.searchQuery = qp.get('q') ?? '';
    const pageParam = Math.max(1, Number(qp.get('page')) || 1);
    this.currentPage = this.isPhone ? 1 : pageParam;

    this.metadataService.getMetadata().subscribe({
      next: (data) => {
        if (data.categories) {
          this.categoryOptions = [{ label: this.i18n.t('sell.categoryPlaceholder'), value: '' }, ...data.categories.map((c: any) => ({
            label: c.title,
            value: c.slug
          }))];
          this.cdr.markForCheck();
        }
      },
      error: (err) => {
        // Category options are supplementary; log and don't block the rest of the page.
        console.error('Failed to load metadata', err);
      }
    });
    this.loadMyListings();
  }

  onSearchQuery(query: string) {
    this.searchQuery = query;
    this.currentPage = 1;
    this.pager.reset(1);
    this.syncUrl();
    this.loadMyListings();
  }

  onStatusChange(status: StatusTab) {
    if (status === this.status) return;
    this.status = status;
    this.currentPage = 1;
    this.pager.reset(1);
    this.syncUrl();
    this.loadMyListings();
  }

  onSortChange(sort: ListingSort) {
    this.sort = sort;
    this.currentPage = 1;
    this.pager.reset(1);
    this.syncUrl();
    this.loadMyListings();
  }

  onPageChange(page: number) {
    this.currentPage = page;
    this.syncUrl();
    this.loadMyListings();
  }

  clearFilters() {
    this.searchQuery = '';
    this.status = '';
    this.currentPage = 1;
    this.pager.reset(1);
    this.syncUrl();
    this.loadMyListings();
  }

  private syncUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        status: this.status || null,
        sort: this.sort === 'newest' ? null : this.sort,
        q: this.searchQuery || null,
        page: this.currentPage > 1 ? this.currentPage : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  loadMyListings() {
    this.loading = true;
    this.loadFailed = false;
    this.pager.reset(this.currentPage, this.totalListings);
    this.accountService
      // The default sort is left out rather than sent: the backend's default is
      // the same, and first page, no search, no filter, no sort is the plain
      // /auth/me/ request the account shell already made — so it is served
      // from AccountService's cache instead of fetched again. Changes clear
      // that cache first (afterChange).
      .getMyProfile(this.currentPage, this.searchQuery, { status: this.status, sort: this.sort === 'newest' ? undefined : this.sort })
      .subscribe({
        next: (data: any) => {
          if (data.myListings && !Array.isArray(data.myListings)) {
            this.myListings = data.myListings.results || [];
            this.totalListings = data.myListings.count || this.myListings.length;
          } else {
            this.myListings = data.myListings || [];
            this.totalListings = this.myListings.length;
          }
          this.counts = data.myListingCounts || {};
          this.loading = false;
          this.refreshing = false;
          this.pager.reset(this.currentPage, this.totalListings);
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.loading = false;
          this.refreshing = false;
          this.loadFailed = true;
          // With nothing on screen the error state says it and offers the
          // retry; over a list that is still showing, a toast is enough.
          if (this.myListings.length > 0) this.toast.error(parseApiError(err, this.i18n, 'acct.errLoadFailed'));
          this.cdr.markForCheck();
        }
      });
  }

  onRefresh() {
    this.refreshing = true;
    this.pager.reset(1);
    if (this.isPhone) {
      this.currentPage = 1;
      this.syncUrl();
    }
    this.accountService.clearProfileCache();
    this.loadMyListings();
  }

  onLoadMore() {
    this.pager.loadMore();
  }

  async onListingAction(event: { type: string, id: number | string }) {
    const listing = this.myListings.find(l => l.id === event.id);

    if (event.type === 'edit') {
      if (listing) {
        this.editingListing = listing;
        this.showAdvanced = false;
        this.photoError = '';
        this.editForm = {
          price: listing.price,
          condition: listing.condition,
          status: listing.status,
          category: listing.category || '',
          course_name: listing.course_name || '',
          professor_name: listing.professor_name || '',
          private_note: listing.private_note,
          description: listing.description,
          photos: editablePhotos(listing),
          book_title: listing.book_title,
          book_authors: listing.book_authors,
          isbn: listing.isbn
        };
      }
      return;
    }

    if (event.type === 'copy_link') {
      await this.copyLink(event.id);
      return;
    }
  }

  get statusOptions(): DropdownOption[] {
    const opts: DropdownOption[] = [
      { value: 'active', label: this.i18n.t('row.active') },
      { value: 'sold', label: this.i18n.t('row.sold') },
      { value: 'removed', label: this.i18n.t('row.removed') },
    ];
    // Reserved is a system state; only show it if the listing is currently reserved
    // so the seller can see it, but can't pick it for a non-reserved listing.
    if (this.editForm?.status === 'reserved') {
      opts.splice(1, 0, { value: 'reserved', label: this.i18n.t('row.reserved') });
    }
    return opts;
  }

  async onDelete(id: number | string) {
    const confirmed = await this.confirms.askDanger(this.i18n.t('acct.confirmDelete'), {
      confirmLabel: this.i18n.t('common.delete'),
    });
    if (!confirmed) return;
    
    this.closeEdit();
    this.listingService.deleteListing(id).subscribe({
      next: () => {
        this.toast.success(this.i18n.t('acct.listingDeleted'));
        this.afterChange();
      },
      error: (err) => this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed')),
    });
  }

  /** The public link a seller sends to a classmate. */
  private async copyLink(id: number | string) {
    const path = this.regionLink.path(['/listing', id]).join('/').replace('//', '/');
    const url = `${location.origin}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success(this.i18n.t('acct.linkCopied'));
    } catch {
      // Clipboard access can be refused (permissions, insecure context).
      this.toast.info(url);
    }
  }

  private afterChange() {
    this.accountService.clearProfileCache();
    this.loadMyListings();
  }

  closeEdit() {
    this.editingListing = null;
    // onDelete closes the sheet from inside an awaited confirm; without this
    // the sheet stayed drawn whenever the delete then failed or was refused.
    this.cdr.markForCheck();
  }

  /**
   * Only drops the photo from the form. Unlike the sell page this does not
   * delete the file on the server: the listing still points at it until the
   * seller saves, and Cancel has to leave the listing exactly as it was.
   */
  removePhoto(index: number) {
    this.editForm.photos = this.editForm.photos.filter((_: string, i: number) => i !== index);
    this.photoError = '';
  }

  /**
   * Uploads the picked files one after another, so they keep the order they
   * were picked in, and only as many as still fit under the cap — photos in
   * flight count too, or a second pick made mid-upload could overshoot it.
   */
  async onFileSelected(event: any) {
    const files: File[] = Array.from(event.target.files ?? []);
    event.target.value = ''; // so picking the same file again still fires
    if (!files.length) return;

    const room = Math.max(this.maxPhotos - this.editForm.photos.length - this.pendingUploads, 0);
    const accepted = files.slice(0, room);
    this.photoError = files.length > accepted.length
      ? this.i18n.t('sell.photoLimitReached', { max: this.maxPhotos })
      : '';
    if (!accepted.length) {
      this.cdr.markForCheck();
      return;
    }

    // The dialog this upload started in; a different listing opened
    // meanwhile must not receive its photos.
    const form = this.editForm;
    this.pendingUploads += accepted.length;
    this.isUploadingPhoto = true;
    this.cdr.markForCheck();
    for (const file of accepted) {
      try {
        // uploadPhoto is an Observable; awaiting it directly (as this used
        // to) resolves to the Observable itself, not the uploaded URL.
        const { url } = await firstValueFrom(this.listingService.uploadPhoto(file));
        form.photos = [...form.photos, url];
      } catch (err) {
        console.error('Upload failed', err);
        this.toast.error(this.i18n.t('acct.uploadFailed'));
      } finally {
        this.pendingUploads--;
        this.isUploadingPhoto = this.pendingUploads > 0;
        this.cdr.markForCheck();
      }
    }
  }

  submitEdit() {
    if (!this.editingListing || this.saving) return;

    const payload: any = {
      price: this.editForm.price,
      condition: this.editForm.condition,
      status: this.editForm.status,
      category: this.editForm.category || null,
      course_name: this.editForm.course_name || '',
      professor_name: this.editForm.professor_name || '',
      private_note: this.editForm.private_note,
      description: this.editForm.description,
      photos: this.editForm.photos
    };

    if (this.editingListing.book_source === 'manual') {
      // Only the fields the seller actually touched. A Book row is shared by
      // every listing of that title, so the backend refuses book-field edits
      // once a second seller lists the same manual book — and sending the
      // unchanged title/authors/ISBN on every save turned a plain price edit
      // into a 403 that lost the whole form.
      const original = this.editingListing;
      const same = (a: any, b: any) => (a ?? '') === (b ?? '');
      if (!same(this.editForm.book_title, original.book_title)) {
        payload.book_title = this.editForm.book_title;
      }
      if (!same(this.editForm.book_authors, original.book_authors)) {
        payload.book_authors = this.editForm.book_authors;
      }
      if (!same(this.editForm.isbn, original.isbn)) {
        payload.isbn = this.editForm.isbn;
      }
    }

    this.saving = true;
    this.listingService.updateListing(this.editingListing.id, payload).subscribe({
      next: () => {
        this.saving = false;
        this.toast.success(this.i18n.t('acct.saved'));
        this.closeEdit();
        this.afterChange();
      },
      error: (err) => {
        // The backend has real reasons to refuse this edit now (shared book,
        // malformed ISBN, ISBN already on another book) and each carries an
        // i18n code; the blanket "update failed" left the seller guessing.
        this.saving = false;
        this.cdr.markForCheck();
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
      }
    });
  }

  goToSell() {
    this.router.navigate(this.regionLink.path(['/sell']));
  }
}
