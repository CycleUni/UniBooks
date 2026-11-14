import { Component, OnInit, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiSuccessCheck } from '../../shared/ui/success-check.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { AuthStore, PasskeyItem, isUserCancellation } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService, Region } from '../../core/region.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { MetadataService } from '../../core/services/metadata.service';
import { SchoolOption } from '../../core/services/school-state.service';
import { isSameRegion } from '../../core/region-path';
import { parseApiError, translateApiError } from '../../core/api-error.util';
import { LIMITS } from '../../core/limits';
import { clearSensitiveParams } from '../../core/sensitive-url';

@Component({
  selector: 'app-account-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TPipe,
    UiButton,
    UiInput,
    UiSuccessCheck,
    UiSkeleton,
    UiErrorState,
  ],
  templateUrl: './settings.html',
  styleUrls: ['./settings.css'],
})
export class SettingsComponent implements OnInit {
  readonly LIMITS = LIMITS;

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

  email = '';
  firstName = '';
  lastName = '';
  verifications: any[] = [];
  availableSchools: SchoolOption[] = [];
  isLoading = false;
  profileLoaded = false;
  profileLoadFailed = false;
  settingsIsError = false;
  isGoogleLinked = false;
  avatarUrl = '';
  showAvatar = true;
  savingShowAvatar = false;

  oldPassword = '';
  newPassword = '';
  confirmPassword = '';
  pwdIsError = false;
  hasPassword = true;

  passkeys: PasskeyItem[] = [];
  passkeyTwoStep = false;
  savingTwoStep = false;
  passkeysLoading = false;
  isAddingPasskey = false;
  editingPasskeyId: string | null = null;
  editingPasskeyName = '';
  isSavingPasskeyRename = false;
  deletingPasskeyId: string | null = null;
  passkeyIconErrors: Record<string, boolean> = {};

  pendingEmail: string | null = null;
  private savedEmail = '';
  emailChangePassword = '';

  clientSettingsMsg = '';
  lastSettingsError: any = null;

  clientPwdMsg = '';
  lastPwdError: any = null;

  removePasswordInput = '';
  clientRemovePwdMsg = '';
  lastRemovePwdError: any = null;
  removePwdIsError = false;

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

  get currentVerifiedSchoolName(): string {
    const v = this.currentVerification;
    if (!v) return '';
    const school = this.availableSchools.find((s) => s.id === v.school);
    return school ? school.display_name || school.name : v.school_name || '';
  }

  get mustVerify(): boolean {
    return this.authStore.mustVerifyIn(this.regionService.region());
  }

  get emailChanged(): boolean {
    return this.email.trim().toLowerCase() !== this.savedEmail.toLowerCase();
  }

  get removePasswordConfirmKey(): string {
    const hasPasskey = this.passkeys.length > 0;
    if (this.isGoogleLinked && hasPasskey) return 'acct.removePasswordConfirmBoth';
    return hasPasskey ? 'acct.removePasswordConfirmPasskey' : 'acct.removePasswordConfirmGoogle';
  }

  get supportsPasskeys(): boolean {
    return this.authStore.supportsPasskeys();
  }

  get settingsMessage(): string {
    if (this.clientSettingsMsg) return this.i18n.t(this.clientSettingsMsg);
    if (!this.lastSettingsError) return '';
    return translateApiError(this.lastSettingsError, this.i18n) ?? this.i18n.t('acct.saveFailed');
  }

  get pwdMessage(): string {
    if (this.clientPwdMsg) return this.i18n.t(this.clientPwdMsg);
    if (!this.lastPwdError) return '';
    const err = this.lastPwdError;
    const rejected: string[] = err.error?.error?.fields?.new_password ?? [];
    if (rejected.length) {
      const detail = rejected
        .map((code: string) => this.i18n.tOrNull(code))
        .filter(Boolean)
        .join(' ');
      return this.i18n.t('acct.errPasswordRejected', { msg: detail });
    }
    return translateApiError(err, this.i18n) ?? this.i18n.t('acct.updateFailed');
  }

  get removePwdMessage(): string {
    if (this.clientRemovePwdMsg) return this.i18n.t(this.clientRemovePwdMsg);
    if (!this.lastRemovePwdError) return '';
    return (
      translateApiError(this.lastRemovePwdError, this.i18n) ?? this.i18n.t('acct.updateFailed')
    );
  }

