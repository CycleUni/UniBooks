import { Component, ChangeDetectorRef, OnInit, inject, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { TPipe, I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';
import { SchoolOption, SchoolStateService } from '../../core/services/school-state.service';
import { MetadataService } from '../../core/services/metadata.service';
import { injectIsPhone } from '../../core/viewport';
import { keywordsMatch, schoolKeywords } from '../../core/school-search';
import { UiButton } from './button.component';
import { UiInput } from './input.component';
import { UiBottomSheet } from './bottom-sheet.component';
import { UiFocusTrapDirective } from './focus-trap.directive';
import { SchoolRequestFormComponent } from '../../features/account/school-request-form.component';

@Component({
  selector: 'ui-welcome-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TPipe,
    UiButton,
    UiInput,
    UiBottomSheet,
    UiFocusTrapDirective,
    SchoolRequestFormComponent,
  ],
  template: `
    @if (isOpen) {
      @if (isPhone()) {
        <ui-bottom-sheet [title]="sheetTitle" (closed)="onSkip()">
          <ng-container *ngTemplateOutlet="contentTpl"></ng-container>
        </ui-bottom-sheet>
      } @else {
        <div class="welcome-overlay" (click)="onOverlayClick($event)">
          <div
            class="welcome-dialog"
            uiFocusTrap="welcome-title"
            (click)="$event.stopPropagation()"
            (escape)="onSkip()"
          >
            <h2 id="welcome-title" class="welcome-heading">{{ sheetTitle }}</h2>
            <ng-container *ngTemplateOutlet="contentTpl"></ng-container>
          </div>
        </div>
      }

      <ng-template #contentTpl>
        <div class="welcome-body" data-testid="welcome-dialog">
          @if (step === 'school') {
            <p class="welcome-desc">{{ 'welcome.desc' | t }}</p>

            <div class="search-box">
              <ui-input
                name="school_search"
                [(ngModel)]="searchQuery"
                (ngModelChange)="onSearchChange()"
                [placeholder]="'welcome.selectSchool' | t"
                [attr.aria-label]="'welcome.selectSchool' | t"
              ></ui-input>
            </div>

            <div class="school-list" role="listbox" [attr.aria-label]="'welcome.selectSchool' | t">
              @for (school of filteredSchools; track school.id) {
                <button
                  type="button"
                  class="school-option"
                  [class.selected]="selectedSchool?.id === school.id"
                  (click)="selectSchool(school)"
                  role="option"
                  [attr.aria-selected]="selectedSchool?.id === school.id"
                >
                  <span class="school-name">{{ school.display_name || school.name }}</span>
                  @if (school.code) {
                    <code class="school-code">{{ school.code }}</code>
                  }
                </button>
              }
              @if (filteredSchools.length === 0) {
                <div class="no-results">{{ 'search.noResults' | t }}</div>
              }
            </div>

            <div class="request-link-row">
              <button
                type="button"
                class="link-btn"
                (click)="toggleSchoolRequest()"
              >
                {{ 'welcome.schoolNotListed' | t }}
              </button>
            </div>

            @if (showSchoolRequest) {
              <div class="embedded-request-form">
                <app-school-request-form></app-school-request-form>
              </div>
            }

            @if (errorMsg) {
              <p class="inline-msg error" role="alert">{{ errorMsg }}</p>
            }

            <div class="dialog-actions">
              <ui-button
                variant="ghost"
                (onClick)="onSkip()"
                [disabled]="isSubmitting"
              >
                {{ 'welcome.skip' | t }}
              </ui-button>
              <ui-button
                variant="primary"
                (onClick)="confirmSchoolChoice()"
                [disabled]="!selectedSchool || isSubmitting"
              >
                {{ isSubmitting ? ('common.saving' | t) : ('welcome.confirmSchool' | t) }}
              </ui-button>
            </div>
          } @else if (step === 'verify') {
            <div class="verify-step">
              <p class="welcome-desc">
                {{ 'welcome.mandatoryNoticeDesc' | t: { school: selectedSchoolName } }}
              </p>

              <div class="dialog-actions mt-4" style="display: flex; gap: 8px; justify-content: flex-end;">
                <ui-button
                  variant="ghost"
                  (onClick)="finishAndClose()"
                >
                  {{ 'welcome.continueWithoutVerification' | t }}
                </ui-button>
                <ui-button
                  variant="primary"
                  (onClick)="goToVerification()"
                >
                  {{ 'welcome.goToVerify' | t }}
                </ui-button>
              </div>
            </div>
          }
        </div>
      </ng-template>
    }
  `,
  styles: [`
    .welcome-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-4);
      background: rgba(0, 0, 0, 0.5);
      animation: welcome-fade 140ms ease-out;
    }
    .welcome-dialog {
      box-sizing: border-box;
      width: 100%;
      max-width: 480px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      padding: var(--space-5);
      background: var(--surface-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-modal);
      overflow-y: auto;
    }
    .welcome-heading {
      margin: 0 0 var(--space-3) 0;
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--ink);
    }
    .welcome-desc {
      margin: 0 0 var(--space-4) 0;
      font-size: var(--text-sm);
      color: var(--muted);
      line-height: 1.5;
    }
    .search-box {
      margin-bottom: var(--space-3);
    }
    .school-list {
      max-height: 240px;
      overflow-y: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius-base);
      margin-bottom: var(--space-3);
    }
    .school-option {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      border: none;
      border-bottom: 1px solid var(--line);
      background: none;
      color: var(--ink);
      font-size: var(--text-sm);
      text-align: left;
      cursor: pointer;
      min-height: var(--tap-min);
    }
    .school-option:last-child {
      border-bottom: none;
    }
    .school-option:hover {
      background: var(--surface-hover);
    }
    .school-option.selected {
      background: color-mix(in srgb, var(--primary) 10%, transparent);
      color: var(--primary);
      font-weight: 500;
    }
    .school-code {
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--surface-inset);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
    .no-results {
      padding: var(--space-4);
      text-align: center;
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .request-link-row {
      margin-bottom: var(--space-3);
      text-align: right;
    }
    .link-btn {
      background: none;
      border: none;
      padding: 0;
      color: var(--primary);
      font-size: var(--text-xs);
      cursor: pointer;
      text-decoration: underline;
    }
    .embedded-request-form {
      margin-bottom: var(--space-4);
      padding: var(--space-3);
      background: var(--surface-inset);
      border-radius: var(--radius-base);
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .inline-msg.error {
      color: var(--danger);
      font-size: var(--text-xs);
      margin-top: var(--space-2);
    }
    @keyframes welcome-fade {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .welcome-overlay { animation: none; }
    }
  `],
})
export class UiWelcomeDialog implements OnInit {
  protected readonly isPhone = injectIsPhone();
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);
  private schoolStateService = inject(SchoolStateService);
  private metadataService = inject(MetadataService);
  private router = inject(Router);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  isOpen = false;
  step: 'school' | 'verify' = 'school';
  schools: SchoolOption[] = [];
  filteredSchools: SchoolOption[] = [];
  selectedSchool: SchoolOption | null = null;
  searchQuery = '';
  showSchoolRequest = false;
  isSubmitting = false;
  errorMsg = '';

  get sheetTitle(): string {
    return this.step === 'school'
      ? this.i18n.t('welcome.title')
      : this.i18n.t('welcome.mandatoryNoticeTitle');
  }

  get selectedSchoolName(): string {
    return this.selectedSchool ? (this.selectedSchool.display_name || this.selectedSchool.name) : '';
  }

  constructor() {
    effect(() => {
      this.authStore.isAuthenticated();
      this.authStore.user();
      untracked(() => this.checkEligibility());
    });
  }

  ngOnInit(): void {
    this.checkEligibility();
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        this.checkEligibility();
      });
  }

  private isExcludedRoute(url: string): boolean {
    const clean = url.split('?')[0].split('#')[0].toLowerCase();
    const parts = clean.split('/').filter(Boolean);
    const segment = parts.length > 1 && parts[0].length === 2 ? parts[1] : parts[0];
    return ['login', 'register', 'verify', 'forgot-password', 'admin'].includes(segment);
  }

  private checkEligibility(): void {
    if (!this.authStore.isAuthenticated()) {
      this.isOpen = false;
      this.cdr.markForCheck();
      return;
    }

    if (this.isExcludedRoute(this.router.url)) {
      this.isOpen = false;
      this.cdr.markForCheck();
      return;
    }

    const user = this.authStore.user();
    if (!user) {
      this.isOpen = false;
      this.cdr.markForCheck();
      return;
    }

    if (user.school_prompted || user.school_prompted_at) {
      this.isOpen = false;
      this.cdr.markForCheck();
      return;
    }

    if (this.schools.length === 0) {
      this.loadSchools();
    }

    this.isOpen = true;
    this.cdr.markForCheck();
  }

  private loadSchools(): void {
    this.metadataService.getMetadataWithRetry().subscribe({
      next: (meta) => {
        if (meta?.schools) {
          this.schools = meta.schools;
          this.filteredSchools = meta.schools;
          this.cdr.markForCheck();
        }
      },
    });
  }

  onSearchChange(): void {
    const q = this.searchQuery.trim();
    if (!q) {
      this.filteredSchools = this.schools;
    } else {
      this.filteredSchools = this.schools.filter((s) => keywordsMatch(schoolKeywords(s), q));
    }
    this.cdr.markForCheck();
  }

  selectSchool(school: SchoolOption): void {
    this.selectedSchool = school;
    this.cdr.markForCheck();
  }

  toggleSchoolRequest(): void {
    this.showSchoolRequest = !this.showSchoolRequest;
    this.cdr.markForCheck();
  }

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('welcome-overlay')) {
      this.onSkip();
    }
  }

  onSkip(): void {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    const region = this.regionService.region();
    this.authStore.setDeclaredSchool(region, null, true).subscribe({
      next: () => {
        this.isSubmitting = false;
        this.isOpen = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isSubmitting = false;
        this.isOpen = false;
        this.cdr.markForCheck();
      },
    });
  }

  confirmSchoolChoice(): void {
    if (!this.selectedSchool || this.isSubmitting) return;
    this.isSubmitting = true;
    this.errorMsg = '';
    const region = this.regionService.region();
    const schoolCode = this.selectedSchool.code;

    this.authStore.setDeclaredSchool(region, schoolCode).subscribe({
      next: () => {
        this.isSubmitting = false;
        this.schoolStateService.setManualSchool(schoolCode);

        const isMandatory =
          this.selectedSchool?.requires_verification === 1 ||
          this.selectedSchool?.requires_verification === true;

        if (isMandatory) {
          this.step = 'verify';
        } else {
          this.isOpen = false;
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.isSubmitting = false;
        this.errorMsg = this.i18n.t('acct.verifyFailed');
        this.cdr.markForCheck();
      },
    });
  }

  goToVerification(): void {
    this.isOpen = false;
    void this.router.navigate(['/', this.regionService.region(), 'account', 'verification']);
  }

  finishAndClose(): void {
    this.isOpen = false;
    this.cdr.markForCheck();
  }
}
