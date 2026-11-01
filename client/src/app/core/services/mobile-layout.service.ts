import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MobileLayoutService {
  readonly hideBottomNav = signal<boolean>(false);

  setHideBottomNav(hide: boolean) {
    this.hideBottomNav.set(hide);
  }
}
