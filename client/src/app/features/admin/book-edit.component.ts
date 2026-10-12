import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminBookRecord, AdminService } from '../../core/services/admin.service';
import { bookIsbn } from '../../core/isbn';
import { bookSourceLabelKey } from '../../core/book-source';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ToastService } from '../../core/services/toast.service';
import { UiButton } from '../../shared/ui/button.component';
import { STATS_PAGE_STYLES } from './stats-widgets';

/**
 * Corrects a book's catalogue record: the details sellers typed by hand, or
 * the ISBN itself when it was misread. "Look up" fills the form from the
 * external catalogues for the ISBN entered, as a preview; nothing is written
 * until Save. An ISBN another book of the region already has turns Save into
 * a merge into that book, after a confirmation.
 */
/** The `Book.source` values that name an external catalogue. */
const CATALOGUE_SOURCES = new Set(['google_api', 'openlibrary_api', 'isbnnet_api']);

@Component({
  selector: 'admin-book-edit',
  standalone: true,
  imports: [CommonModule, FormsModule, TPipe, UiButton],
  template: `
    <section class="card">
      <div class="section-head-row">
        <h3>{{ 'admin.book.editTitle' | t }}</h3>
        <ui-button size="sm" variant="outline" (onClick)="toggle()">{{
          (open ? 'common.cancel' : 'common.edit') | t
        }}</ui-button>
      </div>
      <p class="card-note">{{ 'admin.book.editNote' | t }}</p>

      <form *ngIf="open" (ngSubmit)="save()" novalidate autocomplete="off">
        <div class="form-group">
          <label for="book-isbn">ISBN</label>
          <div class="isbn-row">
            <input
              id="book-isbn"
              name="isbn13"
              class="admin-form-control"
              inputmode="numeric"
              maxlength="17"
              [(ngModel)]="form.isbn13"
              (ngModelChange)="onIsbnChange()"
            />
            <ui-button
              size="sm"
              variant="secondary"
              [disabled]="looking || saving"
              (onClick)="lookUp()"
            >
              {{ (looking ? 'admin.book.lookingUp' : 'admin.book.lookUp') | t }}
            </ui-button>
          </div>
          <small *ngIf="isbnError" class="field-error" role="alert">{{ isbnError }}</small>
          <small *ngIf="mergeTarget" class="hint warn">{{
            'admin.book.willMerge' | t: { title: mergeTarget.title }
          }}</small>
          <small *ngIf="sourceChange as change" class="hint warn">{{
            'admin.book.sourceDiffers' | t: change
          }}</small>
          <small *ngIf="!isbnError && !mergeTarget && storedIsbnKept" class="hint warn">{{
            'admin.book.storedIsbnInvalid' | t
          }}</small>
          <small *ngIf="!isbnError && !mergeTarget && !storedIsbnKept" class="hint">{{
            'admin.book.isbnHint' | t
          }}</small>
        </div>

        <div class="form-group">
          <label for="book-title">{{ 'admin.book.title' | t }}</label>
          <input
            id="book-title"
            name="title"
            class="admin-form-control"
            maxlength="255"
            required
            [(ngModel)]="form.title"
          />
          <small *ngIf="titleMissing" class="field-error" role="alert">{{
            'admin.book.titleRequired' | t
          }}</small>
        </div>
        <div class="form-group">
          <label for="book-authors">{{ 'admin.book.authors' | t }}</label>
          <input
            id="book-authors"
            name="authors"
            class="admin-form-control"
            maxlength="512"
            [(ngModel)]="form.authors"
          />
        </div>
        <div class="grid-fields">
          <div class="form-group">
            <label for="book-publisher">{{ 'admin.book.publisher' | t }}</label>
            <input
              id="book-publisher"
              name="publisher"
              class="admin-form-control"
              maxlength="255"
              [(ngModel)]="form.publisher"
            />
          </div>
          <div class="form-group">
            <label for="book-date">{{ 'admin.book.publishedDate' | t }}</label>
            <input
              id="book-date"
              name="published_date"
              class="admin-form-control"
              maxlength="50"
              [(ngModel)]="form.published_date"
            />
          </div>
        </div>
        <div class="form-group">
          <label for="book-cover">{{ 'admin.book.coverUrl' | t }}</label>
          <input
            id="book-cover"
            name="cover_url"
            type="url"
            class="admin-form-control"
            maxlength="1024"
            [(ngModel)]="form.cover_url"
          />
        </div>

        <p *ngIf="formError" class="field-error form-error" role="alert">{{ formError }}</p>
        <ui-button type="submit" variant="primary" [disabled]="saving || looking">
          {{ (saving ? 'admin.saving' : 'admin.save') | t }}
        </ui-button>
      </form>
    </section>
  `,
  styles: [
    STATS_PAGE_STYLES,
    `
      .form-group {
        margin-bottom: 16px;
      }
      .form-group label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
      }
      .isbn-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .isbn-row input {
        flex: 1;
        min-width: 0;
        font-family: monospace;
      }
      .grid-fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
        column-gap: 16px;
      }
      .hint,
      .field-error {
        display: block;
        margin-top: 4px;
        font-size: var(--text-xs);
      }
      .hint {
        color: var(--muted);
      }
      .hint.warn {
        color: var(--warn-ink);
      }
      .field-error {
        color: var(--danger);
      }
    `,
  ],
})
export class AdminBookEditComponent implements OnInit, OnDestroy {
  private admin = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) bookId!: number;
  @Input({ required: true }) book!: AdminBookRecord;
  /** Start with the form open, on a page whose purpose is the edit. */
  @Input() initiallyOpen = false;
  /** The catalogue the stored details came from (`Book.source`). */
  @Input() currentSource: string | null = null;
  /** The record was saved; the page should reload it. */
  @Output() saved = new EventEmitter<void>();
  /** The book was folded into this one and no longer exists. */
  @Output() merged = new EventEmitter<number>();

  open = false;
  form: AdminBookRecord = this.blank();
  /** Where the looked-up details came from, sent with them on Save. */
  lookedUpSource: string | null = null;
  mergeTarget: { id: number; title: string } | null = null;
  isbnError = '';
  /** Why the last Save failed; shown above the button. */
  formError = '';
  titleMissing = false;
  /** The form as it was opened, to tell whether anything was changed. */
  private baseline = '';
  looking = false;
  saving = false;
  private lookup?: Subscription;

  /**
   * The stored ISBN fails today's check (saved before it existed) and is
   * still in the field. Save leaves it alone then, so the other details can
   * still be corrected, but the admin is told it needs fixing.
   */
  get storedIsbnKept(): boolean {
    const stored = this.book.isbn13 || '';
    return !!stored && !bookIsbn(stored) && this.form.isbn13.trim() === stored;
  }

  /**
   * The look-up answered from another catalogue than the stored details
   * came from — say Open Library standing in for a Google Books record
   * because Google found nothing. Saving would swap the record over to it,
   * so the admin is told before they do. Details a seller typed in are not
   * a catalogue's, and any catalogue replacing them needs no warning.
   */
  get sourceChange(): { found: string; current: string } | null {
    const current = this.currentSource;
    const found = this.lookedUpSource;
    if (!found || !current || found === current || !CATALOGUE_SOURCES.has(current)) return null;
    const foundKey = bookSourceLabelKey(found);
    const currentKey = bookSourceLabelKey(current);
    if (!foundKey || !currentKey) return null;
    return { found: this.i18n.t(foundKey), current: this.i18n.t(currentKey) };
  }

  ngOnInit() {
    if (this.initiallyOpen) this.toggle();
  }

  ngOnDestroy() {
    this.cancelLookup();
  }

  toggle() {
    this.open = !this.open;
    this.cancelLookup();
    if (this.open) {
      this.form = { ...this.blank(), ...this.book, isbn13: this.book.isbn13 || '' };
      this.lookedUpSource = null;
      this.mergeTarget = null;
      this.isbnError = '';
      this.formError = '';
      this.titleMissing = false;
      this.baseline = JSON.stringify(this.form);
    }
  }

  /** Open with edits that Save hasn't sent yet. */
  hasUnsavedChanges(): boolean {
    return this.open && JSON.stringify(this.form) !== this.baseline;
  }

  /** A different ISBN: whatever was looked up for the old one no longer applies. */
  onIsbnChange() {
    this.isbnError = '';
    this.mergeTarget = null;
    this.lookedUpSource = null;
    this.cancelLookup();
  }

  lookUp() {
    const isbn = bookIsbn(this.form.isbn13);
    if (!isbn) {
      this.isbnError = this.i18n.t('listing.errInvalidIsbn');
      return;
    }
    this.cancelLookup();
    this.looking = true;
    this.lookup = this.admin.lookupBook(this.bookId, isbn).subscribe({
      next: (found) => {
        this.looking = false;
        // Edited while the request was out: this answer is for another ISBN.
        if (bookIsbn(this.form.isbn13) !== isbn) {
          this.cdr.markForCheck();
          return;
        }
        this.form = {
          isbn13: found.isbn13 ?? isbn,
          title: found.title ?? '',
          authors: found.authors ?? '',
          publisher: found.publisher ?? '',
          published_date: found.published_date ?? '',
          // Keep the current cover when the catalogue has none.
          cover_url: found.cover_url || this.form.cover_url,
        };
        this.lookedUpSource = found.source;
        this.mergeTarget = found.existing_book;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.looking = false;
        this.isbnError = parseAdminError(err, this.i18n, 'admin.errGeneric');
        this.cdr.markForCheck();
      },
    });
  }

  save(merge = false) {
    this.titleMissing = !this.form.title.trim();
    // The ISBN goes only when it was changed, as the seller's listing edit
    // does: an old, invalid one left as it is mustn't block the other fixes.
    const raw = this.form.isbn13.trim();
    const changed = raw !== (this.book.isbn13 || '');
    const isbn = !changed ? undefined : raw ? bookIsbn(raw) : '';
    if (isbn === null) this.isbnError = this.i18n.t('listing.errInvalidIsbn');
    if (this.titleMissing || isbn === null) return;

    this.cancelLookup();
    this.saving = true;
    this.formError = '';
    const { isbn13: _, ...details } = this.form;
    const changes = {
      ...details,
      ...(isbn !== undefined ? { isbn13: isbn } : {}),
      ...(this.lookedUpSource ? { source: this.lookedUpSource } : {}),
      ...(merge ? { merge: true } : {}),
    };
    this.admin.updateBook(this.bookId, changes).subscribe({
      next: (res) => {
        this.saving = false;
        this.open = false;
        this.toast.success(
          this.i18n.t(res.merged_into ? 'admin.book.mergedToast' : 'admin.book.savedToast'),
        );
        this.cdr.markForCheck();
        if (res.merged_into) this.merged.emit(res.merged_into);
        else this.saved.emit();
      },
      error: async (err) => {
        this.saving = false;
        this.cdr.markForCheck();
        const existing = err?.status === 409 ? err.error?.error?.existing_book : null;
        if (existing && !merge) {
          const ok = await this.confirms.askDanger(
            this.i18n.t('admin.book.confirmMerge', { title: existing.title }),
            {
              confirmLabel: this.i18n.t('admin.book.merge'),
            },
          );
          if (ok) this.save(true);
          return;
        }
        this.formError = parseAdminError(err, this.i18n, 'admin.errGeneric');
        this.cdr.markForCheck();
      },
    });
  }

  private cancelLookup() {
    this.lookup?.unsubscribe();
    this.lookup = undefined;
    this.looking = false;
  }

  private blank(): AdminBookRecord {
    return { isbn13: '', title: '', authors: '', publisher: '', published_date: '', cover_url: '' };
  }
}
