import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Router, provideRouter, withRouterConfig } from '@angular/router';
import { NavigationHistoryService, parentPageOf } from './navigation-history.service';

@Component({ template: '' })
class Blank {}

describe('NavigationHistoryService', () => {
  let router: Router;
  let history: NavigationHistoryService;

  const go = (url: string) => router.navigateByUrl(url);
  // The router handles a popstate in a setTimeout, then navigates async.
  const settle = () => new Promise(r => setTimeout(r, 50));

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [{ path: '**', component: Blank }],
          // As in app.config.ts: the router keeps a page id in history.state.
          withRouterConfig({ canceledNavigationResolution: 'computed' }),
        ),
        provideLocationMocks(),
      ],
    });
    router = TestBed.inject(Router);
    history = TestBed.inject(NavigationHistoryService);
    // What app bootstrap does: start listening for back/forward.
    router.initialNavigation();
    await go('/hk');
  });

  it('has nothing to go back to on the first page of the session', () => {
    expect(history.canGoBack).toBe(false);
  });

  it('goes back to the previous page, past every URL of the current one', async () => {
    await go('/hk/search');
    await go('/hk/search?q=calculus');
    await go('/hk/search?q=calculus&condition=new');
    expect(history.canGoBack).toBe(true);

    history.goBack();
    await settle();
    expect(router.url).toBe('/hk');
    expect(history.canGoBack).toBe(false);
  });

  it('counts a page left and returned to as a new page', async () => {
    await go('/hk/search?q=a');
    await go('/hk/book?isbn=1');
    await go('/hk/search?q=b');

    history.goBack();
    await settle();
    expect(router.url).toBe('/hk/book?isbn=1');
  });

  it('forgets forward history once a new page is opened', async () => {
    await go('/hk/book?isbn=1');
    history.goBack();
    await settle();
    await go('/hk/sell');

    history.goBack();
    await settle();
    expect(router.url).toBe('/hk');
  });

  it('goes up to the account menu from an account page, wherever it was opened from', async () => {
    await go('/hk/search?q=a');
    await go('/hk/account/listings');
    expect(history.canGoBack).toBe(true);

    history.goBack();
    await settle();
    expect(router.url).toBe('/hk/account');
  });

  it('steps back through history when the parent is the previous page', async () => {
    await go('/hk/account');
    await go('/hk/account/orders');
    history.goBack();
    await settle();
    expect(router.url).toBe('/hk/account');
    // A history step, not a new entry: back again leaves the section.
    history.goBack();
    await settle();
    expect(router.url).toBe('/hk');
  });

  it('offers back on an account page even with no history', async () => {
    await go('/hk/account/settings');
    // Arrived after /hk here, but the parent alone would be enough.
    expect(history.canGoBack).toBe(true);
  });
});

describe('parentPageOf', () => {
  it('puts pages inside a tab section under that tab', () => {
    expect(parentPageOf('/hk/account/listings?sort=new')).toBe('/hk/account');
    expect(parentPageOf('/tw/account/orders/')).toBe('/tw/account');
  });

  it('gives no parent to tab screens or pages reachable from anywhere', () => {
    expect(parentPageOf('/hk/account')).toBeNull();
    expect(parentPageOf('/hk/book')).toBeNull();
    expect(parentPageOf('/hk/listing/42')).toBeNull();
    expect(parentPageOf('/hk')).toBeNull();
  });
});
