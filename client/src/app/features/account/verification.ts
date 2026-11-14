import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  inject,
  ChangeDetectorRef,
  ElementRef,
  ViewChild,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiDropdown, DropdownOption } from '../../shared/ui/dropdown.component';
import { UiSuccessCheck } from '../../shared/ui/success-check.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { SchoolRequestFormComponent } from './school-request-form.component';
import { UiVerifiedBadge } from '../../shared/ui/verified-badge.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService, Region } from '../../core/region.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { MetadataService } from '../../core/services/metadata.service';
import {
  SchoolOption,
  CityOption,
  SchoolStateService,
} from '../../core/services/school-state.service';
import { GoogleAuthService } from '../../core/services/google-auth.service';
import {
  domainMatchesSuffix,
  splitEmailAddress,
  findSchoolForDomain,
  getSchoolDomainChoices,
} from '../../core/verification';
import { schoolKeywords } from '../../core/school-search';
import { isSameRegion } from '../../core/region-path';
import { parseApiError } from '../../core/api-error.util';

const RENEW_WINDOW_DAYS = 60;
const SCHOOL_NOT_SUPPORTED = 'acct.errSchoolNotSupported';

@Component({
  selector: 'app-account-verification',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TPipe,
    UiButton,
    UiInput,
    UiDropdown,
    UiSuccessCheck,
    UiSkeleton,
    SchoolRequestFormComponent,
    UiVerifiedBadge,
    UiErrorState,
  ],
  templateUrl: './verification.html',
  styleUrls: ['./verification.css'],
})
export class VerificationComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('googleBtnRef', { static: false }) googleBtnRef?: ElementRef<HTMLElement>;

  private authStore = inject(AuthStore);
  private accountService = inject(AccountService);
  public regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private metadataService = inject(MetadataService);
  private schoolStateService = inject(SchoolStateService);
  private googleAuth = inject(GoogleAuthService);

  private readonly verifyPendingEmailStorageKeyLegacy =
    'unibooks.account.eduVerification.pendingEmail';
  private readonly verifyCooldownUntilStorageKeyLegacy =
    'unibooks.account.eduVerification.cooldownUntil';

  email = '';
  eduEmail = '';
  verifications: any[] = [];
  lapsedVerifications: any[] = [];
  pendingEduEmail: string | null = null;
  resendCooldownSeconds = 0;
  isEditingPendingEmail = false;
  isLoading = false;
  profileLoaded = false;
  profileLoadFailed = false;
  verifyIsError = false;
  isGoogleLinked = false;

  private profileUserId: string | null = null;
  private resendCountdownTimer: ReturnType<typeof setInterval> | null = null;

  availableSchools: SchoolOption[] = [];
  availableCities: CityOption[] = [];
  schoolDropdownOptions: DropdownOption[] = [];
  selectedSchoolCode = '';
  selectedSchoolOption: SchoolOption | null = null;
  selectedVerifyDomain = '';
  schoolDomainChoices: string[] = [];
  eduLocalPart = '';
  useManualEmail = false;

  declaredSchool: { id: number; code: string; name: string; requires_verification: boolean } | null = null;
  softInviteDismissed =
    typeof sessionStorage !== 'undefined' &&
    sessionStorage.getItem('unibooks_soft_invite_dismissed') === 'true';

  changingEduEmail = false;
  clientVerifyMsg = '';
  lastVerifyError: any = null;

  // Google verify button state
  private googleRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private googleTeardown: (() => void) | null = null;
  googleReady = false;
  googleBlocked = false;
  googleError = '';
  isVerifyingGoogle = false;

  get googleFailed() {
    return this.googleAuth.buttonFailed;
  }

  // Student ID state
  studentIdRequest: {
    id: string;
    status: string;
    school: string;
    school_name: string;
    student_number: string;
    reject_reason: string;
    created_at: string;
    updated_at: string;
    reviewed_at: string | null;
  } | null = null;
  studentNumberInput = '';
  selectedStudentIdFile: File | null = null;
  studentIdPreviewUrl: string | null = null;
  isSubmittingStudentId = false;
  isCancellingStudentId = false;
  isResubmittingStudentId = false;
  studentIdError = '';

  // Auto-verify state
  autoVerifyMessage = '';
  autoVerifyIsError = false;
  autoVerifySchoolNotSupported = false;

  get currentRegion(): Region | null {
    return this.regionService.currentRegionObj();
  }

  get currentVerification(): any | null {
    if (!this.currentRegion) return null;
    return (
      (this.verifications || []).find(
        (v) => isSameRegion(v.region, this.currentRegion!.code) && !!v.verified_at,
      ) || null
    );
  }

  get isVerified(): boolean {
    return !!this.currentVerification;
  }

  get currentLapsed(): any | null {
    if (!this.currentRegion || this.currentVerification) return null;
    return (
      (this.lapsedVerifications || []).find((v) =>
        isSameRegion(v.region, this.currentRegion!.code),
      ) || null
    );
  }

  get renewalDue(): boolean {
    const expires = this.currentVerification?.expires_at;
    return !!expires && new Date(expires).getTime() - Date.now() < RENEW_WINDOW_DAYS * 86_400_000;
  }

  get renewOldEmail(): string | null {
    return this.currentVerification?.edu_email || this.currentLapsed?.edu_email || null;
  }

  get googleRenews(): boolean {
    const old = this.renewOldEmail;
    return this.isGoogleLinked && !!old && old.toLowerCase() === this.email.toLowerCase();
  }

  get renewEmailIsGoogle(): boolean {
    if (!this.renewOldEmail) return false;
    const domain = this.renewOldEmail.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    for (const s of this.availableSchools) {
      const gd = (s.google_domains || []).map((d) => d.toLowerCase());
      if (gd.includes(domain)) return true;
    }
    return false;
  }

  get mustVerify(): boolean {
    return this.authStore.mustVerifyIn(this.regionService.region());
  }

  get currentVerifiedSchoolName(): string {
    const v = this.currentVerification;
    if (!v) return '';
    const school = this.availableSchools.find((s) => s.id === v.school);
    return school ? school.display_name || school.name : v.school_name || '';
  }

  get currentDeclaredSchoolName(): string {
    return this.declaredSchool?.name || this.authStore.schoolForRegion(this.regionService.region());
  }

  get targetStudentIdSchool(): SchoolOption | null {
    if (this.selectedSchoolOption) return this.selectedSchoolOption;
    if (this.selectedSchoolCode) {
      return this.availableSchools.find((s) => s.code === this.selectedSchoolCode) || null;
    }
    return null;
  }

  get allowsStudentIdVerification(): boolean {
    return !!this.targetStudentIdSchool?.allows_student_id_verification;
  }

  get selectedSchoolHasGoogleDomain(): boolean {
    return (this.selectedSchoolOption?.google_domains?.length ?? 0) > 0;
  }

  get isCurrentDomainGoogle(): boolean {
    if (!this.selectedSchoolOption || !this.selectedVerifyDomain) return false;
    const googleList = this.selectedSchoolOption.google_domains || [];
    return googleList.map((d) => d.toLowerCase()).includes(this.selectedVerifyDomain.toLowerCase());
  }

  get schoolNeedsFullAddress(): boolean {
    return !!this.selectedSchoolOption && this.schoolDomainChoices.length === 0;
  }

  get showPendingVerification(): boolean {
    return !this.isEditingPendingEmail && !!this.pendingEduEmail;
  }

  get pendingEduEmailDisplay(): string {
    return this.pendingEduEmail || '';
  }

  get resendCooldownMinutes(): number {
    return Math.floor(this.resendCooldownSeconds / 60);
  }

  get resendCooldownSecondsPart(): string {
    return (this.resendCooldownSeconds % 60).toString().padStart(2, '0');
  }

  get autoVerifyRegion(): Region | null {
    if (!this.email || this.currentVerification || !this.currentRegion) return null;
    const parts = this.email.split('@');
    if (parts.length !== 2) return null;
    const loginDomain = parts[1].toLowerCase();

    if (this.currentRegion.edu_email_suffix.some((s) => domainMatchesSuffix(loginDomain, s))) {
      return this.currentRegion;
    }
    return null;
  }

  get schoolNotSupported(): boolean {
    return (
      !this.clientVerifyMsg && this.lastVerifyError?.error?.error?.code === SCHOOL_NOT_SUPPORTED
    );
  }

  get verifyMessage(): string {
    if (this.clientVerifyMsg) return this.i18n.t(this.clientVerifyMsg);
    if (!this.lastVerifyError) return '';
    const err = this.lastVerifyError;
    const code = err.error?.error?.code;
    if (code) return this.i18n.t(code);
    const throttledSeconds = this.extractThrottleSeconds(err);
    if (throttledSeconds !== null) {
      return this.i18n.t('acct.verifyThrottled', {
        minutes: this.resendCooldownMinutes,
        seconds: this.resendCooldownSecondsPart,
      });
    }
    return parseApiError(err, this.i18n, 'acct.verifyFailed');
  }

  constructor() {
    effect(() => {
      this.i18n.lang();
      if (this.availableSchools.length > 0) {
        this.rebuildSchoolOptions();
        if (this.selectedSchoolCode) {
          this.selectedSchoolOption =
            this.availableSchools.find((s) => s.code === this.selectedSchoolCode) || null;
        }
        this.cdr.markForCheck();
      }
    });
  }

  ngOnInit() {
    this.clearLegacyPendingVerificationState();
    this.loadProfile();
    this.loadSchoolsMetadata();
    this.loadStudentIdVerification();
  }

  ngAfterViewInit() {
    if (this.selectedSchoolHasGoogleDomain) {
      this.setupGoogleButton();
    }
  }

  ngOnDestroy() {
    this.stopResendCountdown();
    this.stopGoogleRefreshTimer();
    if (this.googleTeardown) {
      this.googleTeardown();
      this.googleTeardown = null;
    }
    if (this.studentIdPreviewUrl) {
      URL.revokeObjectURL(this.studentIdPreviewUrl);
    }
  }

  dismissSoftInvite() {
    this.softInviteDismissed = true;
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem('unibooks_soft_invite_dismissed', 'true');
      } catch {}
    }
  }

  loadProfile() {
    this.profileLoadFailed = false;
    this.loadStudentIdVerification();
    this.accountService.getMyProfile().subscribe({
      next: (data) => {
        this.profileLoaded = true;
        this.profileUserId = data.id ? String(data.id) : null;
        this.email = data.email || '';
        this.eduEmail = data.edu_email || '';
        this.verifications = data.verifications || [];
        this.lapsedVerifications = data.lapsed_verifications || [];
        this.changingEduEmail = false;
        this.isGoogleLinked = data.is_google_linked ?? false;

        const regCode = (this.currentRegion?.code || '').toUpperCase();
        const regData = data.per_region?.[regCode];
        this.declaredSchool = regData?.declared_school || data.declared_school || null;

        if (this.currentVerification) {
          const vSchool = this.availableSchools.find(
            (s) => s.id === this.currentVerification.school,
          );
          this.selectedSchoolCode = vSchool?.code || this.currentVerification.school_code || '';
        } else if (!this.selectedSchoolCode) {
          this.selectedSchoolCode =
            this.declaredSchool?.code ||
            this.schoolStateService.currentSchool ||
            this.schoolStateService.getManualSchool() ||
            '';
        }

        if (this.selectedSchoolCode && this.availableSchools.length > 0) {
          this.selectedSchoolOption =
            this.availableSchools.find((s) => s.code === this.selectedSchoolCode) || null;
          this.updateDomainChoices();
        }

        this.restorePendingVerificationState();
        if (this.verifications.length > 0) {
          this.clearPendingVerificationState();
        } else if (this.pendingEduEmail && !this.isEditingPendingEmail) {
          this.eduEmail = this.pendingEduEmail;
          if (this.eduEmail.includes('@')) {
            this.handlePastedEmail(this.eduEmail);
          }
        } else if (this.eduEmail && !this.eduLocalPart) {
          if (this.eduEmail.includes('@')) {
            this.handlePastedEmail(this.eduEmail);
          }
        }

        if (this.selectedSchoolHasGoogleDomain) {
          setTimeout(() => this.setupGoogleButton(), 0);
        }

        this.cdr.markForCheck();
      },
      error: (err) => {
        if (!this.profileLoaded) this.profileLoadFailed = true;
        console.error('Failed to load profile in verification page', err);
        this.cdr.markForCheck();
      },
    });
  }

  loadSchoolsMetadata() {
    this.metadataService.getMetadata().subscribe({
      next: (data) => {
        this.availableSchools = data?.schools || [];
        this.availableCities = data?.cities || [];
        this.rebuildSchoolOptions();
        if (this.selectedSchoolCode) {
          this.selectedSchoolOption =
            this.availableSchools.find((s) => s.code === this.selectedSchoolCode) || null;
          this.updateDomainChoices();
          if (this.selectedSchoolHasGoogleDomain) {
            setTimeout(() => this.setupGoogleButton(), 0);
          }
        } else {
          this.initSelectedSchool();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load schools metadata in verification', err);
      },
    });
  }

  private rebuildSchoolOptions() {
    this.schoolDropdownOptions = this.schoolOptionsByCity(
      this.availableSchools,
      this.availableCities,
    );
  }

  private schoolOptionsByCity(schools: SchoolOption[], cities: CityOption[]): DropdownOption[] {
    const option = (s: SchoolOption, group?: string): DropdownOption => ({
      value: s.code,
      label: s.display_name || s.name,
      group,
      keywords: schoolKeywords(s),
    });
    if (cities.length === 0) return schools.map((s) => option(s));
    const known = new Set(cities.map((c) => c.code));
    const grouped = cities.flatMap((c) =>
      schools.filter((s) => s.city === c.code).map((s) => option(s, c.display_name || c.name)),
    );
    const other = this.i18n.t('layout.otherCity');
    const rest = schools.filter((s) => !s.city || !known.has(s.city)).map((s) => option(s, other));
    return [...grouped, ...rest];
  }

  private initSelectedSchool() {
    if (this.selectedSchoolCode) return;
    const current =
      this.declaredSchool?.code ||
      this.schoolStateService.currentSchool ||
      this.schoolStateService.getManualSchool();
    if (current && this.availableSchools.some((s) => s.code === current)) {
      this.onSchoolChange(current);
    }
  }

  onSchoolChange(code: string) {
    this.selectedSchoolCode = code || '';
    this.selectedSchoolOption = this.availableSchools.find((s) => s.code === code) || null;
    this.updateDomainChoices();
    this.schoolStateService.setManualSchool(code || '');
    const region = this.regionService.region();
    this.accountService.setDeclaredSchool(region, code || null).subscribe({
      next: () => {
        this.toast.success(this.i18n.t('acct.schoolUpdated'));
        this.authStore.fetchUserProfile(undefined, true);
      },
      error: () => {},
    });

    if (this.selectedSchoolHasGoogleDomain) {
      setTimeout(() => this.setupGoogleButton(), 0);
    } else {
      this.stopGoogleRefreshTimer();
      if (this.googleTeardown) {
        this.googleTeardown();
        this.googleTeardown = null;
      }
    }
    this.cdr.markForCheck();
  }

  private updateDomainChoices(preserveDomain?: string) {
    if (!this.selectedSchoolOption) {
      this.schoolDomainChoices = [];
      this.selectedVerifyDomain = '';
      return;
    }
    this.schoolDomainChoices = getSchoolDomainChoices(this.selectedSchoolOption);
    if (preserveDomain && this.schoolDomainChoices.includes(preserveDomain.toLowerCase())) {
      this.selectedVerifyDomain = preserveDomain.toLowerCase();
    } else {
      this.selectedVerifyDomain = this.schoolDomainChoices[0] || '';
    }
  }

  onDomainSelectChange(domain: string) {
    this.selectedVerifyDomain = domain;
    this.cdr.markForCheck();
  }

  onLocalPartChange(val: string) {
    if (val.includes('@')) {
      this.handlePastedEmail(val);
      return;
    }
    this.eduLocalPart = val;
  }

  onLocalPartPaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text') || '';
    if (text.includes('@')) {
      event.preventDefault();
      this.handlePastedEmail(text);
    }
  }

  handlePastedEmail(raw: string) {
    const split = splitEmailAddress(raw);
    if (!split) {
      this.eduLocalPart = raw.trim();
      return;
    }
    const { localPart, domain } = split;

    // 1. Check if the currently selected school accepts this exact domain
    if (this.selectedSchoolOption && this.schoolDomainChoices.includes(domain)) {
      this.eduLocalPart = localPart;
      this.selectedVerifyDomain = domain;
      this.useManualEmail = false;
      this.cdr.markForCheck();
      return;
    }

    // 2. Search available schools for this domain
    const match = findSchoolForDomain(this.availableSchools, domain);
    if (match) {
      this.selectedSchoolCode = match.school.code;
      this.selectedSchoolOption = match.school;
      this.updateDomainChoices(domain);
      this.eduLocalPart = localPart;
      if (this.schoolDomainChoices.includes(domain)) {
        this.selectedVerifyDomain = domain;
        this.useManualEmail = false;
      } else {
        this.useManualEmail = true;
        this.eduEmail = `${localPart}@${domain}`;
      }
    } else {
      this.useManualEmail = true;
      this.eduEmail = `${localPart}@${domain}`;
    }
    this.cdr.markForCheck();
  }

  toggleManualEmail() {
    this.useManualEmail = !this.useManualEmail;
    if (this.useManualEmail) {
      if (this.eduLocalPart && this.selectedVerifyDomain) {
        this.eduEmail = `${this.eduLocalPart.trim()}@${this.selectedVerifyDomain.trim()}`;
      }
    } else {
      if (this.eduEmail && this.eduEmail.includes('@')) {
        this.handlePastedEmail(this.eduEmail);
      }
    }
    this.cdr.markForCheck();
  }

  buildSubmitEmail(): string | null {
    this.clientVerifyMsg = '';
    this.lastVerifyError = null;
    this.verifyIsError = false;

    if (this.useManualEmail || this.schoolNeedsFullAddress) {
      const email = this.eduEmail.trim();
      if (!email) {
        this.verifyIsError = true;
        this.clientVerifyMsg = 'acct.emailRequired';
        return null;
      }
      if (!email.includes('@')) {
        this.verifyIsError = true;
        this.clientVerifyMsg = 'acct.errEduEmailFull';
        return null;
      }
      return email;
    }

    if (this.eduEmail && !this.eduLocalPart && !this.selectedSchoolCode) {
      return this.eduEmail.trim();
    }

    if (!this.selectedSchoolCode) {
      this.verifyIsError = true;
      this.clientVerifyMsg = 'acct.errSchoolRequired';
      return null;
    }

    const localPart = this.eduLocalPart.trim();
    if (!localPart) {
      this.verifyIsError = true;
      this.clientVerifyMsg = 'acct.emailRequired';
      return null;
    }

    const domain = this.selectedVerifyDomain.trim();
    if (!domain) {
      this.verifyIsError = true;
      this.clientVerifyMsg = 'acct.emailRequired';
      return null;
    }

    const fullEmail = `${localPart}@${domain}`;
    this.eduEmail = fullEmail;
    return fullEmail;
  }

  private submitEduVerification(emailInput: string) {
    this.clientVerifyMsg = '';
    this.lastVerifyError = null;
    const normalizedEmail = emailInput.trim();
    if (!normalizedEmail) {
      this.verifyIsError = true;
      this.clientVerifyMsg = 'acct.emailRequired';
      return;
    }
    this.isLoading = true;
    this.cdr.markForCheck();

    this.authStore.requestEduVerification(normalizedEmail).subscribe({
      next: () => {
        this.isLoading = false;
        this.verifyIsError = false;
        this.clientVerifyMsg = 'acct.sentVerification';
        this.eduEmail = normalizedEmail;
        this.pendingEduEmail = normalizedEmail;
        this.isEditingPendingEmail = false;
        this.startResendCooldown(180);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.verifyIsError = true;
        this.lastVerifyError = err;
        const throttledSeconds = this.extractThrottleSeconds(err);
        if (throttledSeconds !== null) {
          this.applyCooldownUntil(Date.now() + throttledSeconds * 1000);
        }
        this.cdr.markForCheck();
      },
    });
  }

  async onRequestVerification() {
    const emailToSubmit = this.buildSubmitEmail();
    if (!emailToSubmit) return;
    const verifiedRegion = this.getVerifiedRegionForEmail(emailToSubmit);
    if (verifiedRegion) {
      const proceed = await this.confirms.ask(
        this.i18n.t('acct.regionAlreadyVerifiedConfirm', {
          region: verifiedRegion.localized_name,
        }),
      );
      if (!proceed) return;
    }
    this.submitEduVerification(emailToSubmit);
  }

  onVerifyFormSubmit() {
    if (this.changingEduEmail) {
      this.onSubmitNewEduEmail();
    } else {
      this.onRequestVerification();
    }
  }

  private getVerifiedRegionForEmail(emailInput: string): Region | null {
    if (!emailInput) return null;
    const parts = emailInput.trim().split('@');
    if (parts.length !== 2) return null;
    const loginDomain = parts[1].toLowerCase();

    const regions = this.regionService.regions();
    const matchedRegion = regions.find((r) => {
      return r.edu_email_suffix.some((s) => domainMatchesSuffix(loginDomain, s));
    });

    if (matchedRegion) {
      const isVerified = (this.verifications || []).some(
        (v) => isSameRegion(v.region, matchedRegion.code) && !!v.verified_at,
      );
      if (isVerified) {
        return matchedRegion;
      }
    }
    return null;
  }

  onResendVerification() {
    if (!this.pendingEduEmail || this.resendCooldownSeconds > 0) {
      return;
    }
    this.submitEduVerification(this.pendingEduEmail);
  }

  onReenterEduEmail() {
    this.isEditingPendingEmail = true;
    this.clientVerifyMsg = '';
    this.verifyIsError = false;
    this.lastVerifyError = null;
    this.eduEmail = this.pendingEduEmail || this.eduEmail;
    if (this.eduEmail && this.eduEmail.includes('@')) {
      this.handlePastedEmail(this.eduEmail);
    }
    this.cdr.markForCheck();
  }

  onAutoVerify() {
    this.isLoading = true;
    this.autoVerifyMessage = '';
    this.autoVerifyIsError = false;
    this.autoVerifySchoolNotSupported = false;
    this.cdr.markForCheck();

    this.accountService.autoVerifyEduEmail().subscribe({
      next: () => {
        this.isLoading = false;
        this.autoVerifyIsError = false;
        this.autoVerifyMessage = '';
        this.toast.success(this.i18n.t('acct.verifySuccess'));
        this.loadProfile();
        this.eduEmail = this.email;
        this.clearPendingVerificationState();
        this.cdr.markForCheck();

        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
        if (returnUrl) {
          this.router.navigateByUrl(returnUrl);
        }
      },
      error: (err) => {
        this.isLoading = false;
        this.autoVerifyIsError = true;
        const code = err.error?.error?.code;
        this.autoVerifyMessage = code ? this.i18n.t(code) : this.i18n.t('acct.verifyFailed');
        this.autoVerifySchoolNotSupported = code === SCHOOL_NOT_SUPPORTED;
        this.cdr.markForCheck();
      },
    });
  }

  onVerifyWithOldEmail() {
    if (this.isLoading || this.resendCooldownSeconds > 0) return;
    this.isLoading = true;
    this.clientVerifyMsg = '';
    this.lastVerifyError = null;
    this.autoVerifyMessage = '';
    this.cdr.markForCheck();
    this.accountService.renewVerification().subscribe({
      next: (res) => {
        this.isLoading = false;
        this.verifyIsError = false;
        if (res.code === 'acct.sentVerification') {
          this.clientVerifyMsg = 'acct.sentVerification';
          this.startResendCooldown(180);
        } else {
          this.clientVerifyMsg = 'acct.verifySuccess';
          this.loadProfile();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.verifyIsError = true;
        this.lastVerifyError = err;
        const throttledSeconds = this.extractThrottleSeconds(err);
        if (throttledSeconds !== null) this.applyCooldownUntil(Date.now() + throttledSeconds * 1000);
        this.cdr.markForCheck();
      },
    });
  }

  onChangeEduEmail() {
    this.changingEduEmail = true;
    this.eduEmail = '';
    this.eduLocalPart = '';
    this.clientVerifyMsg = '';
    this.lastVerifyError = null;
    this.autoVerifyMessage = '';
    this.initSelectedSchool();
  }

  onSubmitNewEduEmail() {
    if (this.resendCooldownSeconds > 0) return;
    const emailToSubmit = this.buildSubmitEmail();
    if (!emailToSubmit) return;
    this.submitEduVerification(emailToSubmit);
  }

  async onUnbindEduEmail(regionCode: string) {
    if (
      !(await this.confirms.askDanger(this.i18n.t('acct.unbindConfirm'), {
        confirmLabel: this.i18n.t('acct.unbindEmail'),
      }))
    ) {
      return;
    }

    this.isLoading = true;
    this.accountService.unbindEduEmail(regionCode).subscribe({
      next: () => {
        this.isLoading = false;
        this.verifications = this.verifications.filter((v) => !isSameRegion(v.region, regionCode));
        if (this.verifications.length === 0) {
          this.eduEmail = '';
        }
        this.clearPendingVerificationState();
        this.autoVerifyMessage = '';
        this.clientVerifyMsg = '';
        this.lastVerifyError = null;
        this.toast.success(this.i18n.t('common.save'));
        this.loadProfile();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
        this.cdr.markForCheck();
      },
    });
  }

  // --- Google verification methods ---

  async setupGoogleButton(options: { preserveError?: boolean } = {}) {
    this.stopGoogleRefreshTimer();
    if (this.googleTeardown) {
      this.googleTeardown();
      this.googleTeardown = null;
    }
    this.googleReady = false;
    if (!options.preserveError) {
      this.googleError = '';
    }

    if (!this.selectedSchoolHasGoogleDomain) {
      return;
    }

    if (this.googleFailed()) {
      this.googleBlocked = true;
      this.cdr.markForCheck();
      return;
    }

    const container = this.googleBtnRef?.nativeElement;
    if (!container) {
      setTimeout(() => {
        if (this.googleBtnRef?.nativeElement) {
          this.setupGoogleButton();
        }
      }, 0);
      return;
    }

    try {
      const { nonce } = await firstValueFrom(this.accountService.getGoogleVerifyOptions());
      let hd: string | undefined;
      const gDomains = this.selectedSchoolOption?.google_domains || [];
      if (gDomains.length === 1) {
        hd = gDomains[0];
      }

      this.googleTeardown = this.googleAuth.renderCampusVerifyButton(container, {
        nonce,
        hd,
        onReady: () => {
          this.googleReady = true;
          this.googleBlocked = false;
          this.cdr.markForCheck();
        },
        onError: () => {
          this.googleBlocked = true;
          this.googleReady = false;
          this.cdr.markForCheck();
        },
        onCredential: (credential) => {
          this.handleGoogleCredential(credential);
        },
      });

      this.startGoogleRefreshTimer();
    } catch (err: any) {
      this.googleError = parseApiError(err, this.i18n, 'acct.verifyFailed');
      this.cdr.markForCheck();
    }
  }

  private startGoogleRefreshTimer() {
    this.stopGoogleRefreshTimer();
    this.googleRefreshTimer = setInterval(() => {
      if (this.selectedSchoolHasGoogleDomain && !this.isVerifyingGoogle) {
        this.setupGoogleButton();
      }
    }, 240_000); // 4 minutes
  }

  private stopGoogleRefreshTimer() {
    if (this.googleRefreshTimer) {
      clearInterval(this.googleRefreshTimer);
      this.googleRefreshTimer = null;
    }
  }

  async handleGoogleCredential(credential: string) {
    this.isVerifyingGoogle = true;
    this.googleError = '';
    this.cdr.markForCheck();

    try {
      await firstValueFrom(this.accountService.verifyWithGoogle(credential));
      this.isVerifyingGoogle = false;
      this.toast.success(this.i18n.t('acct.verifySuccess'));
      this.accountService.clearProfileCache();
      this.loadProfile();
      this.clearPendingVerificationState();
      this.cdr.markForCheck();

      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      if (returnUrl) {
        this.router.navigateByUrl(returnUrl);
      }
    } catch (err: any) {
      this.isVerifyingGoogle = false;
      const code = err?.error?.error?.code;
      if (code === 'acct.errNotCampusGoogle') {
        this.googleError = this.i18n.t('acct.errNotCampusGoogle');
      } else if (
        code === 'auth.errInvalidToken' ||
        code === 'auth.errGoogleTokenExpired' ||
        code === 'acct.errGoogleTokenExpired'
      ) {
        this.googleError = this.i18n.t('acct.errGoogleTokenExpired');
      } else {
        this.googleError = parseApiError(err, this.i18n, 'acct.verifyFailed');
      }
      this.cdr.markForCheck();
      this.setupGoogleButton({ preserveError: true });
    }
  }

  // --- Student ID verification methods ---

  loadStudentIdVerification() {
    if (typeof this.accountService?.getStudentIdVerification !== 'function') return;
    this.accountService.getStudentIdVerification().subscribe({
      next: (res) => {
        this.studentIdRequest = res.request;
        this.cdr.markForCheck();
      },
      error: () => {},
    });
  }

  onStudentIdPhotoSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.selectedStudentIdFile = file;
    if (this.studentIdPreviewUrl) {
      URL.revokeObjectURL(this.studentIdPreviewUrl);
    }
    this.studentIdPreviewUrl = URL.createObjectURL(file);
    this.studentIdError = '';
    this.cdr.markForCheck();
  }

  onRemoveStudentIdPhoto() {
    this.selectedStudentIdFile = null;
    if (this.studentIdPreviewUrl) {
      URL.revokeObjectURL(this.studentIdPreviewUrl);
      this.studentIdPreviewUrl = null;
    }
    this.cdr.markForCheck();
  }

  startResubmitStudentId() {
    this.isResubmittingStudentId = true;
    this.studentNumberInput = this.studentIdRequest?.student_number || '';
    this.onRemoveStudentIdPhoto();
    this.studentIdError = '';
    this.cdr.markForCheck();
  }

  async onSubmitStudentIdVerification() {
    const school = this.targetStudentIdSchool;
    if (
      !school ||
      !this.selectedStudentIdFile ||
      !this.studentNumberInput.trim() ||
      this.isSubmittingStudentId
    ) {
      return;
    }
    this.isSubmittingStudentId = true;
    this.studentIdError = '';
    this.cdr.markForCheck();

    try {
      const uploadRes = await firstValueFrom(
        this.accountService.uploadStudentIdPhoto(this.selectedStudentIdFile, school.code),
      );
      await firstValueFrom(
        this.accountService.submitStudentIdVerification({
          school: school.code,
          student_number: this.studentNumberInput.trim().toUpperCase(),
          image: uploadRes.url,
        }),
      );
      this.isSubmittingStudentId = false;
      this.isResubmittingStudentId = false;
      this.onRemoveStudentIdPhoto();
      this.studentNumberInput = '';
      this.toast.success(this.i18n.t('acct.studentIdPendingNotice'));
      this.loadStudentIdVerification();
      this.cdr.markForCheck();
    } catch (err: any) {
      this.isSubmittingStudentId = false;
      this.studentIdError = parseApiError(err, this.i18n, 'acct.verifyFailed');
      this.cdr.markForCheck();
    }
  }

  async onCancelStudentIdVerification() {
    if (this.isCancellingStudentId) return;
    const confirmed = await this.confirms.askDanger(
      this.i18n.t('acct.cancelVerificationConfirm'),
      {
        confirmLabel: this.i18n.t('acct.cancelVerification'),
        cancelLabel: this.i18n.t('acct.keepVerificationRequest'),
      },
    );
    if (!confirmed) return;

    this.isCancellingStudentId = true;
    this.cdr.markForCheck();

    this.accountService.cancelStudentIdVerification().subscribe({
      next: () => {
        this.isCancellingStudentId = false;
        this.studentIdRequest = null;
        this.isResubmittingStudentId = false;
        this.toast.success(this.i18n.t('common.save'));
        this.loadStudentIdVerification();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isCancellingStudentId = false;
        this.toast.error(parseApiError(err, this.i18n, 'common.error'));
        this.cdr.markForCheck();
      },
    });
  }

  // --- Cooldown and state persistence ---

  private startResendCooldown(seconds: number) {
    const cooldownUntil = Date.now() + seconds * 1000;
    this.applyCooldownUntil(cooldownUntil);
  }

  private applyCooldownUntil(cooldownUntil: number) {
    this.stopResendCountdown();
    this.updateResendCooldownSeconds(cooldownUntil);
    this.savePendingVerificationState(cooldownUntil);
    if (this.resendCooldownSeconds === 0) {
      return;
    }

    this.resendCountdownTimer = setInterval(() => {
      this.updateResendCooldownSeconds(cooldownUntil);
      if (this.resendCooldownSeconds === 0) {
        this.stopResendCountdown();
        this.savePendingVerificationState();
      }
      this.cdr.markForCheck();
    }, 1000);
  }

  private updateResendCooldownSeconds(cooldownUntil: number) {
    const remainingMs = cooldownUntil - Date.now();
    this.resendCooldownSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  }

  private stopResendCountdown() {
    if (this.resendCountdownTimer !== null) {
      clearInterval(this.resendCountdownTimer);
      this.resendCountdownTimer = null;
    }
  }

  private clearPendingVerificationState() {
    this.pendingEduEmail = null;
    this.isEditingPendingEmail = false;
    this.resendCooldownSeconds = 0;
    this.stopResendCountdown();
    this.savePendingVerificationState();
  }

  private restorePendingVerificationState() {
    const pendingEmailStorageKey = this.getVerifyPendingEmailStorageKey();
    const cooldownUntilStorageKey = this.getVerifyCooldownUntilStorageKey();
    if (!pendingEmailStorageKey || !cooldownUntilStorageKey) {
      return;
    }
    const pendingEmail = localStorage.getItem(pendingEmailStorageKey);
    if (pendingEmail) {
      this.pendingEduEmail = pendingEmail;
      this.eduEmail = pendingEmail;
      this.isEditingPendingEmail = false;
    }

    const rawCooldownUntil = localStorage.getItem(cooldownUntilStorageKey);
    if (!rawCooldownUntil) {
      return;
    }
    const cooldownUntil = Number(rawCooldownUntil);
    if (!Number.isFinite(cooldownUntil) || cooldownUntil <= Date.now()) {
      localStorage.removeItem(cooldownUntilStorageKey);
      return;
    }
    this.applyCooldownUntil(cooldownUntil);
  }

  private savePendingVerificationState(cooldownUntil?: number) {
    const pendingEmailStorageKey = this.getVerifyPendingEmailStorageKey();
    const cooldownUntilStorageKey = this.getVerifyCooldownUntilStorageKey();
    if (!pendingEmailStorageKey || !cooldownUntilStorageKey) {
      return;
    }
    if (this.pendingEduEmail) {
      localStorage.setItem(pendingEmailStorageKey, this.pendingEduEmail);
    } else {
      localStorage.removeItem(pendingEmailStorageKey);
    }

    if (cooldownUntil && cooldownUntil > Date.now()) {
      localStorage.setItem(cooldownUntilStorageKey, String(cooldownUntil));
    } else {
      localStorage.removeItem(cooldownUntilStorageKey);
    }
  }

  private extractThrottleSeconds(err: any): number | null {
    const retryAfterHeader =
      err?.headers?.get?.('Retry-After') ?? err?.headers?.get?.('retry-after');
    if (retryAfterHeader) {
      const retryAfterSeconds = Number(retryAfterHeader);
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.ceil(retryAfterSeconds);
      }
      const retryAt = Date.parse(retryAfterHeader);
      if (Number.isFinite(retryAt)) {
        const remainingSeconds = Math.ceil((retryAt - Date.now()) / 1000);
        if (remainingSeconds > 0) {
          return remainingSeconds;
        }
      }
    }

    const waitValue = Number(err?.error?.error?.wait);
    if (Number.isFinite(waitValue) && waitValue > 0) {
      return Math.ceil(waitValue);
    }
    return null;
  }

  private clearLegacyPendingVerificationState() {
    if (typeof window === 'undefined') {
      return;
    }
    localStorage.removeItem(this.verifyPendingEmailStorageKeyLegacy);
    localStorage.removeItem(this.verifyCooldownUntilStorageKeyLegacy);
  }

  private getVerifyPendingEmailStorageKey(): string | null {
    if (typeof window === 'undefined' || !this.profileUserId) {
      return null;
    }
    return `${this.verifyPendingEmailStorageKeyLegacy}.${this.profileUserId}`;
  }

  private getVerifyCooldownUntilStorageKey(): string | null {
    if (typeof window === 'undefined' || !this.profileUserId) {
      return null;
    }
    return `${this.verifyCooldownUntilStorageKeyLegacy}.${this.profileUserId}`;
  }
}
