import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MobileLayoutService {
  readonly hideBottomNav = signal<boolean>(false);
  /** A page's own bar takes the bottom tabs' place (the inbox's edit mode);
   *  unlike hideBottomNav, the top app header stays. */
  readonly bottomTabsReplaced = signal<boolean>(false);

  setHideBottomNav(hide: boolean) {
    this.hideBottomNav.set(hide);
  }
}
