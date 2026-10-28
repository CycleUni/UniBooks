import { Injectable, Pipe, PipeTransform, computed, inject, signal } from '@angular/core';
import { AuthStore, isAdminUser } from '../../core/auth.store';

export const MASKED_EMAIL = '••••••••';

/** Emails are masked across the admin UI unless a superuser opts in. The opt-in is per page load. */
@Injectable({ providedIn: 'root' })
export class AdminEmailVisibility {
  private auth = inject(AuthStore);
  private readonly requested = signal(false);

  /** Only superusers get the toggle. */
  readonly canReveal = computed(() => isAdminUser(this.auth.user()));
  readonly revealed = computed(() => this.canReveal() && this.requested());

  set(value: boolean) { this.requested.set(value); }
}

/** `{{ user.email | adminEmail }}` — the address for a revealing superuser, otherwise a mask. */
@Pipe({ name: 'adminEmail', standalone: true, pure: false })
export class AdminEmailPipe implements PipeTransform {
  private visibility = inject(AdminEmailVisibility);

  transform(value: string | null | undefined): string {
    if (!value) return '';
    return this.visibility.revealed() ? value : MASKED_EMAIL;
  }
}
