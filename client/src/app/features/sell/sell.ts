import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { UiInput } from '../../shared/ui/input.component';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiConditionPicker } from '../../shared/ui/condition-picker.component';
import { UiBookCover } from '../../shared/ui/book-cover.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiVerificationPrompt } from '../../shared/ui/verification-prompt.component';
import { AccountService } from '../../core/services/account.service';
import { RegionService } from '../../core/region.service';
import { BookService } from '../../core/services/book.service';
import { ListingService } from '../../core/services/listing.service';
import { MetadataService } from '../../core/services/metadata.service';
import { AuthStore } from '../../core/auth.store';
import { I18nService, TPipe } from '../../core/i18n.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
// Type-only: the library (~300 KB of decoders) is pulled in with a dynamic
// import the first time the camera is opened, not on every visit to /sell.
import { bookIsbn, cleanAndValidateIsbn, isbnFromScan } from '../../core/isbn';
import { UiBarcodeScanner } from '../../shared/ui/barcode-scanner.component';
import { RegionLinkService } from '../../core/region-link.service';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { HasUnsavedChanges } from '../../core/unsaved-changes.guard';
import { Subscription, catchError, concatMap, defaultIfEmpty, from, map, of, take } from 'rxjs';


/**
 * Draft storage for the multi-step listing form. Same `unibooks.<feature>.<thing>`
 * prefix scheme the rest of the app uses (`unibooks.chat.draft.*`,
 * `unibooks.verification_prompt.sell`).
 */
export const SELL_DRAFT_STORAGE_KEY = 'unibooks.sell.draft';

/**
 * Drafts older than this are dropped on load. Photos are stored as server URLs
 * rather than blobs, and those URLs are the part most likely to have been
 * cleaned up server-side by the time a very old draft is opened again.
 */
export const SELL_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Photos a listing may carry, both from this form and from the edit dialog in
 * account/listings.ts, so a listing made here is never over the cap there. The
 * backend accepts up to 6 (MAX_LISTING_PHOTOS); 5 keeps one in hand below that
 * and is what the sell.photoLabel copy promises.
 */
export const SELL_MAX_PHOTOS = 5;

/** Active copies of the book already listed in the region, for the price step. */
export interface OtherCopies {
  count: number;
  min: number;
  max: number;
}

/**
 * Reads the price range of a book's active copies off the book detail body.
 * `price_stats` covers every copy; a backend that predates it only has the
 * first page of listings, which is used only when it holds all of them — a
 * range built from part of the list could leave out the cheapest copy.
 */
export function otherCopiesFromBook(book: any): OtherCopies | null {
  const stats = book?.price_stats;
  if (stats && typeof stats.count === 'number') {
    const min = Number(stats.min);
    const max = Number(stats.max);
    if (stats.count > 0 && stats.min !== null && stats.max !== null && Number.isFinite(min) && Number.isFinite(max)) {
      return { count: stats.count, min, max };
    }
    return null;
  }

  const listings = book?.listings;
  const results: any[] = Array.isArray(listings?.results) ? listings.results : [];
  const prices = results
    .map(listing => listing?.price)
    .filter(price => price !== null && price !== undefined && price !== '')
    .map(Number)
    .filter(Number.isFinite);
  if (prices.length === 0) return null;
  if (typeof listings.count === 'number' && listings.count > prices.length) return null;
  return { count: prices.length, min: Math.min(...prices), max: Math.max(...prices) };
}

/** A price more than this many times the cheapest listed copy gets a warning. */
export const PRICE_WARNING_MULTIPLE = 3;

/**
 * Whether `price` is far enough above the cheapest copy already listed to be
 * worth a second look — typically an extra zero. Only a warning: a signed or
 * annotated copy can fairly cost more. No rule applies when nothing else is
 * listed (there is nothing to compare with, and a fixed ceiling would mean
 * something different in every region's currency) or when the cheapest copy
 * is free (any multiple of zero is zero).
 */
