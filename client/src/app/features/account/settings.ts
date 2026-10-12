import { Component, inject, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { RegionService, Region } from '../../core/region.service';
import { AccountService } from '../../core/services/account.service';
import { AuthStore } from '../../core/auth.store';
import { isSameRegion } from '../../core/region-path';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ActivatedRoute, Router } from '@angular/router';
import { parseApiError } from '../../core/api-error.util';
import { SchoolRequestFormComponent } from './school-request-form.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { clearSensitiveParams } from '../../core/sensitive-url';

/** The verification answer that means "valid campus address, unknown campus". */
const SCHOOL_NOT_SUPPORTED = 'acct.errSchoolNotSupported';

@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiInput, TPipe, SchoolRequestFormComponent, UiSkeleton, UiErrorState],
  templateUrl: './settings.html',
  styleUrls: ['./settings.css']
})
export class SettingsComponent implements OnInit, OnDestroy {
  get currentRegion(): Region | null {
    return this.regionService.currentRegionObj();
  }

  get currentVerification(): any | null {
    if (!this.currentRegion) return null;
    return (this.verifications || []).find(v => isSameRegion(v.region, this.currentRegion!.code) && !!v.verified_at) || null;
  }

  private readonly verifyPendingEmailStorageKeyLegacy = 'unibooks.account.eduVerification.pendingEmail';
  private readonly verifyCooldownUntilStorageKeyLegacy = 'unibooks.account.eduVerification.cooldownUntil';

  email = '';
  firstName = '';
  lastName = '';
  eduEmail = '';
  verifications: any[] = [];
  pendingEduEmail: string | null = null;
  resendCooldownSeconds = 0;
  isEditingPendingEmail = false;
  isLoading = false;
  /** The first profile load has answered. Until then the form shows a
   *  placeholder: empty inputs and an "unverified" banner read as facts
   *  about the account, not as "still loading". */
  profileLoaded = false;
  /** The first profile load failed; nothing on the form can be trusted. */
  profileLoadFailed = false;
  verifyIsError = false;
  settingsIsError = false;
  isGoogleLinked = false;
  avatarUrl = '';
  /** Whether other users see the avatar; the owner always does. */
  showAvatar = true;
  savingShowAvatar = false;

  oldPassword = '';
  newPassword = '';
  confirmPassword = '';
  pwdIsError = false;
  hasPassword = true;

