import { UiButton } from '../../shared/ui/button.component';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { AdminService } from '../../core/services/admin.service';
import { RegionService } from '../../core/region.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { translateApiError } from '../../core/api-error.util';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';

/**
 * The CycleUni/SchoolList fixture published for each region:
 * schools.TW.json, schools.HK.json, ... A regional admin importing the whole
 * schools.json would only see the other regions' rows come back forbidden.
 */
export function defaultSchoolsJsonUrl(region: string): string {
  return `https://raw.githubusercontent.com/CycleUni/SchoolList/refs/heads/main/schools.${region.toUpperCase()}.json`;
}

@Component({
  selector: 'app-bulk-import-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, UiTextarea, TPipe, UiButton, UiFocusTrapDirective],
  template: `
    <div class="app-modal-overlay" *ngIf="show" (click)="close.emit()">
      <div class="app-modal import-modal" (click)="$event.stopPropagation()" uiFocusTrap="bulk-import-title" (escape)="close.emit()">
        <h3 id="bulk-import-title" class="app-modal-title">{{ 'admin.bulkImport' | t }}</h3>

        <div class="app-modal-body">
          <div *ngIf="step === 'input'">
            <div class="form-group">
              <label>{{ 'admin.importJsonUrlLabel' | t }}</label>
              <div class="url-input-row">
                <input type="text" class="input" [(ngModel)]="jsonUrl" placeholder="https://example.com/data.json">
                <ui-button size="sm" variant="outline" (onClick)="fetchJson()" [disabled]="loading">
                  {{ (loading && loadingAction === 'fetch' ? 'admin.importFetching' : 'admin.importFetch') | t }}
                </ui-button>
              </div>
            </div>
            <div class="form-group">
              <label>{{ 'admin.importPasteJsonLabel' | t }}</label>
              <ui-textarea class="json-textarea" [(ngModel)]="jsonText" [placeholder]="sampleFormat" [monospace]="true" [rows]="12"></ui-textarea>
            </div>
            <div class="diff-section" *ngIf="diff.forbidden?.length">
              <h4>{{ 'admin.importForbiddenSection' | t }} ({{ diff.forbidden.length }})</h4>
              <div class="hint mb-2"  style="color: var(--danger);">{{ 'admin.importForbiddenHint' | t }}</div>
              <div class="diff-box">
                <pre class="old" *ngFor="let text of previewForbiddenItems">{{ text }}</pre>
              </div>
              <div class="hint" *ngIf="hiddenForbiddenCount > 0">{{ 'admin.importHiddenForbidden' | t:{n: hiddenForbiddenCount} }}</div>
            </div>
            <div class="error" *ngIf="errorMsg">{{ errorMsg }}</div>
          </div>

          <div *ngIf="step === 'preview'">
            <div class="summary-section">
              <h4>{{ 'admin.importSummary' | t }}</h4>
              <ul class="summary-list">
                <li>{{ 'admin.importSummaryNew' | t:{n: newCount} }}</li>
                <li>{{ 'admin.importSummaryModified' | t:{n: modifiedCount} }}</li>
                <li>{{ 'admin.importSummaryUnchanged' | t:{n: unchangedCount} }}</li>
                <li *ngIf="forbiddenCount > 0" class="old">{{ 'admin.importForbiddenSummary' | t:{n: forbiddenCount} }}</li>
              </ul>
              <div class="hint" *ngIf="totalCount === 0">{{ 'admin.importNoValidChanges' | t }}</div>
            </div>
            <div class="warning" *ngIf="warningMsg">{{ warningMsg }}</div>
            <div class="diff-section" *ngIf="diff.new?.length">
              <h4>{{ 'admin.importSectionNew' | t }} ({{ diff.new.length }})</h4>
              <div class="diff-box">
                <pre *ngFor="let text of previewNewItems">{{ text }}</pre>
              </div>
              <div class="hint" *ngIf="hiddenNewCount > 0">{{ 'admin.importHiddenNew' | t:{n: hiddenNewCount} }}</div>
            </div>
            <div class="diff-section" *ngIf="diff.modified?.length">
              <h4>{{ 'admin.importSectionModified' | t }} ({{ diff.modified.length }})</h4>
              <div class="diff-box diff-modified">
                <div *ngFor="let item of previewModifiedItems" class="diff-item">
                  <div class="old">{{ 'admin.importDiffOld' | t }} <pre>{{ item.oldText }}</pre></div>
                  <div class="new">{{ 'admin.importDiffNew' | t }} <pre>{{ item.newText }}</pre></div>
                </div>
              </div>
              <div class="hint" *ngIf="hiddenModifiedCount > 0">{{ 'admin.importHiddenModified' | t:{n: hiddenModifiedCount} }}</div>
            </div>
            <div class="diff-section" *ngIf="diff.unchanged?.length">
              <h4>{{ 'admin.importSectionUnchanged' | t }} ({{ diff.unchanged.length }})</h4>
            </div>
            <div class="error" *ngIf="errorMsg">{{ errorMsg }}</div>
          </div>
          <div class="loading-note" *ngIf="loading">{{ loadingText | t }}</div>
        </div>

        <div class="app-modal-actions">
          <ui-button variant="secondary" (onClick)="close.emit()">{{ 'common.cancel' | t }}</ui-button>
          <ui-button variant="primary" *ngIf="step === 'input'" (onClick)="preview()" [disabled]="loading">
            {{ (loading && loadingAction === 'preview' ? 'admin.importPreviewing' : 'admin.importPreview') | t }}
          </ui-button>
          <ui-button variant="primary" *ngIf="step === 'preview'" (onClick)="apply()" [disabled]="loading">
            {{ (loading && loadingAction === 'apply' ? 'admin.importApplying' : 'admin.importApply') | t }}
          </ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .import-modal { width: 600px; max-width: 90%; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-weight: 600; font-size: var(--text-base); }
    .input { 
      width: 100%; 
      padding: 8px 12px; 
      border: 1px solid var(--line-strong); 
      border-radius: var(--radius-control); 
      box-sizing: border-box; 
      font-family: inherit; 
      background-color: var(--paper);
      color: var(--ink);
    }
    .input::placeholder {
      color: var(--muted);
    }
    .input:focus-visible {
      border-bottom-color: var(--accent);
      outline: 2px solid transparent;
    }
    .url-input-row { display: flex; gap: 8px; }
    ui-textarea.json-textarea { display: block; margin-bottom: 0; }
    .loading-note { margin-top: 8px; font-size: var(--text-sm); color: var(--muted); text-align: right; }
    .error { color: var(--danger); margin-bottom: 16px; font-size: var(--text-base); }
    .warning { color: var(--ink); margin-bottom: 16px; font-size: var(--text-base); }
    .hint { color: var(--ink); font-size: var(--text-sm); }
    .summary-section { margin-bottom: 16px; }
    .summary-section h4 { margin: 0 0 8px 0; color: var(--ink); }
    .summary-list { margin: 0 0 8px 0; padding-left: 18px; }
    
    .diff-section { margin-bottom: 24px; }
    .diff-section h4 { margin: 0 0 8px 0; color: var(--ink); }
    .diff-box { background: var(--paper-warm); padding: 12px; border-radius: 4px; max-height: 200px; overflow-y: auto; font-size: var(--text-xs); font-family: monospace; }
    .diff-item { border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 8px; }
    .diff-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .old { color: var(--danger); }
    .new { color: var(--success); }
  `]
})
export class BulkImportModalComponent implements OnChanges {
  readonly PREVIEW_ITEM_LIMIT = 50;