export function isPriceFarAboveOtherCopies(price: number | null | undefined, copies: OtherCopies | null): boolean {
  if (!copies || copies.min <= 0) return false;
  if (price === null || price === undefined || (price as any) === '') return false;
  const numeric = Number(price);
  if (!Number.isFinite(numeric)) return false;
  return numeric > copies.min * PRICE_WARNING_MULTIPLE;
}

/** Default condition — also the "user has not touched this" baseline. */
const DEFAULT_CONDITION = 'new';

export interface SellDraft {
  version: 1;
  savedAt: number;
  step: number;
  searchQuery: string;
  bookPreview: any;
  condition: string;
  category: string;
  course: string;
  professor: string;
  privateNote: string;
  description: string;
  price: number | null;
  uploadedPhotos: string[];
}

@Component({
  selector: 'app-sell',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, RegionLinkDirective, UiInput, UiTextarea, UiButton, UiDropdown, UiConditionPicker, UiBookCover, UiVerificationPrompt, UiSkeleton, UiBarcodeScanner, TPipe, PricePipe],
  templateUrl: './sell.html',
  styleUrls: ['./sell.css']
})
export class Sell implements OnInit, OnDestroy, HasUnsavedChanges {
  step = 1;
  searchQuery = '';
  searchResults: any[] = [];
  bookPreview: any = null;
  /** Read through to the store rather than snapshotted in ngOnInit. A session
   *  can end while this page is open — the token expires and the refresh is
   *  refused in the background — and a cached `true` left the visitor filling in
   *  the whole listing wizard, only to be told at submit that their .edu email
   *  needs verifying. The template already has the right signed-out state; it
   *  just never saw the change. */
  get isLoggedIn(): boolean {
    return this.authStore.isLoggedIn();
  }
  isVerified = false;
  showUnverifiedPrompt = false;
  isLoading = true;
  isCheckingIsbn = false;
  isSubmitting = false;
  apiError = '';
  isSearchQueryDirty = false;
  hideSearchButtonForNow = false;

  imeComposing = false;
  // Enter confirming an IME candidate (e.g. Zhuyin) fires `compositionend`
  // and the Enter `keyup` in the same tick, and some browsers have already
  // flipped `isComposing` back to false by then — this flag covers that tick,
  // or picking a candidate for a title search would also submit it.
  private imeJustEnded = false;

  isScanning = false;
  cameraError = '';
  /** The current search came from the camera, so offer "Scan again". */
  lastSearchWasScan = false;
  private isProcessingScan = false;

  /** Shown when a saved draft is found on entry — never restored silently. */
  showDraftPrompt = false;

  /** The draft behind `showDraftPrompt`, held until the user picks an option. */
  private pendingDraft: SellDraft | null = null;

  /**
   * Fields the user has blurred out of, and steps they have tried to advance
   * past. An error message needs one of the two before it appears, so landing
   * on a fresh step never greets the user with red text.
   */
  touchedFields: Record<string, boolean> = {};
  attemptedSteps: Record<number, boolean> = {};

  /**
   * Photo URLs that failed to load — typically a restored draft whose files
   * the server has since cleaned up. They render as a placeholder instead of
   * a broken image, and are left out of the submitted payload.
   */
  brokenPhotos: string[] = [];

  private authStore = inject(AuthStore);
  regionService = inject(RegionService);
  private accountService = inject(AccountService);
  private bookService = inject(BookService);
  private listingService = inject(ListingService);
  private metadataService = inject(MetadataService);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private cdr = inject(ChangeDetectorRef);
  private metadataSubscription: Subscription | null = null;
  private i18n = inject(I18nService);
  private ga = inject(GoogleAnalyticsService);

  category = '';
  categoryOptions: any[] = [];

  condition = DEFAULT_CONDITION;
  get conditionOptions() {
    return ['new', 'like_new', 'noted', 'damaged'].map(value => ({
      value,
      label: this.i18n.t(`cond.${value}`)
    }));
  }
  course = '';
  professor = '';
  privateNote = '';
  description = '';
  price: number | null = null;

  uploadedPhotos: string[] = [];

  /** Copies of this book already listed in the region; null when none or unknown. */
  otherCopies: OtherCopies | null = null;
  readonly priceWarningMultiple = PRICE_WARNING_MULTIPLE;
  private otherCopiesBookId: string | null = null;
  private otherCopiesSubscription: Subscription | null = null;

