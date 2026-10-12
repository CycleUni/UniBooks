import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, inject, effect, ChangeDetectorRef, DestroyRef, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiButton } from '../../shared/ui/button.component';
import { UiPrefsSelector } from '../../shared/ui/prefs-selector.component';

import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { OrderService } from '../../core/services/order.service';
import { I18nService, TPipe } from '../../core/i18n.service';

import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { stripRegionPrefix } from '../../core/region-path';

/** The signed-in dashboard. It used to double as the login wall on the same
 *  URL; that half now lives at /login and /register, and the route's authGuard
 *  means everything below can assume there is a user. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, UiButton, UiPrefsSelector, TPipe],
  templateUrl: './account.html',
  styleUrls: ['./account.css']
})
export class Account {
  activeTab = 'listings';
  hasUnreadOrders = false;

  firstName = '';
  lastName = '';
  displayName = '';
  eduEmail = '';
  schoolName = '';
  verifiedAt: string | null = null;
  avatarUrl = '';
  showConfirmUnbindModal = false;
  /** /auth/me/ has answered, either way; the card shows placeholders until then. */
  profileLoaded = false;
  profileFailed = false;

  // Profile-card stats line — sourced from the same /auth/me/ payload
  // loadProfile() already fetches, so these reflect real counts rather
  // than invented placeholders. Listing counts are derived from the
  // (paginated, first-page) `myListings.results` status field, so they
  // may undercount for accounts with 20+ listings; subscription count
  // comes from the unpaginated `mySubscriptions` list and is exact.
  activeListingsCount = 0;
  soldListingsCount = 0;
  subscriptionsCount = 0;

  private accountService = inject(AccountService);
  private orderService = inject(OrderService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private router = inject(Router);

  /**
   * On /account itself rather than one of its pages. Phones show the menu
   * there (profile, then a list of pages) and only the page elsewhere; wide
   * screens always show both side by side.
   */
  atMenu = false;

  /** Staff reach the admin console from here on phones, where it is no
   *  longer a bottom tab (the desktop header still links it directly). */
  get isStaff(): boolean {
    return this.auth.isAuthenticated() && this.auth.user()?.is_staff === true;
  }

  constructor(public auth: AuthStore) {
    // Reload the profile when the language changes so localized fields
    // (e.g. the school name) come back in the new language
    // untracked: loadProfile reads AccountService's profile signals, and a
    // tracked read made every loading/cached change re-run this effect — each
    // run fetching the whole order list again for the unread dot.
    effect(() => {
      this.i18n.lang();
      untracked(() => this.loadProfile());
    });

    const syncAtMenu = () => {
      this.atMenu = stripRegionPrefix(this.router.url).split(/[?#]/)[0].replace(/\/$/, '') === '/account';
    };
    syncAtMenu();
    this.router.events
      .pipe(filter(e => e instanceof NavigationEnd), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => { syncAtMenu(); this.cdr.markForCheck(); });

    this.orderService.unreadOrders$.pipe(takeUntilDestroyed()).subscribe(unread => {
      this.hasUnreadOrders = unread;
      this.cdr.markForCheck();
    });
  }

  getAvatarInitial(): string {
    const last = this.lastName || '';
    const first = this.firstName || '';
    if (/[A-Za-z]/.test(last) || /[A-Za-z]/.test(first)) {
      return (first.charAt(0) || last.charAt(0) || this.i18n.t('acct.avatarFallback')).toUpperCase();
    }
    return (last.charAt(0) || first.charAt(0) || this.i18n.t('acct.avatarFallback')).toUpperCase();
  }

  doLogout() {
    this.auth.logout().subscribe();
  }

  confirmUnbindEduEmail() {
    this.showConfirmUnbindModal = true;
  }

  loadProfile() {
    this.accountService.getMyProfile().subscribe({
      next: (data) => {
        this.firstName = data.first_name || '';
        this.lastName = data.last_name || '';
        this.displayName = data.display_name || '';
        this.eduEmail = data.edu_email || '';
        this.schoolName = data.school_name || '';
        this.verifiedAt = data.verified_at || null;
        this.avatarUrl = data.avatar_url || '';
        const counts = data.myListingCounts;
        const listingResults = data.myListings?.results || [];
        this.activeListingsCount = counts?.active ?? listingResults.filter((l: any) => l.status === 'active').length;
        this.soldListingsCount = counts?.sold ?? listingResults.filter((l: any) => l.status === 'sold').length;
        this.subscriptionsCount = (data.mySubscriptions || []).length;
        this.orderService.checkUnreadOrders(String(data.id), data.last_seen_bought_orders_at, data.last_seen_sold_orders_at);
        this.profileLoaded = true;
        this.profileFailed = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load profile', err);
        // Fall back to the defaults rather than a placeholder that never ends.
        if (!this.profileLoaded) {
          this.profileLoaded = true;
          this.profileFailed = true;
        }
        this.cdr.markForCheck();
      }
    });
  }
}
