import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminRegion, Paginated, AdminCurrency } from '../../core/services/admin.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { parseAdminError } from '../../core/admin-error.util';
import { Lang } from '../../core/i18n';

@Component({
  selector: 'app-admin-regions-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiPagination, UiDropdown, UiInput, UiButton, UiErrorState, UiCheckbox, UiFocusTrapDirective],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navRegions' | t }}</h2>
      <ui-button (onClick)="openCreateModal()">{{ 'admin.addRegion' | t }}</ui-button>
    </div>

    <ui-skeleton *ngIf="!data && loading" variant="table" [count]="5"></ui-skeleton>
    <!-- A failed load used to leave the page with its heading and nothing
         under it, which read as an empty list rather than an error. -->
    <ui-error-state
      *ngIf="loadFailed"
      [message]="'admin.errLoadFailed' | t"
      (retry)="loadPage(currentPage)"
    ></ui-error-state>
    <div class="table-container" *ngIf="data && !loadFailed">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ 'admin.regionCode' | t }}</th>
            <th>{{ 'admin.regionName' | t }}</th>
            <th>{{ 'admin.regionCurrency' | t }}</th>
            <th>{{ 'admin.regionIsActive' | t }}</th>
            <th>{{ 'admin.colActions' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let item of data.results">
            <td>{{ item.code }}</td>
            <td>{{ item.display_name }}</td>
            <td>{{ item.currency }}</td>
            <td>{{ item.is_active ? ('admin.yes' | t) : ('admin.no' | t) }}</td>
            <td>
              <ui-button size="sm" variant="outline" [link]="[item.code]">{{ 'common.edit' | t }}</ui-button>
            </td>
          </tr>
        </tbody>
      </table>
      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="currentPage" (pageChange)="loadPage($event)"></ui-pagination>
    </div>

    <div class="app-modal-overlay" *ngIf="showCreateModal" (click)="showCreateModal = false">
      <div class="app-modal"  style="width: 550px; max-width: 95%; max-height: 90vh; overflow-y: auto;" (click)="$event.stopPropagation()" uiFocusTrap="regions-modal-title" (escape)="showCreateModal = false">
        <h3 id="regions-modal-title" class="app-modal-title">{{ 'admin.addRegion' | t }}</h3>
        <div class="app-modal-body">
          <ui-input [label]="'admin.regionCode' | t" [(ngModel)]="newItem.code"></ui-input>
          <ui-input [label]="'admin.regionName' | t" [(ngModel)]="newItem.name"></ui-input>
          
          <ui-dropdown [label]="'admin.regionCurrency' | t" [options]="currencyOptions" [(ngModel)]="newItem.currency"></ui-dropdown>

          <div class="form-group">
            <label>{{ 'admin.regionLanguages' | t }}</label>
            <p class="text-hint">{{ 'admin.langNotice' | t }}</p>
            <div class="checkbox-group">
              <ui-checkbox *ngFor="let lang of availableLangs" [checked]="hasLang(lang)" (change)="toggleLang(lang)" [label]="lang"></ui-checkbox>
            </div>
            <div *ngIf="langError" class="inline-msg error">{{ langError | t }}</div>
          </div>
          
          <ui-dropdown [label]="'admin.regionDefaultLang' | t" [options]="languageOptions" [(ngModel)]="newItem.default_language"></ui-dropdown>
          <div *ngIf="defaultLangError" class="inline-msg error">{{ defaultLangError | t }}</div>

          <div class="form-group">
            <label>{{ 'admin.translationsSection' | t }}</label>
            <div *ngFor="let lang of newItem.languages" class="translation-row">
              <span class="lang-tag">{{ lang }}</span>
              <input type="text" class="admin-form-control" [placeholder]="'admin.regionName' | t" [(ngModel)]="newTranslations[lang]">
            </div>
            <div *ngIf="transError" class="inline-msg error">{{ transError | t }}</div>
          </div>

          <ui-input [label]="'admin.regionTimezone' | t" [(ngModel)]="newItem.timezone" placeholder="Asia/Taipei"></ui-input>
          <ui-input [label]="'admin.regionEduSuffix' | t" [(ngModel)]="eduSuffixString" placeholder=".edu.hk, .edu, .hk"></ui-input>

          <div class="form-group">
            <label>{{ 'admin.regionSearchEngines' | t }}</label>
            <div class="checkbox-group">
              <ui-checkbox *ngFor="let se of allSearchEngines" [checked]="hasSearchEngine(se)" (change)="toggleSearchEngine(se)" [label]="se"></ui-checkbox>
            </div>
          </div>

          <ui-input [label]="'admin.regionSortOrder' | t" type="number" [(ngModel)]="newItem.sort_order"></ui-input>

          <div class="form-group">
            <ui-checkbox [(ngModel)]="newItem.is_active" [label]="'admin.regionIsActive' | t"></ui-checkbox>
          </div>
          
          <div *ngIf="errorMsg" class="inline-msg error">{{ errorMsg }}</div>
        </div>
        <div class="app-modal-actions"  style="display: flex; justify-content: flex-end; gap: 8px; padding-top: 16px;">
          <ui-button variant="ghost" (onClick)="showCreateModal = false" [disabled]="saving">{{ 'common.cancel' | t }}</ui-button>
          <ui-button (onClick)="create()" [disabled]="saving">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: var(--text-base); font-weight: 600; }
    .checkbox-group { display: flex; gap: 16px; flex-wrap: wrap; }
    .checkbox-group label { display: flex; align-items: center; gap: 4px; font-weight: normal; margin-bottom: 0; }
    .text-hint { font-size: var(--text-sm); color: var(--muted); margin-top: -4px; margin-bottom: 8px; }
    .translation-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .lang-tag { flex: 0 0 auto; padding: 4px 8px; border-radius: 4px; background: var(--paper-warm); font-size: var(--text-xs); font-weight: 600; width: 60px; text-align: center; }
  `]
})
export class AdminRegionsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);

  data?: Paginated<AdminRegion>;
  loading = true;
  loadFailed = false;
  currencies: AdminCurrency[] = [];
  currentPage = 1;
  total = 0;
  pageSize = 20;

  showCreateModal = false;
  newItem: Partial<AdminRegion> = this.getEmptyItem();
  newTranslations: Record<string, string> = {};
  
  // Available langs from frontend dictionary constraint
  availableLangs: string[] = ['en', 'zh-TW', 'zh-HK'];
  allSearchEngines = ['googlebooks', 'openlibrary', 'isbnnet'];

  get currencyOptions() {
    return this.currencies.map(c => ({ value: c.code, label: `${c.code} (${c.symbol})` }));
  }

  get languageOptions() {
    return (this.newItem.languages || []).map(l => ({ value: l, label: l }));
  }
  
  langError = '';
  defaultLangError = '';
  transError = '';
  errorMsg = '';
  saving = false;

  ngOnInit() {
    this.loadPage(1);
    this.adminService.getCurrencies().subscribe(res => {
      this.currencies = Array.isArray(res) ? res : res.results;
      this.cdr.markForCheck();
    });
  }

  get eduSuffixString() {
    return (this.newItem?.edu_email_suffix || []).join(', ');
  }
  set eduSuffixString(val: string) {
    if (this.newItem) {
      this.newItem.edu_email_suffix = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
  }

  getEmptyItem(): Partial<AdminRegion> {
    return { 
      code: '', name: '', currency: '', default_language: 'en', 
      languages: ['en'], timezone: 'Asia/Taipei', search_engines: ['openlibrary'],
      edu_email_suffix: [], is_active: true, sort_order: 0 
    };
  }

  loadPage(page: number) {
    this.currentPage = page;
    this.loadFailed = false;
    this.loading = true;
    this.adminService.getRegions().subscribe({
      next: (res) => {
        if (Array.isArray(res)) {
           this.data = { count: res.length, results: res, next: null, previous: null } as any;
           this.total = res.length;
        } else {
           this.data = res;
           this.total = res.count;
        }
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.loadFailed = true;
        this.cdr.markForCheck();
      }
    });
  }

  openCreateModal() {
    this.newItem = this.getEmptyItem();
    this.newTranslations = {};
    this.langError = '';
    this.transError = '';
    this.defaultLangError = '';
    this.errorMsg = '';
    this.saving = false;
    this.showCreateModal = true;
  }

  hasLang(lang: string) { return this.newItem.languages?.includes(lang); }
  toggleLang(lang: string) {
    let langs = this.newItem.languages || [];
    if (langs.includes(lang)) langs = langs.filter(l => l !== lang);
    else langs = [...langs, lang];
    this.newItem.languages = langs;
    if (!langs.includes(this.newItem.default_language!)) {
      this.newItem.default_language = langs[0] || '';
    }
  }

  hasSearchEngine(se: string) { return this.newItem.search_engines?.includes(se); }
  toggleSearchEngine(se: string) {
    let ses = this.newItem.search_engines || [];
    if (ses.includes(se)) ses = ses.filter(s => s !== se);
    else ses = [...ses, se];
    this.newItem.search_engines = ses;
  }

  create() {
    this.langError = '';
    this.transError = '';
    this.defaultLangError = '';
    this.errorMsg = '';
    
    if (!this.newItem.languages || this.newItem.languages.length === 0) {
      this.langError = 'admin.languagesRequired';
      return;
    }
    if (!this.newItem.languages.includes(this.newItem.default_language!)) {
      this.defaultLangError = 'admin.defaultLanguageMustBeInLanguages';
      return;
    }
    
    let hasTrans = false;
    const transData: any = {};
    for (const lang of this.newItem.languages) {
      if (this.newTranslations[lang]?.trim()) {
        transData[lang] = { name: this.newTranslations[lang].trim() };
        hasTrans = true;
      }
    }
    if (!hasTrans) {
      this.transError = 'admin.translationsRequired';
      return;
    }
    this.newItem.translations = transData;
    
    this.saving = true;
    this.adminService.createRegion(this.newItem).subscribe({
      next: () => {
        this.saving = false;
        this.showCreateModal = false;
        this.loadPage(1);
      },
      error: (err) => {
        this.saving = false;
        this.errorMsg = parseAdminError(err, this.i18n);
        this.cdr.markForCheck();
      }
    });
  }
}