  @Input() show = false;
  @Input() endpoint!: 'schools' | 'categories';
  @Output() close = new EventEmitter<void>();
  @Output() imported = new EventEmitter<void>();

  /**
   * The placeholder shows the shape of an import for the region being
   * managed. It used to be Taiwan's whatever the region — NTU with a zh-TW
   * name — and put the Chinese name in `name`, which is the canonical
   * English one; followed as written, a Hong Kong file came out wrong twice.
   */
  get sampleFormat(): string {
    const lang = this.regionService.translationLanguages()[0] || 'zh-TW';
    if (this.endpoint === 'schools') {
      const example = this.regionService.region() === 'hk'
        ? { name: 'The University of Hong Kong', email_domain: 'hku.hk', code: 'HKU', local: '香港大學' }
        : { name: 'National Taiwan University', email_domain: 'ntu.edu.tw', code: 'NTU', local: '國立臺灣大學' };
      return JSON.stringify([{
        name: example.name,
        email_domain: example.email_domain,
        code: example.code,
        translations: { [lang]: { name: example.local } },
      }], null, 2);
    }
    return JSON.stringify([{
      slug: 'csci',
      title: 'Computer Science',
      description: 'CS related departments',
      sort_order: 10,
      is_active: true,
      translations: { [lang]: { title: '資訊工程', description: '資訊相關科系' } },
    }], null, 2);
  }