  ngOnInit() {
    this.loadProfile();
    this.loadSchoolsMetadata();
    if (this.supportsPasskeys) {
      this.loadPasskeys();
    }

    const token = this.route.snapshot.queryParamMap.get('email_change_token');
    if (token) {
      clearSensitiveParams(this.router, this.route);
      this.confirmEmailChange(token);
    }
  }

  loadProfile() {
    this.profileLoadFailed = false;
    this.accountService.getMyProfile().subscribe({
      next: (data) => {
        this.profileLoaded = true;
        this.email = data.email || '';
        this.savedEmail = this.email;
        this.emailChangePassword = '';
        this.firstName = data.first_name || '';
        this.lastName = data.last_name || '';
        this.verifications = data.verifications || [];
        this.hasPassword = data.has_password ?? true;
        this.isGoogleLinked = data.is_google_linked ?? false;
        this.passkeyTwoStep = data.passkey_2fa ?? false;
        this.avatarUrl = data.avatar_url || '';
        this.showAvatar = data.show_avatar ?? true;
        this.pendingEmail = data.pending_email ?? null;
        this.cdr.markForCheck();
      },
      error: (err) => {
        if (!this.profileLoaded) this.profileLoadFailed = true;
        this.settingsIsError = true;
        this.clientSettingsMsg = 'acct.loadProfileFailed';
        console.error('Failed to load profile', err);
        this.cdr.markForCheck();
      },
    });
  }

  loadSchoolsMetadata() {
    this.metadataService.getMetadata().subscribe({
      next: (data) => {
        this.availableSchools = data?.schools || [];
        this.cdr.markForCheck();
      },
      error: () => {},
    });
  }

