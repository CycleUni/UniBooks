import { Component, ChangeDetectorRef, OnInit, inject, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, NavigationEnd } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { TPipe, I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';
import { SchoolOption, SchoolStateService } from '../../core/services/school-state.service';
import { MetadataService } from '../../core/services/metadata.service';
import { AccountService } from '../../core/services/account.service';
import { GoogleAuthService } from '../../core/services/google-auth.service';
import { ToastService } from '../../core/services/toast.service';
import { injectIsPhone } from '../../core/viewport';
import { keywordsMatch, schoolKeywords } from '../../core/school-search';
import { getSchoolDomainChoices } from '../../core/verification';
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

              @if (googleAvailable) {
                <div class="google-verify-row">
                  <ui-button
                    variant="white"
                    (onClick)="onVerifyWithGoogle()"
                    [disabled]="isVerifying"
                    style="width: 100%;"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align: middle; margin-right: 8px;">
                      <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/>
                      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"/>
                      <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.14-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.99 0 12s.45 3.83 1.25 5.42l4.03-3.15z"/>
                      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/>
                    </svg>
                    {{ 'acct.verifyWithSchoolGoogle' | t }}
                  </ui-button>
                </div>
                <div class="divider">
                  <span>{{ 'acct.orVerifyByEmail' | t }}</span>
                </div>
              }

              <div class="email-input-row">
                <input
                  type="text"
                  class="local-input"
                  [placeholder]="'acct.eduEmailLocalPlaceholder' | t"
                  [(ngModel)]="eduLocalPart"
                  (keydown.enter)="onSendMail()"
                  [attr.aria-label]="'acct.eduEmailLocalPlaceholder' | t"
                />
                @if (domainChoices.length > 1) {
                  <select class="domain-select" [(ngModel)]="selectedDomain" aria-label="Domain">
                    @for (d of domainChoices; track d) {
                      <option [value]="d">&#64;{{ d }}</option>
                    }
                  </select>
                } @else {
                  <span class="domain-static">&#64;{{ selectedDomain }}</span>
                }
              </div>

              @if (verifyStatusMsg) {
                <p class="inline-msg" [class.ok]="verifyStatusOk" [class.error]="!verifyStatusOk" role="status">
                  {{ verifyStatusMsg }}
                </p>
              }

              <div class="verify-action-buttons">
                <ui-button
                  variant="primary"
                  (onClick)="onSendMail()"
                  [disabled]="isVerifying || !eduLocalPart.trim()"
                >
                  {{ isVerifying ? ('acct.sending' | t) : ('acct.sendVerification' | t) }}
                </ui-button>
              </div>

              <div class="dialog-actions mt-3">
                <ui-button
                  variant="ghost"
                  (onClick)="finishAndClose()"
                >
                  {{ 'welcome.continueWithoutVerification' | t }}
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
      border: 1px solid var(--surface-raised-border);
      border-radius: var(--radius-card);
      box-shadow: var(--shadow-card-lg);
      color: var(--ink);
      overflow-y: auto;
    }
    .welcome-heading {
      margin: 0 0 var(--space-2);
      font-size: var(--text-xl);
      line-height: 1.3;
    }
    .welcome-desc {
      margin: 0 0 var(--space-4);
      color: var(--ink-soft);
      font-size: var(--text-sm);
      line-height: 1.5;
    }
    .search-box {
      margin-bottom: var(--space-3);
    }
    .school-list {
      max-height: 220px;
      overflow-y: auto;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      background: var(--surface);
      margin-bottom: var(--space-3);
    }
    .school-option {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      border: none;
      border-bottom: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      text-align: left;
      cursor: pointer;
      font-size: var(--text-sm);
      min-height: var(--tap-min, 44px);
    }
    .school-option:last-child {
      border-bottom: none;
    }
    .school-option:hover,
    .school-option:focus-visible {
      background: var(--surface-hover);
      outline: none;
    }
    .school-option.selected {
      background: color-mix(in srgb, var(--primary) 12%, transparent);
      font-weight: 600;
    }
    .school-code {
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--surface-raised);
      padding: 2px 6px;
      border-radius: var(--radius-sm, 4px);
    }
    .no-results {
      padding: var(--space-4);
      text-align: center;
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .request-link-row {
      margin-bottom: var(--space-3);
    }
    .link-btn {
      background: none;
      border: none;
      padding: 0;
      color: var(--primary);
      font-size: var(--text-sm);
      cursor: pointer;
      text-decoration: underline;
    }
    .embedded-request-form {
      margin-bottom: var(--space-3);
      padding: var(--space-3);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-control);
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
      margin-top: var(--space-4);
    }
    .google-verify-row {
      margin-bottom: var(--space-3);
    }
    .divider {
      display: flex;
      align-items: center;
      text-align: center;
      color: var(--muted);
      font-size: var(--text-xs);
      margin: var(--space-3) 0;
    }
    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid var(--line);
    }
    .divider span {
      padding: 0 var(--space-2);
    }
    .email-input-row {
      display: flex;
      align-items: center;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      background: var(--surface);
      overflow: hidden;
      margin-bottom: var(--space-3);
      min-height: var(--tap-min, 44px);
    }
    .local-input {
      flex: 1;
      border: none;
      padding: var(--space-2) var(--space-3);
      background: transparent;
      color: var(--ink);
      font-size: var(--text-base);
      outline: none;
    }
    .domain-select {
      border: none;
      border-left: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-sm);
      outline: none;
    }
    .domain-static {
      padding: var(--space-2) var(--space-3);
      color: var(--muted);
      font-size: var(--text-sm);
      border-left: 1px solid var(--line);
    }
    .verify-action-buttons {
      display: flex;
      justify-content: flex-end;
    }
    .mt-3 {
      margin-top: var(--space-3);
    }
    .inline-msg {
      font-size: var(--text-sm);
      padding: var(--space-2);
      border-radius: var(--radius-sm, 4px);
      margin-top: var(--space-2);
    }
    .inline-msg.error {
      background: var(--danger-light);
      color: var(--danger);
    }
    .inline-msg.ok {
      background: var(--success-light);
      color: var(--success);
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
  private accountService = inject(AccountService);
  private googleAuth = inject(GoogleAuthService);
  private toast = inject(ToastService);
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

  // Step 2 verify fields
  eduLocalPart = '';
  selectedDomain = '';
  domainChoices: string[] = [];
  isVerifying = false;
  verifyStatusMsg = '';
  verifyStatusOk = false;

  get sheetTitle(): string {
    return this.step === 'school'
      ? this.i18n.t('welcome.title')
      : this.i18n.t('welcome.mandatoryNoticeTitle');
  }

  get selectedSchoolName(): string {
    return this.selectedSchool ? (this.selectedSchool.display_name || this.selectedSchool.name) : '';
  }

  get googleAvailable(): boolean {
    return (this.selectedSchool?.google_domains?.length ?? 0) > 0;
  }

  constructor() {
    // The profile usually arrives after the navigation that follows sign-in
    // has ended, so route changes alone would never see the signed-in user.
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
    // Ignore region prefix if present
    const segment = parts.length > 1 && parts[0].length === 2 ? parts[1] : parts[0];
    return ['login', 'register', 'verify', 'forgot-password', 'admin'].includes(segment);
  }

  checkEligibility(): void {
    if (this.isExcludedRoute(this.router.url)) {
      this.isOpen = false;
      this.cdr.markForCheck();
      return;
    }

    if (!this.authStore.isAuthenticated()) {
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

    // Must not have answered or skipped before
    const prompted = !!user.school_prompted || !!user.school_prompted_at;
    if (prompted) {
      this.isOpen = false;
      this.cdr.markForCheck();
      return;
    }

    // Eligible! Open the modal if not already open
    if (!this.isOpen) {
      this.openDialog();
    }
  }

  private openDialog(): void {
    this.isOpen = true;
    this.step = 'school';
    this.searchQuery = '';
    this.errorMsg = '';
    this.loadSchools();
    this.cdr.markForCheck();
  }

  private loadSchools(): void {
    this.metadataService.getMetadataWithRetry().subscribe({
      next: (data) => {
        if (data.schools) {
          this.schools = data.schools;
          this.filterSchools();
          this.cdr.markForCheck();
        }
      },
    });
  }

  onSearchChange(): void {
    this.filterSchools();
  }

  private filterSchools(): void {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) {
      this.filteredSchools = this.schools;
      return;
    }
    this.filteredSchools = this.schools.filter((s) => keywordsMatch(schoolKeywords(s), q));
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

        // Check if verification is mandatory
        const isMandatory =
          this.selectedSchool?.requires_verification === 1 ||
          this.selectedSchool?.requires_verification === true;

        if (isMandatory) {
          this.setupVerificationStep();
        } else {
          this.isOpen = false;
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorMsg = this.i18n.t('acct.verifyFailed');
        this.cdr.markForCheck();
      },
    });
  }

  private setupVerificationStep(): void {
    this.step = 'verify';
    this.domainChoices = getSchoolDomainChoices(this.selectedSchool);
    this.selectedDomain = this.domainChoices[0] || this.selectedSchool?.email_domain || '';
    this.eduLocalPart = '';
    this.verifyStatusMsg = '';
  }

  async onVerifyWithGoogle(): Promise<void> {
    if (this.isVerifying || !this.selectedSchool) return;
    this.isVerifying = true;
    this.verifyStatusMsg = '';
    this.cdr.markForCheck();

    try {
      const { nonce } = await firstValueFrom(this.accountService.getGoogleVerifyOptions());
      let hd: string | undefined;
      const googleDomains = this.selectedSchool.google_domains || [];
      if (googleDomains.length === 1) {
        hd = googleDomains[0];
      }
      const credential = await this.googleAuth.verifyCampusGoogle({ nonce, hd });
      await firstValueFrom(this.accountService.verifyWithGoogle(credential));

      this.isVerifying = false;
      this.toast.success(this.i18n.t('acct.verifySuccess'));
      this.authStore.fetchUserProfile(undefined, true);
      this.isOpen = false;
      this.cdr.markForCheck();
    } catch (err: any) {
      this.isVerifying = false;
      if (err?.message !== 'popup_closed') {
        this.verifyStatusOk = false;
        this.verifyStatusMsg = this.i18n.t('acct.verifyFailed');
      }
      this.cdr.markForCheck();
    }
  }

  onSendMail(): void {
    const local = this.eduLocalPart.trim();
    if (!local || !this.selectedDomain || this.isVerifying) return;
    const fullEmail = `${local}@${this.selectedDomain}`;

    this.isVerifying = true;
    this.verifyStatusMsg = '';
    this.cdr.markForCheck();

    this.authStore.requestEduVerification(fullEmail).subscribe({
      next: () => {
        this.isVerifying = false;
        this.verifyStatusOk = true;
        this.verifyStatusMsg = this.i18n.t('acct.sentVerification');
        this.toast.success(this.i18n.t('acct.sentVerification'));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isVerifying = false;
        this.verifyStatusOk = false;
        this.verifyStatusMsg = this.i18n.t('acct.verifyFailed');
        this.cdr.markForCheck();
      },
    });
  }

  finishAndClose(): void {
    this.isOpen = false;
    this.cdr.markForCheck();
  }
}