  clientVerifyMsg = '';
  lastVerifyError: any = null;
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
        seconds: this.resendCooldownSecondsPart
      });
    }
    return err.error?.detail || err.error?.edu_email?.[0] || this.i18n.t('acct.verifyFailed');
  }

  /** Whether the last manual verification attempt failed because the
   *  address's school is not in the registry — the case the "report my
   *  school" form is offered for. */
  get schoolNotSupported(): boolean {
    return !this.clientVerifyMsg && this.lastVerifyError?.error?.error?.code === SCHOOL_NOT_SUPPORTED;
  }

  clientSettingsMsg = '';
  lastSettingsError: any = null;
  get settingsMessage(): string {
    if (this.clientSettingsMsg) return this.i18n.t(this.clientSettingsMsg);
    if (!this.lastSettingsError) return '';
    const err = this.lastSettingsError;
    return err.error?.email?.[0] || this.i18n.t('acct.saveFailed');
  }

  clientPwdMsg = '';
  lastPwdError: any = null;
  get pwdMessage(): string {
    if (this.clientPwdMsg) return this.i18n.t(this.clientPwdMsg);
    if (!this.lastPwdError) return '';
    const err = this.lastPwdError;
    // Changing a password now runs Django's AUTH_PASSWORD_VALIDATORS, which
    // answer {error:{code:'auth.errValidation', fields:[...]}} — the shape
    // registration already knows. Nothing here read it, so "too short",
    // "too common" and "entirely numeric" all arrived as a bare "update
    // failed" with nothing to act on. The code itself is not shown:
    // auth.errValidation reads "provide an email and password", which is the
    // registration wording and wrong here. Each message falls back to itself,
    // since the validators answer in prose, not in i18n keys.
    const backend = err.error?.error;
    if (backend?.code === 'auth.errValidation') {
      // A list from the validators, but a lone string costs nothing to accept.
      const raw = backend.fields;
      const messages: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      const detail = messages.map((m: string) => this.i18n.tOrNull(m) ?? m).join(' ');
      return detail
        ? this.i18n.t('acct.errPasswordRejected', { msg: detail })
        : this.i18n.t('acct.updateFailed');
    }
    const code = this.i18n.tOrNull(backend?.code);
    if (code) return code;
    return err.error?.old_password?.[0] || err.error?.detail || this.i18n.t('acct.updateFailed');
  }

  removePasswordInput = '';
  clientRemovePwdMsg = '';
  lastRemovePwdError: any = null;
  removePwdIsError = false;
  get removePwdMessage(): string {
    if (this.clientRemovePwdMsg) return this.i18n.t(this.clientRemovePwdMsg);
    if (!this.lastRemovePwdError) return '';
    const err = this.lastRemovePwdError;
    const code = err.error?.error?.code;
    if (code) return this.i18n.t(code);
    return err.error?.password?.[0] || err.error?.detail || this.i18n.t('acct.updateFailed');
  }

  private authStore = inject(AuthStore);
  private accountService = inject(AccountService);
  public regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private resendCountdownTimer: ReturnType<typeof setInterval> | null = null;
  private profileUserId: string | null = null;

  get showPendingVerification(): boolean {
    return !this.isEditingPendingEmail && !!this.pendingEduEmail;
  }

  get resendCooldownMinutes(): number {
    return Math.floor(this.resendCooldownSeconds / 60);
  }

  get resendCooldownSecondsPart(): string {
    return (this.resendCooldownSeconds % 60).toString().padStart(2, '0');
  }

  get pendingEduEmailDisplay(): string {
    return this.pendingEduEmail || '';
  }

  get autoVerifyRegion(): Region | null {
    if (!this.email || this.currentVerification || !this.currentRegion) return null;
    const parts = this.email.split('@');
    if (parts.length !== 2) return null;
    const loginDomain = parts[1].toLowerCase();
    
    const suffixes = this.currentRegion.edu_email_suffix.map(s => {
      const lower = s.toLowerCase();
      return lower.startsWith('.') ? lower : '.' + lower;
    });
    
    if (suffixes.some(s => loginDomain.endsWith(s))) {
      return this.currentRegion;
    }
    return null;
  }

  /** A sign-in-email change waiting for the link in the new mailbox to be
   *  followed. Until then `email` below is still the address that works. */
  pendingEmail: string | null = null;

  ngOnInit() {
    this.clearLegacyPendingVerificationState();
    this.loadProfile();

    // The confirmation mail links back here with the token on the query
    // string; the address it was sent to may well be open in a browser that
    // is not signed in, which is why the endpoint takes the token as proof.
    const token = this.route.snapshot.queryParamMap.get('email_change_token');
    if (token) {
      clearSensitiveParams(this.router, this.route);
      this.confirmEmailChange(token);
    }
  }

  private confirmEmailChange(token: string) {
    this.accountService.confirmEmailChange(token).subscribe({
      next: () => {
        this.toast.success(this.i18n.t('acct.emailChanged'));
        this.accountService.clearProfileCache();
        this.loadProfile();
      },
      error: (err) => {
        this.toast.error(parseApiError(err, this.i18n, 'acct.errEmailChangeTokenInvalid'));
      },
    });
  }

  onCancelEmailChange() {
    this.accountService.cancelEmailChange().subscribe({
      next: () => {
        this.pendingEmail = null;
        this.toast.success(this.i18n.t('acct.emailChangeCancelled'));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
      },
    });
  }

  ngOnDestroy() {
    this.stopResendCountdown();
  }

  loadProfile() {
    this.profileLoadFailed = false;
    this.accountService.getMyProfile().subscribe({
      next: (data) => {
        this.profileLoaded = true;
        this.profileUserId = data.id ? String(data.id) : null;
        this.email = data.email || '';
        this.firstName = data.first_name || '';
        this.lastName = data.last_name || '';
        this.eduEmail = data.edu_email || '';
        this.verifications = data.verifications || [];
        this.hasPassword = data.has_password ?? true;
        this.isGoogleLinked = data.is_google_linked ?? false;
        this.avatarUrl = data.avatar_url || '';
        this.showAvatar = data.show_avatar ?? true;
        this.pendingEmail = data.pending_email ?? null;
        this.restorePendingVerificationState();
        if (this.verifications.length > 0) {
          this.clearPendingVerificationState();
        } else if (this.pendingEduEmail && !this.isEditingPendingEmail) {
          this.eduEmail = this.pendingEduEmail;
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        // A reload after the form is up (e.g. confirming an email change)
        // keeps the form and says so inline; a first load has no form yet.
        if (!this.profileLoaded) this.profileLoadFailed = true;
        this.settingsIsError = true;
        this.clientSettingsMsg = 'acct.loadProfileFailed';
        console.error('Failed to load profile', err);
        this.cdr.markForCheck();
      }
    });
  }

  async onRequestVerification() {
    const verifiedRegion = this.getVerifiedRegionForEmail(this.eduEmail);
    if (verifiedRegion) {
      const proceed = await this.confirms.ask(
        this.i18n.t('acct.regionAlreadyVerifiedConfirm', { region: verifiedRegion.localized_name })
      );
      if (!proceed) return;
    }
    this.submitEduVerification(this.eduEmail);
  }

  private getVerifiedRegionForEmail(emailInput: string): Region | null {
    if (!emailInput) return null;
    const parts = emailInput.trim().split('@');
    if (parts.length !== 2) return null;
    const loginDomain = parts[1].toLowerCase();
    
    const regions = this.regionService.regions();
    const matchedRegion = regions.find(r => {
      const suffixes = r.edu_email_suffix.map(s => {
        const lower = s.toLowerCase();
        return lower.startsWith('.') ? lower : '.' + lower;
      });
      return suffixes.some(s => loginDomain.endsWith(s));
    });
    
    if (matchedRegion) {
      const isVerified = (this.verifications || []).some(v => isSameRegion(v.region, matchedRegion.code) && !!v.verified_at);
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
    this.cdr.markForCheck();
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
      }
    });
  }

  autoVerifyMessage = '';
  autoVerifyIsError = false;
  /** Same as schoolNotSupported, for the one-click path that verifies the
   *  login address itself. */
  autoVerifySchoolNotSupported = false;

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
        // The panel hides once verified, so no need to keep a success message
        // around (it would otherwise reappear if the user unbinds later).
        this.autoVerifyMessage = '';
        this.loadProfile();
        this.eduEmail = this.email;
        this.clearPendingVerificationState();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.autoVerifyIsError = true;
        const code = err.error?.error?.code;
        this.autoVerifyMessage = code ? this.i18n.t(code) : this.i18n.t('acct.verifyFailed');
        this.autoVerifySchoolNotSupported = code === SCHOOL_NOT_SUPPORTED;
        this.cdr.markForCheck();
      }
    });
  }

  onUpdateProfile() {
    this.isLoading = true;
    this.clientSettingsMsg = '';
    this.lastSettingsError = null;
    this.settingsIsError = false;
    this.cdr.markForCheck();

    this.accountService.updateProfile({
      first_name: this.firstName,
      last_name: this.lastName,
      email: this.email
    }).subscribe({
      next: (resp) => {
        this.isLoading = false;
        // A new sign-in email is not applied on save — it waits for the link
        // sent to that address — so say so rather than "profile saved", which
        // would read as though the address had already changed.
        if (resp?.code === 'acct.emailChangePending') {
          this.clientSettingsMsg = 'acct.emailChangePending';
          // Re-read rather than trust the response: /auth/me/ reports the
          // pending address as well as the one still in force, and the field
          // above must go back to showing the address that actually works.
          this.accountService.clearProfileCache();
          this.loadProfile();
        } else {
          this.clientSettingsMsg = 'acct.profileSaved';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.settingsIsError = true;
        this.lastSettingsError = err;
        this.cdr.markForCheck();
      }
    });
  }

  setShowAvatar(input: HTMLInputElement) {
    const enabled = input.checked;
    if (enabled === this.showAvatar) return;

    // Move the switch straight away; put it back if the save fails, so it
    // never claims a setting the server does not have.
    const previous = this.showAvatar;
    this.showAvatar = enabled;
    this.savingShowAvatar = true;
    this.cdr.markForCheck();

    this.accountService.updateProfile({ show_avatar: enabled }).subscribe({
      next: () => {
        this.savingShowAvatar = false;
        this.toast.success(this.i18n.t(enabled ? 'acct.avatarShown' : 'acct.avatarHidden'));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.showAvatar = previous;
        // [checked] may see no change to undo, so move the box back directly.
        input.checked = previous;
        this.savingShowAvatar = false;
        this.toast.error(parseApiError(err, this.i18n, 'acct.showAvatarSaveFailed'));
        this.cdr.markForCheck();
      }
    });
  }

  onChangePassword() {
    this.clientPwdMsg = '';
    this.lastPwdError = null;
    
    if (this.hasPassword && !this.oldPassword) {
      this.pwdIsError = true;
      this.clientPwdMsg = 'auth.errFillAll';
      return;
    }
    if (!this.newPassword || !this.confirmPassword) {
      this.pwdIsError = true;
      this.clientPwdMsg = 'auth.errFillAll';
      return;
    }

    this.isLoading = true;
    this.pwdIsError = false;
    this.cdr.markForCheck();

    this.accountService.changePassword({
      old_password: this.oldPassword,
      new_password: this.newPassword
    }).subscribe({
      next: () => {
        this.isLoading = false;
        this.pwdIsError = false;
        this.clientPwdMsg = this.hasPassword ? 'acct.passwordUpdated' : 'acct.passwordSet';
        this.oldPassword = '';
        this.newPassword = '';
        this.confirmPassword = '';
        this.hasPassword = true; // They now have a password
        this.authStore.updateUser(u => ({ ...u, has_password: true }));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.pwdIsError = true;
        this.lastPwdError = err;
        this.cdr.markForCheck();
      }
    });
  }

  onRemovePassword() {
    this.clientRemovePwdMsg = '';
    this.lastRemovePwdError = null;

    if (!this.removePasswordInput) {
      this.removePwdIsError = true;
      this.clientRemovePwdMsg = 'auth.errFillAll';
      return;
    }

    this.isLoading = true;
    this.removePwdIsError = false;
    this.cdr.markForCheck();

    this.accountService.removePassword({ password: this.removePasswordInput }).subscribe({
      next: () => {
        this.isLoading = false;
        this.removePwdIsError = false;
        this.clientRemovePwdMsg = 'acct.passwordRemoved';
        this.removePasswordInput = '';
        this.hasPassword = false; // Immediately reflect in UI
        this.authStore.updateUser(u => ({ ...u, has_password: false })); // Sync AuthStore
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.removePwdIsError = true;
        this.lastRemovePwdError = err;
        this.cdr.markForCheck();
      }
    });
  }

  async onUnbindEduEmail(regionCode: string) {
    if (!await this.confirms.askDanger(this.i18n.t('acct.unbindConfirm'))) {
      return;
    }
    
    this.isLoading = true;
    this.accountService.unbindEduEmail(regionCode).subscribe({
      next: () => {
        this.isLoading = false;
        this.verifications = this.verifications.filter(v => !isSameRegion(v.region, regionCode));
        if (this.verifications.length === 0) {
          this.eduEmail = '';
        }
        this.clearPendingVerificationState();
        this.autoVerifyMessage = '';
        this.clientVerifyMsg = '';
        this.lastVerifyError = null;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
        this.cdr.markForCheck();
      }
    });
  }

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
    const retryAfterHeader = err?.headers?.get?.('Retry-After') ?? err?.headers?.get?.('retry-after');
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

    const waitValue = Number(err?.error?.wait ?? err?.error?.error?.wait);
    if (Number.isFinite(waitValue) && waitValue > 0) {
      return Math.ceil(waitValue);
    }

    const detail = String(err?.error?.detail ?? '');
    const match = detail.match(/Expected available in (\d+) seconds?/i);
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
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

  async onDeleteAccount() {
    if (!await this.confirms.askDanger(this.i18n.t('acct.deleteAccountConfirm'), {
      confirmLabel: this.i18n.t('common.delete'),
    })) {
      return;
    }
    
    this.isLoading = true;
    this.cdr.markForCheck();
    
    this.accountService.deleteAccount().subscribe({
      next: () => {
        this.isLoading = false;
        // logout() returns an Observable; it must be subscribed to actually run and redirect.
        this.authStore.logout().subscribe();
      },
      error: (err) => {
        this.isLoading = false;
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
        this.cdr.markForCheck();
      }
    });
  }
}