  private confirmEmailChange(token: string) {
    this.accountService
      .confirmEmailChange(token)
      .pipe(this.toast.working(this.i18n.t('common.processing')))
      .subscribe({
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
    this.accountService
      .cancelEmailChange()
      .pipe(this.toast.working(this.i18n.t('common.cancelling')))
      .subscribe({
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

  onUpdateProfile() {
    this.isLoading = true;
    this.clientSettingsMsg = '';
    this.lastSettingsError = null;
    this.settingsIsError = false;
    this.cdr.markForCheck();

    this.accountService
      .updateProfile({
        first_name: this.firstName,
        last_name: this.lastName,
        email: this.email,
        ...(this.emailChanged ? { current_password: this.emailChangePassword } : {}),
      })
      .subscribe({
        next: (resp) => {
          this.isLoading = false;
          if (resp?.code === 'acct.emailChangePending') {
            this.clientSettingsMsg = 'acct.emailChangePending';
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
        },
      });
  }

  setShowAvatar(input: HTMLInputElement) {
    const enabled = input.checked;
    if (enabled === this.showAvatar) return;

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
        input.checked = previous;
        this.savingShowAvatar = false;
        this.toast.error(parseApiError(err, this.i18n, 'acct.showAvatarSaveFailed'));
        this.cdr.markForCheck();
      },
    });
  }

  onChangePassword() {
    this.clientPwdMsg = '';
    this.lastPwdError = null;

    if (!this.oldPassword || !this.newPassword || !this.confirmPassword) {
      this.pwdIsError = true;
      this.clientPwdMsg = 'auth.errFillAll';
      return;
    }

    this.isLoading = true;
    this.pwdIsError = false;
    this.cdr.markForCheck();

    this.accountService
      .changePassword({
        old_password: this.oldPassword,
        new_password: this.newPassword,
      })
      .subscribe({
        next: () => {
          this.isLoading = false;
          this.pwdIsError = false;
          this.clientPwdMsg = 'acct.passwordUpdated';
          this.oldPassword = '';
          this.newPassword = '';
          this.confirmPassword = '';
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isLoading = false;
          this.pwdIsError = true;
          this.lastPwdError = err;
          this.cdr.markForCheck();
        },
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
        this.hasPassword = false;
        this.authStore.updateUser((u) => ({ ...u, has_password: false }));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.removePwdIsError = true;
        this.lastRemovePwdError = err;
        this.cdr.markForCheck();
      },
    });
  }

  async onDeleteAccount() {
    if (
      !(await this.confirms.askDanger(this.i18n.t('acct.deleteAccountConfirm'), {
        confirmLabel: this.i18n.t('common.delete'),
      }))
    ) {
      return;
    }

    this.isLoading = true;
    this.cdr.markForCheck();

    this.accountService.deleteAccount().subscribe({
      next: () => {
        this.isLoading = false;
        this.authStore.logout().subscribe();
      },
      error: (err) => {
        this.isLoading = false;
        this.cdr.markForCheck();
        if (this.offerSignInAgain(err)) return;
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
      },
    });
  }

  loadPasskeys(): void {
    if (!this.supportsPasskeys) return;
    this.passkeysLoading = true;
    this.accountService.listPasskeys().subscribe({
      next: (list) => {
        this.passkeys = list;
        if (list.length === 0) this.passkeyTwoStep = false;
        this.passkeyIconErrors = {};
        this.passkeysLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.passkeysLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  onAddPasskey(): void {
    if (this.isAddingPasskey) return;
    this.isAddingPasskey = true;
    this.cdr.markForCheck();

    this.accountService.passkeyRegister().subscribe({
      next: () => {
        this.isAddingPasskey = false;
        this.toast.success(this.i18n.t('acct.passkeyAdded'));
        this.loadPasskeys();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isAddingPasskey = false;
        this.cdr.markForCheck();
        if (isUserCancellation(err) || this.offerSignInAgain(err)) {
          return;
        }
        this.toast.error(parseApiError(err, this.i18n, 'auth.errPasskeyRegistration'));
      },
    });
  }

  startRenamePasskey(passkey: PasskeyItem): void {
    this.editingPasskeyId = passkey.id;
    this.editingPasskeyName = passkey.name;
    this.cdr.markForCheck();
  }

  cancelRenamePasskey(): void {
    this.editingPasskeyId = null;
    this.editingPasskeyName = '';
    this.cdr.markForCheck();
  }

  saveRenamePasskey(id: string): void {
    const trimmed = this.editingPasskeyName.trim();
    if (!trimmed || this.isSavingPasskeyRename) return;
    this.isSavingPasskeyRename = true;
    this.cdr.markForCheck();

    this.accountService.renamePasskey(id, trimmed).subscribe({
      next: () => {
        this.isSavingPasskeyRename = false;
        this.editingPasskeyId = null;
        this.editingPasskeyName = '';
        this.toast.success(this.i18n.t('acct.passkeyRenamed'));
        this.loadPasskeys();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isSavingPasskeyRename = false;
        this.toast.error(parseApiError(err, this.i18n, 'acct.errRenamePasskey'));
        this.cdr.markForCheck();
      },
    });
  }

  setPasskeyTwoStep(input: HTMLInputElement): void {
    const enabled = input.checked;
    if (enabled === this.passkeyTwoStep) return;
    const previous = this.passkeyTwoStep;
    this.passkeyTwoStep = enabled;
    this.savingTwoStep = true;
    this.cdr.markForCheck();
    this.accountService.setPasskeyTwoStep(enabled).subscribe({
      next: () => {
        this.savingTwoStep = false;
        this.toast.success(this.i18n.t(enabled ? 'acct.twoStepOn' : 'acct.twoStepOff'));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.passkeyTwoStep = previous;
        input.checked = previous;
        this.savingTwoStep = false;
        this.cdr.markForCheck();
        if (this.offerSignInAgain(err)) return;
        this.toast.error(parseApiError(err, this.i18n, 'acct.errTwoStep'));
      },
    });
  }

  async onDeletePasskey(passkey: PasskeyItem): Promise<void> {
    const confirmed = await this.confirms.askDanger(
      this.i18n.t('acct.deletePasskeyConfirm', { name: passkey.name }),
      { confirmLabel: this.i18n.t('common.delete') },
    );
    if (!confirmed) return;

    this.deletingPasskeyId = passkey.id;
    this.cdr.markForCheck();

    this.accountService.deletePasskey(passkey.id).subscribe({
      next: () => {
        this.deletingPasskeyId = null;
        this.toast.success(this.i18n.t('acct.passkeyDeleted'));
        this.loadPasskeys();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.deletingPasskeyId = null;
        this.cdr.markForCheck();
        if (this.offerSignInAgain(err)) return;
        this.toast.error(parseApiError(err, this.i18n, 'acct.errDeletePasskey'));
      },
    });
  }

  onPasskeyIconError(id: string): void {
    this.passkeyIconErrors[id] = true;
    this.cdr.markForCheck();
  }

  private offerSignInAgain(err: any): boolean {
    if (err?.error?.error?.code !== 'auth.errReauthRequired') return false;
    void this.confirms
      .ask({
        title: this.i18n.t('acct.reauthTitle'),
        message: this.i18n.t('auth.errReauthRequired'),
        confirmLabel: this.i18n.t('acct.reauthSignIn'),
      })
      .then((again) => {
        if (again) this.authStore.logout(this.router.url).subscribe();
      });
    return true;
  }
}
