import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { RegionService } from '../../core/region.service';
import { isPhoneViewport, watchPhoneViewport } from '../../core/viewport';

/**
 * /account itself. On phones it renders nothing of its own: the parent
 * Account page shows its menu (profile, then a list of pages) at this URL.
 * Wide screens show that menu as a sidebar beside a page, so they open the
 * first one — accountIndexGuard already does on arrival, this covers a guard
 * bypassed, and it also follows a window widened past the phone breakpoint
 * while here, which otherwise left an empty page beside the sidebar.
 */
@Component({
  selector: 'app-account-index',
  template: '',
  standalone: true
})
export class AccountIndexComponent implements OnInit {
  private router = inject(Router);
  private regionService = inject(RegionService);
  private destroyRef = inject(DestroyRef);

  ngOnInit() {
    if (!isPhoneViewport()) {
      this.openFirstPage();
      return;
    }
    const stop = watchPhoneViewport(isPhone => {
      if (!isPhone) this.openFirstPage();
    });
    this.destroyRef.onDestroy(stop);
  }

  private openFirstPage() {
    const region = this.regionService.region();
    this.router.navigate([`/${region}/account/listings`], { replaceUrl: true });
  }
}