  readonly maxPhotos = SELL_MAX_PHOTOS;
  /** Files picked but not yet uploaded, counted against the photo cap. */
  private pendingUploads = 0;
  get isUploading(): boolean {
    return this.pendingUploads > 0;
  }
  uploadError = '';
  isDragOver = false;

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      this.handleFiles(files);
    }
  }

  onFileSelected(event: any) {
    const files: File[] = Array.from(event.target.files ?? []);
    if (files.length) {
      this.handleFiles(files);
      event.target.value = ''; // Reset input
    }
  }

  /**
   * Uploads as many of the picked files as still fit under the cap, one after
   * another so the photos keep the order they were picked in. Photos already
   * uploaded and ones still on their way both count, or a second pick made
   * while the first is uploading could overshoot the cap. Extra files are
   * dropped with a message rather than silently.
   */
  handleFiles(files: File[]) {
    const room = Math.max(this.maxPhotos - this.uploadedPhotos.length - this.pendingUploads, 0);
    const accepted = files.slice(0, room);
    this.uploadError = files.length > accepted.length
      ? this.i18n.t('sell.photoLimitReached', { max: this.maxPhotos })
      : '';
    this.cdr.markForCheck();
    if (!accepted.length) return;

    this.pendingUploads += accepted.length;
    from(accepted).pipe(
      // One failed file must not cancel the rest of the batch.
      concatMap(file => this.listingService.uploadPhoto(file).pipe(
        map(res => res.url as string | null),
        catchError(() => of(null)),
        // Exactly one result per file, or pendingUploads never returns to 0
        // and the drop zone is stuck on "Uploading...".
        defaultIfEmpty(null),
        take(1),
      )),
    ).subscribe(url => {
      this.pendingUploads--;
      if (url) {
        this.uploadedPhotos.push(url);
        this.ga.trackEvent('upload_listing_photo');
        this.saveDraft();
      } else {
        this.uploadError = this.i18n.t('sell.uploadFailed');
      }
      this.cdr.markForCheck();
    });
  }

  removePhoto(index: number) {
    const url = this.uploadedPhotos[index];
    this.uploadedPhotos.splice(index, 1);
    this.brokenPhotos = this.brokenPhotos.filter(u => u !== url);
    this.saveDraft();

    // Asynchronously tell the server to delete the physical file
    this.listingService.deletePhoto(url).subscribe({
      next: () => console.log('Successfully deleted orphaned photo from server'),
      error: (err) => console.error('Failed to delete orphaned photo from server', err)
    });
  }

  /**
   * A restored draft can point at photos the server no longer has. Swap the
   * broken <img> for a neutral placeholder rather than letting the layout show
   * a torn-image icon, and stop sending the dead URL on submit — the user can
   * still see the slot and remove or replace it.
   */
  onPhotoError(url: string) {
    if (!this.brokenPhotos.includes(url)) {
      this.brokenPhotos.push(url);
      this.cdr.markForCheck();
    }
  }

  isPhotoBroken(url: string): boolean {
    return this.brokenPhotos.includes(url);
  }

  ngOnInit() {
    this.pendingDraft = this.readDraft();
    this.showDraftPrompt = !!this.pendingDraft;

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.onBeforeUnload);
    }

    // With retry: this list has no error state, so one failed request used to
    // leave the category dropdown empty for the rest of the visit.
    this.metadataSubscription = this.metadataService.getMetadataWithRetry().subscribe({
      next: (data) => {
        if (data.categories) {
          this.categoryOptions = [{ label: this.i18n.t('sell.categoryPlaceholder'), value: '' }, ...data.categories.map((c: any) => ({
            label: c.title,
            value: c.slug
          }))];
        }
      },
      error: (err) => console.error('Failed to load categories', err),
    });

    if (this.isLoggedIn) {
      this.accountService.getMyProfile().subscribe({
        next: (profile) => {
          this.isLoading = false;
          this.isVerified = this.authStore.isVerifiedIn(this.regionService.region());
          // Both triggers for this banner — landing here unverified, and a
          // later submit blocked by a stale 403 — must go through the same
          // flag, or the dismiss button only silences one of the two paths.
          if (!this.isVerified) this.showUnverifiedPrompt = true;
          this.cdr.markForCheck();
        },
        error: () => {
          this.isLoading = false;
          this.isVerified = false;
          this.cdr.markForCheck();
        }
      });
    } else {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  ngOnDestroy() {
    this.stopScanner();
    // Also ends its retry schedule, if categories were still being retried.
    this.metadataSubscription?.unsubscribe();
    this.otherCopiesSubscription?.unsubscribe();
    if (typeof window !== 'undefined') {
      // Must come off the window, or every later page in the session keeps
      // asking to confirm reloads on behalf of a component that is long gone.
      window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
  }

  // ---------------------------------------------------------------------
  // Leaving the flow
  // ---------------------------------------------------------------------

  /**
   * Arrow property so the same reference goes to addEventListener and
   * removeEventListener — a bound method would not be removable.
   */
  private readonly onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.hasUnsavedChanges()) return;
    // Persist first: this is the last chance before the tab goes away.
    this.saveDraft();
    event.preventDefault();
    // Legacy browsers only raise the native prompt when returnValue is set.
    event.returnValue = '';
  };

  /**
   * Consumed by `unsavedChangesGuard` on the `sell` route.
   *
   * Intercepts only when there is real work to lose: an untouched step 1 and
   * the step 4 success screen (where the listing is created and the draft
   * already cleared) both pass through without a prompt.
   */
  hasUnsavedChanges(): boolean {
    if (this.step >= 4) return false;
    return this.hasFormContent();
  }

  unsavedChangesMessage(): string {
    return this.i18n.t('sell.leaveConfirm');
  }

  /**
   * Whether anything beyond the initial defaults has been entered. A typed but
   * unsubmitted ISBN in the search box deliberately does not count — nothing
   * has been chosen yet and re-typing it costs the user nothing.
   */
  private hasFormContent(): boolean {
    const preview = this.bookPreview;
    const hasBook = !!preview && (
      !preview.isManual ||
      !!String(preview.title || '').trim() ||
      !!String(preview.authors || '').trim()
    );

    return hasBook
      || this.condition !== DEFAULT_CONDITION
      || !!this.category
      || !!this.course.trim()
      || !!this.professor.trim()
      || !!this.privateNote.trim()
      || !!this.description.trim()
      || this.uploadedPhotos.length > 0
      || this.price !== null;
  }

  async toggleScanner() {
    if (this.isScanning) {
      await this.stopScanner();
    } else {
      await this.startScanner();
    }
  }

  cleanAndValidateIsbn(isbnStr: string | null | undefined): string | null {
    return cleanAndValidateIsbn(isbnStr);
  }

  handleScanResult(decodedText: string): boolean {
    if (this.isProcessingScan) return false;

    const validIsbn = isbnFromScan(decodedText);
    if (!validIsbn) {
      const errorMsg = this.i18n.t('sell.invalidBarcodeScanned');
      if (this.cameraError !== errorMsg) {
        this.cameraError = errorMsg;
        this.cdr.markForCheck();
      }
      return false;
    }

    this.isProcessingScan = true;
    this.cameraError = '';
    this.searchQuery = validIsbn;
    this.onSearchQueryChange();
    this.lastSearchWasScan = true;
    this.stopScanner().then(() => {
      this.searchBook();
    }).finally(() => {
      this.isProcessingScan = false;
    });
    return true;
  }

  /** Shows the camera; ui-barcode-scanner starts it once rendered. */
  async startScanner() {
    this.cameraError = '';
    this.isProcessingScan = false;
    this.isScanning = true;
    this.cdr.markForCheck();
  }

  /** The camera could not be opened: close it and say why. */
  onScannerFailed() {
    this.cameraError = this.i18n.t('sell.cameraPermission');
    this.isScanning = false;
    this.isProcessingScan = false;
    this.cdr.markForCheck();
  }

  /** Hides the camera; ui-barcode-scanner stops it as it is removed. */
  async stopScanner() {
    if (this.cameraError === this.i18n.t('sell.invalidBarcodeScanned')) {
      this.cameraError = '';
    }
    this.isScanning = false;
    this.isProcessingScan = false;
    this.cdr.markForCheck();
  }

  searchBook() {
    if (!this.searchQuery) return;
    this.isCheckingIsbn = true;
    this.apiError = '';
    this.isSearchQueryDirty = false;
    this.hideSearchButtonForNow = false;

    // No engine: the seller has no way to pick one, and only a request
    // without it lets the backend try the ISBN registry and Open Library when
    // Google has no record of the book.
    this.bookService.searchBooks(this.searchQuery, '', '', '', 1).subscribe({
      next: (data) => {
        this.isCheckingIsbn = false;
        this.ga.trackEvent('isbn_lookup', { query: this.searchQuery });
        const items = data.results || data;
        if (items && items.length > 0) {
          this.searchResults = items;
          this.bookPreview = null;
        } else {
          this.searchResults = [];
          this.enterManually();
          this.apiError = this.i18n.t(this.isTextQuery ? 'sell.notFoundText' : 'sell.notFoundIsbn');
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isCheckingIsbn = false;
        if (err && (err.status === 504 || err.status === 502 || err.status === 503)) {
          this.apiError = this.i18n.t('sell.upstreamTimeout');
        } else {
          this.apiError = this.i18n.t('sell.networkError');
        }
        this.hideSearchButtonForNow = false;
        this.cdr.markForCheck();
      }
    });
  }

  /** A title or author search rather than an ISBN: the one that can be retried by ISBN. */
  get isTextQuery(): boolean {
    return !!this.searchQuery && !cleanAndValidateIsbn(this.searchQuery);
  }

  /** Whether the Search Book button is on offer — Enter follows the same rule. */
  get canSearch(): boolean {
    return !this.hideSearchButtonForNow
      && ((!this.bookPreview && this.searchResults.length === 0) || this.isSearchQueryDirty);
  }

  onSearchCompositionEnd() {
    this.imeComposing = false;
    this.imeJustEnded = true;
    setTimeout(() => { this.imeJustEnded = false; });
  }

  /**
   * Enter in the ISBN field searches, as the button does. Not while an IME
   * candidate is being confirmed (same guard as the messages composer), not
   * while a search is already running, and not when the button is hidden —
   * with a book already picked, Enter would otherwise throw the pick away.
   */
  onSearchEnter(event: Event) {
    if (this.imeComposing || this.imeJustEnded || (event as KeyboardEvent).isComposing) return;
    if (this.isCheckingIsbn || !this.searchQuery.trim() || !this.canSearch) return;
    this.searchBook();
  }

  onSearchQueryChange() {
    this.isSearchQueryDirty = true;
    this.hideSearchButtonForNow = false;
    this.apiError = '';
    this.lastSearchWasScan = false;
    // Manual entry is the answer to "that ISBN found nothing"; a new query
    // asks the question again, so the blank title/author fields go away and
    // Search/Scan come back.
    if (this.bookPreview?.isManual) {
      this.bookPreview = null;
      this.touchedFields['title'] = false;
      this.touchedFields['authors'] = false;
      this.attemptedSteps[1] = false;
    }
    this.saveDraft();
  }

  /**
   * Starts over from a scan: clears the scanned ISBN and whatever it found,
   * then opens the camera again. Offered once a scan's search has finished,
   * when the Scan button itself is hidden.
   */
  async rescan() {
    this.searchQuery = '';
    this.searchResults = [];
    this.clearSelection();
    this.isSearchQueryDirty = false;
    this.lastSearchWasScan = false;
    await this.startScanner();
  }

  selectBook(book: any) {
    this.bookPreview = book;
    this.bookPreview.authors = this.bookPreview.author || this.bookPreview.authors;
    this.bookPreview.isManual = false;
    this.hideSearchButtonForNow = true;
    this.saveDraft();
  }

  clearSelection() {
    this.bookPreview = null;
    this.hideSearchButtonForNow = false;
    this.apiError = '';
    // Re-picking a book starts that step over; the old messages no longer apply.
    this.touchedFields['title'] = false;
    this.touchedFields['authors'] = false;
    this.attemptedSteps[1] = false;
    this.saveDraft();
  }

  enterManually() {
    this.bookPreview = { title: '', authors: '', coverUrl: '', isManual: true };
    this.hideSearchButtonForNow = true;
    this.touchedFields['title'] = false;
    this.touchedFields['authors'] = false;
    this.attemptedSteps[1] = false;
  }

  nextStep() {
    this.apiError = '';
    this.attemptedSteps[this.step] = true;
    if (!this.isStepValid(this.step)) {
      this.cdr.markForCheck();
      return;
    }
    this.step++;
    if (this.step === 3) this.loadOtherCopies();
    this.saveDraft();
  }

  /**
   * Fetches what other copies of the chosen book sell for, for the price
   * step. Only a book already in the catalogue (it has an id) can have
   * listings; a manual entry or an external result has none to show. The
   * reference is a hint, so a failed request just leaves it out.
   */
  loadOtherCopies() {
    const id = this.bookPreview?.id ? String(this.bookPreview.id) : null;
    if (id === this.otherCopiesBookId) return;
    this.otherCopiesSubscription?.unsubscribe();
    this.otherCopiesSubscription = null;
    this.otherCopiesBookId = id;
    this.otherCopies = null;
    if (!id) return;

    this.otherCopiesSubscription = this.bookService.getBook(id).subscribe({
      next: (book) => {
        this.otherCopies = otherCopiesFromBook(book);
        this.cdr.markForCheck();
      },
      error: () => {
        // Let a later visit to the step try again.
        this.otherCopiesBookId = null;
      },
    });
  }

  /** The price's validation problem whether or not its message is showing yet. */
  get priceProblemKey(): string {
    return this.priceProblem();
  }

  /** Soft warning under the price; never blocks Confirm Listing. */
  get priceWarning(): boolean {
    return !this.priceProblem() && isPriceFarAboveOtherCopies(this.price, this.otherCopies);
  }

  /** Photos the listing will actually carry — broken ones are not submitted. */
  get submittablePhotoCount(): number {
    return this.uploadedPhotos.filter(url => !this.isPhotoBroken(url)).length;
  }

  prevStep() {
    this.apiError = '';
    this.step--;
    this.saveDraft();
  }

  setFree() {
    // Free is a legitimate price, so this counts as answering the field.
    this.price = 0;
    this.markTouched('price');
    this.onFormChange();
  }

  // ---------------------------------------------------------------------
  // Field validation
  // ---------------------------------------------------------------------

  /** Called from `(focusout)` so a field only turns red once it has been left. */
  markTouched(field: string) {
    this.touchedFields[field] = true;
  }

  private shouldShowError(field: string, step: number): boolean {
    return !!this.touchedFields[field] || !!this.attemptedSteps[step];
  }

  /** i18n key for the message under the manual-entry title field, or ''. */
  get titleErrorKey(): string {
    if (!this.bookPreview?.isManual) return '';
    if (!this.shouldShowError('title', 1)) return '';
    return String(this.bookPreview.title || '').trim() ? '' : 'sell.errTitleRequired';
  }

  /** i18n key for the message under the manual-entry author field, or ''. */
  get authorErrorKey(): string {
    if (!this.bookPreview?.isManual) return '';
    if (!this.shouldShowError('authors', 1)) return '';
    return String(this.bookPreview.authors || '').trim() ? '' : 'sell.errAuthorRequired';
  }

  /** i18n key for the message under the price field, or ''. */
  get priceErrorKey(): string {
    if (!this.shouldShowError('price', 3)) return '';
    return this.priceProblem();
  }

  /**
   * Price validity independent of whether the message is being shown yet.
   * `0` is valid — that is what the "free" button produces. A number input
   * hands back null when empty, and NaN when the typed text is unparseable.
   */
  private priceProblem(): string {
    const price = this.price;
    if (price === null || price === undefined || (price as any) === '') {
      return 'sell.errPriceRequired';
    }
    const numeric = Number(price);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return 'sell.errPriceInvalid';
    }
    return '';
  }

  /** Whether the given step's required fields are filled in correctly. */
  private isStepValid(step: number): boolean {
    if (step === 1) {
      if (!this.bookPreview) return false;
      if (!this.bookPreview.isManual) return true;
      return !!String(this.bookPreview.title || '').trim()
        && !!String(this.bookPreview.authors || '').trim();
    }
    if (step === 3) {
      return !this.priceProblem();
    }
    return true;
  }

  async submit() {
    this.apiError = '';

    if (!this.isVerified) {
      this.showUnverifiedPrompt = true;
      this.cdr.markForCheck();
      return;
    }

    this.attemptedSteps[3] = true;
    if (!this.isStepValid(3)) {
      this.cdr.markForCheck();
      return;
    }



    if (!this.bookPreview) return;

    this.isSubmitting = true;

    const executeListingCreation = (bookId: string) => {
      const payload = {
        book: bookId,
        condition: this.condition,
        category: this.category || null,
        course_name: this.course,
        professor_name: this.professor,
        private_note: this.privateNote,
        description: this.description,
        price: this.price,
        photos: this.uploadedPhotos.filter(url => !this.isPhotoBroken(url))
      };

      this.listingService.createListing(payload).subscribe({
        next: () => {
          this.ga.trackPublishListing(this.category, this.condition, this.price);
          this.isSubmitting = false;
          this.step = 4;
          // Submitted for real — nothing left to restore or warn about.
          this.clearDraft();
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isSubmitting = false;
          const code = err.error?.error?.code;
          if (err.status === 403 || code === 'acct.errUnverified' || code === 'auth.errNotVerified') {
            this.showUnverifiedPrompt = true;
          } else {
            // tOrNull, not t: an unrecognised backend code would otherwise be
            // pasted into the sentence verbatim, showing the user a raw key.
            const detail = this.i18n.tOrNull(code)
              ?? err.error?.error?.message
              ?? err.error?.detail
              ?? this.i18n.t('sell.unknownError');
            this.apiError = this.i18n.t('sell.listFailed', { msg: detail });
          }
          this.cdr.markForCheck();
        }
      });
    };

    if (this.bookPreview.id) {
      // Book already exists in our DB
      executeListingCreation(this.bookPreview.id);
    } else {
      // Only a real ISBN goes on the new book: the backend refuses anything
      // else, and digits that only look like one (a misread or a typo) would
      // file the book where nobody looking it up will find it.
      const bookData = {
        isbn13: bookIsbn(this.bookPreview.isbn) ?? bookIsbn(this.searchQuery) ?? '',
        title: this.bookPreview.title,
        authors: this.bookPreview.author || this.bookPreview.authors || '',
        publisher: this.bookPreview.publisher || '',
        published_date: this.bookPreview.published_date || this.bookPreview.publishedDate || '',
        cover_url: this.bookPreview.coverUrl || '',
        source: this.bookPreview.source || 'manual'
      };

      this.bookService.createManualBook(bookData).subscribe({
        next: (createdBook) => {
          executeListingCreation(createdBook.id);
        },
        error: (err) => {
          this.isSubmitting = false;
          const code = err.error?.error?.code;
          // tOrNull, not t: an unrecognised backend code would otherwise be
          // pasted into the sentence verbatim, showing the user a raw key.
          let details = this.i18n.tOrNull(code) ?? (err.error?.error?.message || err.error?.detail || '');
          if (!details && err.error) {
            details = JSON.stringify(err.error);
          }
          this.apiError = this.i18n.t('sell.createBookFailed', {msg: details});
          this.cdr.markForCheck();
        }
      });
    }
  }

  // ---------------------------------------------------------------------
  // Draft persistence
  // ---------------------------------------------------------------------

  /** Bound to `(ngModelChange)` on the form fields to keep the draft current. */
  onFormChange() {
    this.saveDraft();
  }

  /**
   * Writes the current form to localStorage. An emptied form clears the draft
   * rather than storing an empty one.
   */
  saveDraft() {
    if (typeof localStorage === 'undefined') return;
    if (this.step >= 4) return;

    if (!this.hasFormContent()) {
      // While the restore prompt is still up the stored draft is the one being
      // offered — an untouched blank form must not wipe it.
      if (!this.showDraftPrompt) this.clearDraft();
      return;
    }

    // Typing into a fresh form instead of answering the prompt is an implicit
    // "start over"; from here on this form is the draft.
    if (this.showDraftPrompt) {
      this.showDraftPrompt = false;
      this.pendingDraft = null;
    }

    const draft: SellDraft = {
      version: 1,
      savedAt: Date.now(),
      step: this.step,
      searchQuery: this.searchQuery,
      bookPreview: this.bookPreview,
      condition: this.condition,
      category: this.category,
      course: this.course,
      professor: this.professor,
      privateNote: this.privateNote,
      description: this.description,
      price: this.price,
      uploadedPhotos: this.uploadedPhotos
    };

    try {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (err) {
      // Quota or private-browsing failure: losing the draft is acceptable,
      // breaking the form the user is typing into is not.
      console.error('Failed to persist sell draft to localStorage', err);
    }
  }

  /** Reads and sanity-checks a stored draft. Returns null when there is none. */
  private readDraft(): SellDraft | null {
    if (typeof localStorage === 'undefined') return null;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SELL_DRAFT_STORAGE_KEY);
    } catch (err) {
      console.error('Failed to read sell draft from localStorage', err);
      return null;
    }
    if (!raw) return null;

    try {
      const draft = JSON.parse(raw) as SellDraft;
      if (!draft || draft.version !== 1) {
        this.clearDraft();
        return null;
      }
      if (!Number.isFinite(draft.savedAt) || Date.now() - draft.savedAt > SELL_DRAFT_MAX_AGE_MS) {
        this.clearDraft();
        return null;
      }
      // A draft of the success screen, or of an empty form, is nothing to offer.
      if (!draft.step || draft.step >= 4) {
        this.clearDraft();
        return null;
      }
      return draft;
    } catch (err) {
      console.error('Failed to parse sell draft, discarding it', err);
      this.clearDraft();
      return null;
    }
  }

  /** "Continue where I left off" — applies the stored draft to the form. */
  resumeDraft() {
    const draft = this.pendingDraft;
    this.showDraftPrompt = false;
    this.pendingDraft = null;
    if (!draft) return;

    this.step = Math.min(Math.max(draft.step || 1, 1), 3);
    this.searchQuery = draft.searchQuery || '';
    this.bookPreview = draft.bookPreview ?? null;
    this.condition = draft.condition || DEFAULT_CONDITION;
    this.course = draft.course || '';
    this.professor = draft.professor || '';
    this.privateNote = draft.privateNote || '';
    this.description = draft.description || '';
    this.price = (draft.price === null || draft.price === undefined) ? null : draft.price;
    this.uploadedPhotos = Array.isArray(draft.uploadedPhotos) ? [...draft.uploadedPhotos] : [];
    this.brokenPhotos = [];

    // Categories are per-region, so a slug from another region (or one since
    // retired) would leave the dropdown showing a value it cannot label.
    const category = draft.category || '';
    const categoryIsKnown = !category
      || this.categoryOptions.length === 0
      || this.categoryOptions.some(option => option.value === category);
    this.category = categoryIsKnown ? category : '';

    // A book picked from search results hides the search controls again.
    this.hideSearchButtonForNow = !!this.bookPreview;
    if (this.step === 3) this.loadOtherCopies();
    this.cdr.markForCheck();
  }

  /** "Start over" — drops the draft and leaves the freshly initialised form. */
  discardDraft() {
    this.showDraftPrompt = false;
    this.pendingDraft = null;
    this.clearDraft();
    this.cdr.markForCheck();
  }

  private clearDraft() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(SELL_DRAFT_STORAGE_KEY);
    } catch (err) {
      console.error('Failed to clear sell draft from localStorage', err);
    }
  }

  goToHome() {
    this.router.navigate(this.regionLink.path(['/']));
  }

  goToLogin() {
    this.router.navigate(this.regionLink.path(['/login']));
  }

  goToAccountSettings() {
    this.router.navigate(this.regionLink.path(['/account/settings']));
  }
}
