import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NAV_UP_STATE, onViewTransitionCreated } from './view-transitions';

/** A route snapshot for `/hk/book` etc., reduced to what the hook reads. */
const snap = (path: string) => {
  const segs = path.split('/').filter(Boolean);
  return { firstChild: null, pathFromRoot: segs.map(p => ({ url: [{ path: p }] })) } as any;
};

describe('onViewTransitionCreated', () => {
  let trigger: 'imperative' | 'popstate';
  let state: Record<string, unknown> | undefined;
  let transition: { skipTransition: ReturnType<typeof vi.fn>; finished: Promise<void> };

  const run = (from: string, to: string) => {
    TestBed.runInInjectionContext(() =>
      onViewTransitionCreated({ transition: transition as any, from: snap(from), to: snap(to) }));
    return transition.skipTransition.mock.calls.length
      ? 'skipped'
      : document.documentElement.dataset['navTransition'];
  };

  beforeEach(() => {
    trigger = 'imperative';
    state = undefined;
    // Never settles, so the attribute stays readable after the call.
    transition = { skipTransition: vi.fn(), finished: new Promise(() => {}) };
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { currentNavigation: () => ({ trigger, extras: { state } }) } }],
    });
  });

  afterEach(() => delete document.documentElement.dataset['navTransition']);

  it('slides forward when opening a page from a tab', () => {
    expect(run('/hk', '/hk/book')).toBe('forward');
    expect(run('/hk/account/listings', '/hk/account/orders')).toBe('forward');
  });

  it('slides back on a back navigation to the page underneath', () => {
    trigger = 'popstate';
    expect(run('/hk/book', '/hk')).toBe('back');
  });

  it('slides back when going up to a parent screen, though it is a new navigation', () => {
    state = { [NAV_UP_STATE]: true };
    expect(run('/hk/account/listings', '/hk/account')).toBe('back');
  });

  it('crossfades between tab sections, including redirected ones and back between tabs', () => {
    expect(run('/hk', '/hk/search')).toBe('fade');
    expect(run('/hk/search', '/hk/account/listings')).toBe('fade');
    expect(run('/hk/book', '/hk/messages')).toBe('fade');
    trigger = 'popstate';
    expect(run('/hk/search', '/hk')).toBe('fade');
  });

  it('crossfades a region switch', () => {
    expect(run('/hk/book', '/tw/book')).toBe('fade');
  });

  it('skips navigations that stay on the same path', () => {
    expect(run('/hk/messages', '/hk/messages')).toBe('skipped');
  });
});
