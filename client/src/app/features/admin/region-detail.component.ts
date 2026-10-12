import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminRegion, AdminCurrency } from '../../core/services/admin.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { ToastService } from '../../core/services/toast.service';
import { parseAdminError } from '../../core/admin-error.util';
import { Lang } from '../../core/i18n';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiButton } from '../../shared/ui/button.component';

@Component({
  selector: 'app-admin-region-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TPipe, UiErrorState, UiSkeleton, RegionLinkDirective, UiDropdown, UiInput, UiButton, UiCheckbox],
  template: `
    <ui-skeleton *ngIf="!item && !loadError" variant="form" [count]="4"></ui-skeleton>
    <!-- A failed load used to bounce back to the list without a word. -->
    <ui-error-state *ngIf="!item && loadError" [message]="loadError" (retry)="load()"></ui-error-state>
    <div class="admin-detail-header" *ngIf="item">
      <a [regionLink]="['/admin', 'regions']" class="back-link">&larr; {{ 'admin.backToList' | t }}</a>
      <h2>{{ 'admin.editRegion' | t }} - {{ item.code }}</h2>
    </div>

    <div class="detail-card" *ngIf="item">
      <div class="form-group">
        <label>{{ 'admin.regionCode' | t }}</label>
        <ui-input [value]="item.code" [disabled]="true"></ui-input>
      </div>
      <ui-input [label]="'admin.regionName' | t" [(ngModel)]="item.name"></ui-input>
      
      <ui-dropdown [label]="'admin.regionCurrency' | t" [options]="currencyOptions" [(ngModel)]="item.currency"></ui-dropdown>

      <div class="form-group">
        <label>{{ 'admin.regionLanguages' | t }}</label>
        <p class="text-hint">{{ 'admin.langNotice' | t }}</p>
        <div class="checkbox-group">
          <ui-checkbox *ngFor="let lang of availableLangs" [checked]="hasLang(lang)" (change)="toggleLang(lang)" [label]="lang"></ui-checkbox>
        </div>
        <div *ngIf="langError" class="inline-msg error">{{ langError | t }}</div>
      </div>

      <ui-dropdown [label]="'admin.regionDefaultLang' | t" [options]="languageOptions" [(ngModel)]="item.default_language"></ui-dropdown>
      <div *ngIf="defaultLangError" class="inline-msg error">{{ defaultLangError | t }}</div>

      <div class="form-group">
        <label>{{ 'admin.translationsSection' | t }}</label>
        <div *ngFor="let lang of item.languages" class="translation-row">
          <span class="lang-tag">{{ lang }}</span>
          <input type="text" class="admin-form-control" [placeholder]="'admin.regionName' | t" [(ngModel)]="item.translations[lang].name">
        </div>
        <div *ngIf="transError" class="inline-msg error">{{ transError | t }}</div>
      </div>

      <ui-input [label]="'admin.regionTimezone' | t" [(ngModel)]="item.timezone" placeholder="Asia/Taipei"></ui-input>
      <ui-input [label]="'admin.regionEduSuffix' | t" [(ngModel)]="eduSuffixString" placeholder=".edu.hk, .edu, .hk"></ui-input>

      <div class="form-group">
        <label>{{ 'admin.regionSearchEngines' | t }}</label>
        <div class="checkbox-group">
          <ui-checkbox *ngFor="let se of allSearchEngines" [checked]="hasSearchEngine(se)" (change)="toggleSearchEngine(se)" [label]="se"></ui-checkbox>
        </div>
      </div>

      <ui-input [label]="'admin.regionSortOrder' | t" type="number" [(ngModel)]="item.sort_order"></ui-input>

      <div class="toggle-row">
        <ui-checkbox [(ngModel)]="item.is_active" [label]="'admin.regionIsActive' | t"></ui-checkbox>
      </div>

      <div *ngIf="errorMsg" class="inline-msg error">{{ errorMsg }}</div>
      <div *ngIf="savedMsg" class="inline-msg ok">{{ savedMsg }}</div>

      <ui-button (onClick)="save()" [disabled]="saving">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
    </div>
  `,
  styles: [`
    .detail-card {
      background: var(--surface-card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      max-width: 520px;
      box-shadow: var(--shadow-card-lg);
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: var(--text-base); font-weight: 600; }
    .checkbox-group { display: flex; gap: 16px; flex-wrap: wrap; }
    .checkbox-group label { display: flex; align-items: center; gap: 4px; font-weight: normal; margin-bottom: 0; }
    .text-hint { font-size: var(--text-sm); color: var(--muted); margin-top: -4px; margin-bottom: 8px; }
    .translation-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .lang-tag { flex: 0 0 auto; padding: 4px 8px; border-radius: 4px; background: var(--paper-warm); font-size: var(--text-xs); font-weight: 600; width: 60px; text-align: center; }
    .toggle-row {
      display: flex;
      gap: 24px;
      margin: 16px 0;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: var(--text-base);
      cursor: pointer;
    }
  `]
})
export class AdminRegionDetailComponent implements OnInit {
  private adminService = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);

  item?: AdminRegion;
  currencies: AdminCurrency[] = [];
  saving = false;

  availableLangs: string[] = ['en', 'zh-TW', 'zh-HK'];
  allSearchEngines = ['googlebooks', 'openlibrary', 'isbnnet'];
  translations: Record<string, string> = {};
  errorMsg = '';
  savedMsg = '';

  get currencyOptions() {
    return this.currencies.map(c => ({ value: c.code, label: `${c.code} (${c.symbol})` }));
  }

  get languageOptions() {
    return (this.item?.languages || []).map(l => ({ value: l, label: l }));
  }

  langError = '';
  defaultLangError = '';
  transError = '';

  get eduSuffixString() {
    return (this.item?.edu_email_suffix || []).join(', ');
  }
  set eduSuffixString(val: string) {
    if (this.item) {
      this.item.edu_email_suffix = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
  }

  /** Why the last load failed. */
  loadError = '';

  ngOnInit() {
    this.adminService.getCurrencies().subscribe(res => {
      this.currencies = Array.isArray(res) ? res : res.results;
      this.cdr.markForCheck();
    });
    
    this.load();
  }

  load() {
    const code = this.route.snapshot.paramMap.get('id');
    this.loadError = '';
    if (code) {
      this.adminService.getRegion(code).subscribe({
        next: (res) => {
          this.item = res;
          this.translations = {};
          if (res.translations) {
            for (const lang of Object.keys(res.translations)) {
              if (res.translations[lang]?.name) {
                this.translations[lang] = res.translations[lang].name;
              }
            }
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.cdr.markForCheck();
        }
      });
    }
  }

  hasLang(lang: string) { return this.item?.languages?.includes(lang); }
  toggleLang(lang: string) {
    if (!this.item) return;
    let langs = this.item.languages || [];
    if (langs.includes(lang)) langs = langs.filter(l => l !== lang);
    else langs = [...langs, lang];
    this.item.languages = langs;
    if (!langs.includes(this.item.default_language!)) {
      this.item.default_language = langs[0] || '';
    }
  }

  hasSearchEngine(se: string) { return this.item?.search_engines?.includes(se); }
  toggleSearchEngine(se: string) {
    if (!this.item) return;
    let ses = this.item.search_engines || [];
    if (ses.includes(se)) ses = ses.filter(s => s !== se);
    else ses = [...ses, se];
    this.item.search_engines = ses;
  }

  save() {
    if (!this.item) return;
    this.langError = '';
    this.transError = '';
    this.defaultLangError = '';
    
    if (!this.item.languages || this.item.languages.length === 0) {
      this.langError = 'admin.languagesRequired';
      return;
    }
    if (!this.item.languages.includes(this.item.default_language!)) {
      this.defaultLangError = 'admin.defaultLanguageMustBeInLanguages';
      return;
    }
    
    let hasTrans = false;
    const transData: any = {};
    for (const lang of this.item.languages) {
      if (this.translations[lang]?.trim()) {
        transData[lang] = { name: this.translations[lang].trim() };
        hasTrans = true;
      }
    }
    if (!hasTrans) {
      this.transError = 'admin.translationsRequired';
      return;
    }
    this.item.translations = transData;

    this.saving = true;
    this.cdr.markForCheck();
    
    const payload = { ...this.item };
    delete (payload as any).code;

    this.adminService.updateRegion(this.item.code, payload).subscribe({
      next: () => {
        this.saving = false;
        this.toast.success(this.i18n.t('admin.saved'));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      }
    });
  }
}