  /**
   * Opening the school import fills in this region's SchoolList URL, so
   * importing the maintained list is Fetch then Preview. A URL the admin typed
   * is kept; one we filled in earlier follows the region the modal opens in.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['show'] || !this.show || this.endpoint !== 'schools') return;
    const url = defaultSchoolsJsonUrl(this.regionService.region());
    if (!this.jsonUrl || this.jsonUrl === this.filledUrl) {
      this.jsonUrl = url;
      this.filledUrl = url;
    }
  }

  private filledUrl = '';
  private adminService = inject(AdminService);
  private regionService = inject(RegionService);
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);

  step: 'input' | 'preview' = 'input';
  jsonUrl = '';
  jsonText = '';
  errorMsg = '';
  warningMsg = '';
  loading = false;
  loadingAction: 'fetch' | 'preview' | 'apply' | null = null;
  diff: any = {};
  parsedItems: any[] = [];
  previewNewItems: string[] = [];
  previewModifiedItems: Array<{ oldText: string; newText: string }> = [];
  previewForbiddenItems: string[] = [];
  hiddenNewCount = 0;
  hiddenModifiedCount = 0;
  hiddenForbiddenCount = 0;
  
  get newCount(): number { return this.diff.new?.length ?? 0; }
  get modifiedCount(): number { return this.diff.modified?.length ?? 0; }
  get unchangedCount(): number { return this.diff.unchanged?.length ?? 0; }
  get forbiddenCount(): number { return this.diff.forbidden?.length ?? 0; }
  get totalCount(): number { return this.newCount + this.modifiedCount + this.unchangedCount + this.forbiddenCount; }
  get loadingText(): string {
    if (!this.loading) return '';
    if (this.loadingAction === 'fetch') return 'admin.importLoadingFetch';
    if (this.loadingAction === 'preview') return 'admin.importLoadingPreview';
    if (this.loadingAction === 'apply') return 'admin.importLoadingApply';
    return 'admin.importLoadingGeneric';
  }

  fetchJson() {
    if (!this.jsonUrl) return;
    this.loading = true;
    this.loadingAction = 'fetch';
    this.errorMsg = '';
    this.http.get(this.jsonUrl).subscribe({
      next: (data: any) => {
        this.jsonText = JSON.stringify(data, null, 2);
        this.loading = false;
        this.loadingAction = null;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.errorMsg = this.i18n.t('admin.importErrFetchFailed');
        this.loading = false;
        this.loadingAction = null;
        this.cdr.markForCheck();
      }
    });
  }

  preview() {
    this.errorMsg = '';
    this.warningMsg = '';
    let parsed: any;
    try {
      parsed = JSON.parse(this.jsonText);
    } catch (e: any) {
      this.errorMsg = this.i18n.t('admin.importErrInvalidJson', { message: e.message });
      return;
    }
    if (Array.isArray(parsed)) {
      this.parsedItems = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      this.parsedItems = parsed.items;
    } else {
      this.errorMsg = this.i18n.t('admin.importErrJsonShape');
      return;
    }

    if (!this.parsedItems.length) {
      this.errorMsg = this.i18n.t('admin.importErrNoItems');
      return;
    }

    const validItems: any[] = [];
    let invalidCount = 0;
    for (const item of this.parsedItems) {
      if (this.isValidItem(item)) {
        validItems.push(item);
      } else {
        invalidCount += 1;
      }
    }
    if (!validItems.length) {
      this.errorMsg = this.i18n.t(this.endpoint === 'schools'
        ? 'admin.importErrAllInvalidSchools'
        : 'admin.importErrAllInvalidCategories');
      return;
    }
    if (invalidCount > 0) {
      this.warningMsg = this.i18n.t('admin.importWarnSkipped', { n: invalidCount });
    }
    this.parsedItems = validItems;

    this.loading = true;
    this.loadingAction = 'preview';
    this.adminService.bulkImport(this.endpoint, 'preview', this.parsedItems).subscribe({
      next: (diff: any) => {
        this.diff = diff;
        this.buildPreviewDiff(diff);
        this.step = 'preview';
        this.loading = false;
        this.loadingAction = null;
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        this.errorMsg = this.i18n.t('admin.importErrPreviewFailed', { message: this.errorDetail(err) });
        this.loading = false;
        this.loadingAction = null;
        this.cdr.markForCheck();
      }
    });
  }

  private buildPreviewDiff(diff: any): void {
    const previewLimit = this.PREVIEW_ITEM_LIMIT;
    const newItems = Array.isArray(diff?.new) ? diff.new : [];
    const modifiedItems = Array.isArray(diff?.modified) ? diff.modified : [];
    const forbiddenItems = Array.isArray(diff?.forbidden) ? diff.forbidden : [];

    this.previewNewItems = newItems
      .slice(0, previewLimit)
      .map((item: unknown) => this.stringifyForPreview(item));
    this.hiddenNewCount = Math.max(newItems.length - this.previewNewItems.length, 0);

    this.previewModifiedItems = modifiedItems
      .slice(0, previewLimit)
      .map((item: any) => ({
        oldText: this.stringifyForPreview(item?.old),
        newText: this.stringifyForPreview(item?.new),
      }));
    this.hiddenModifiedCount = Math.max(modifiedItems.length - this.previewModifiedItems.length, 0);

    this.previewForbiddenItems = forbiddenItems
      .slice(0, previewLimit)
      .map((item: unknown) => this.stringifyForPreview(item));
    this.hiddenForbiddenCount = Math.max(forbiddenItems.length - this.previewForbiddenItems.length, 0);
  }

  private stringifyForPreview(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return this.i18n.t('admin.importUnserializableItem');
    }
  }

  /**
   * What went wrong, for the "failed" message. Most failures here are a plain
   * string in `error`; a school code that is malformed or already used in
   * this region comes back as a code to translate plus the domains at fault,
   * and printing that object as-is showed "[object Object]".
   */
  private errorDetail(err: any): string {
    const body = err?.error?.error;
    if (typeof body === 'string') return body;
    const translated = translateApiError(err, this.i18n);
    if (translated) {
      const domains: unknown = body?.domains;
      return Array.isArray(domains) && domains.length ? `${translated} (${domains.join(', ')})` : translated;
    }
    return err?.message || '';
  }

  private isValidItem(item: any): boolean {
    if (!item || typeof item !== 'object') return false;
    if (this.endpoint === 'schools') {
      return typeof item.email_domain === 'string' && item.email_domain.trim().length > 0;
    }
    return typeof item.slug === 'string' && item.slug.trim().length > 0;
  }

  apply() {
    this.loading = true;
    this.loadingAction = 'apply';
    this.adminService.bulkImport(this.endpoint, 'apply', this.parsedItems).subscribe({
      next: () => {
        this.loading = false;
        this.loadingAction = null;
        this.imported.emit();
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        this.errorMsg = this.i18n.t('admin.importErrApplyFailed', { message: this.errorDetail(err) });
        this.loading = false;
        this.loadingAction = null;
        this.cdr.markForCheck();
      }
    });
  }
}
