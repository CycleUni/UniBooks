import { Component, ChangeDetectorRef, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AccountService } from '../../core/services/account.service';
import { parseApiError } from '../../core/api-error.util';

/**
 * "Report my school", shown under acct.errSchoolNotSupported on the account
 * page. That message used to be the end of the road: the user learned their
 * campus was missing and staff never learned anyone had asked for it.
 *
 * Collapsed to a single link until asked for, because it sits under an
 * error the user did not expect and should not bury it under a form.
 */
@Component({
  selector: 'app-school-request-form',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiInput, TPipe],
  template: `
    <div class="school-request">
      <p *ngIf="submitted" class="inline-msg ok" role="status">{{ 'acct.schoolRequestSuccess' | t }}</p>

      <ng-container *ngIf="!submitted">
        <button
          *ngIf="!open"
          type="button"
          class="link-btn"
          (click)="toggle()"
          [attr.aria-expanded]="open"
        >{{ 'acct.schoolRequestToggle' | t }}</button>

        <form *ngIf="open" class="school-request-form" (ngSubmit)="submit()" novalidate>
          <p class="desc">{{ 'acct.schoolRequestIntro' | t }}</p>
          <ui-input
            name="school_name"
            [label]="'acct.schoolRequestName' | t"
            [(ngModel)]="schoolName"
            [ngModelOptions]="{ standalone: true }"
            [error]="nameError"
            autocomplete="organization"
          ></ui-input>
          <ui-input
            name="school_website"
            type="url"
            inputmode="url"
            placeholder="https://"
            [label]="'acct.schoolRequestWebsite' | t"
            [(ngModel)]="schoolWebsite"
            [ngModelOptions]="{ standalone: true }"
            [error]="websiteError"
            autocomplete="url"
          ></ui-input>
          <div class="actions">
            <ui-button type="submit" [disabled]="sending">
              {{ (sending ? 'acct.sending' : 'acct.schoolRequestSubmit') | t }}
            </ui-button>
            <ui-button variant="ghost" (onClick)="toggle()" [disabled]="sending">{{ 'common.cancel' | t }}</ui-button>
          </div>
          <p *ngIf="errorMessage" class="inline-msg error" role="alert">{{ errorMessage }}</p>
        </form>
      </ng-container>
    </div>
  `,
  styles: [`
    .school-request {
      margin-top: 8px;
    }
    .link-btn {
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      color: var(--accent, var(--ink));
      text-decoration: underline;
      cursor: pointer;
    }
    .link-btn:hover {
      opacity: 0.8;
    }
    .school-request-form {
      margin-top: 8px;
      padding: 16px;
      background-color: var(--paper-warm);
      border: 1px solid var(--line);
      border-radius: 4px;
    }
    .desc {
      margin: 0 0 12px;
      color: var(--muted);
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
  `]
})
export class SchoolRequestFormComponent {
  /** The campus address the user just tried, sent along so staff can read
   *  the school's mail domain off it. */
  @Input() eduEmail = '';

  private accountService = inject(AccountService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  open = false;
  sending = false;
  submitted = false;
  schoolName = '';
  schoolWebsite = '';
  nameError = '';
  websiteError = '';
  errorMessage = '';

  toggle() {
    this.open = !this.open;
    this.errorMessage = '';
    this.nameError = '';
    this.websiteError = '';
  }

  submit() {
    if (this.sending) return;
    const name = this.schoolName.trim();
    const website = this.schoolWebsite.trim();

    // Same rules the backend applies, checked here first so the common
    // mistakes (empty field, a bare "school.edu") answer instantly and do
    // not spend one of the few requests the throttle allows.
    this.nameError = name.length >= 2 && name.length <= 255 ? '' : this.i18n.t('acct.errSchoolRequestName');
    this.websiteError = isHttpUrl(website) ? '' : this.i18n.t('acct.errSchoolRequestWebsite');
    this.errorMessage = '';
    if (this.nameError || this.websiteError) return;

    this.sending = true;
    const eduEmail = this.eduEmail.trim();
    this.accountService.createSchoolRequest({
      school_name: name,
      school_website: website,
      ...(eduEmail ? { edu_email: eduEmail } : {}),
    }).subscribe({
      next: () => {
        this.sending = false;
        this.submitted = true;
        this.open = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.sending = false;
        // DRF's throttle answers in English prose ({"detail": "..."}), which
        // parseApiError cannot look up, so the 429 gets its own sentence.
        this.errorMessage = err?.status === 429
          ? this.i18n.t('acct.schoolRequestThrottled')
          : parseApiError(err, this.i18n, 'acct.schoolRequestFailed');
        this.cdr.markForCheck();
      },
    });
  }
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return !!new URL(value).hostname;
  } catch {
    return false;
  }
}
