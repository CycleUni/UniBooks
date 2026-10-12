import { TestBed } from '@angular/core/testing';
import { Route, Router, UrlTree, convertToParamMap } from '@angular/router';
import { regionGuard, rootRedirectGuard } from './region.guard';
import { RegionService } from './region.service';
import { routes } from '../app.routes';

/**
 * The `:region` route the guard is attached to, with the whole feature route
 * table hanging off it — that is how the guard tells "a path that lost its
 * region prefix" from "a region code that does not exist".
 */
const REGION_ROUTE = routes.find(r => r.path === ':region')!;

/** The guard reads the `region` path parameter and its own route config. */
const routeWith = (region: string | null, routeConfig: Route | null = REGION_ROUTE) =>
  ({
    paramMap: convertToParamMap(region === null ? {} : { region }),
    routeConfig,
  }) as any;

const stateWith = (url: string) => ({ url }) as any;

describe('regionGuard', () => {
  let mockRegionService: any;
  let router: Router;

  const run = (region: string | null, url: string, routeConfig: Route | null = REGION_ROUTE) =>
    TestBed.runInInjectionContext(() => regionGuard(routeWith(region, routeConfig), stateWith(url)));

  beforeEach(() => {
    mockRegionService = {
      regions: vi.fn(() => [{ code: 'TW' }, { code: 'HK' }]),
      region: vi.fn(() => 'tw'),
      setRegion: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: RegionService, useValue: mockRegionService }],
    });
    router = TestBed.inject(Router);
  });

  it('lets a known region through and syncs the service', () => {
    mockRegionService.region.mockReturnValue('hk');
    expect(run('tw', '/tw/search')).toBe(true);
    expect(mockRegionService.setRegion).toHaveBeenCalledWith('tw', true);
  });

  it('rewrites an unknown region to the first configured one', () => {
    const result = run('xx', '/xx/search') as UrlTree;
    expect(result).toBeInstanceOf(UrlTree);
    expect(result.toString()).toBe('/tw/search');
  });

  it('falls back to tw before the region list has loaded', () => {
    mockRegionService.regions.mockReturnValue([]);
    expect((run('xx', '/xx/search') as UrlTree).toString()).toBe('/tw/search');
  });

  it('keeps query parameters and the fragment across the rewrite', () => {
    const result = run('xx', '/xx/search?q=physics&page=2#results') as UrlTree;
    const s = result.toString();
    expect(s).toContain('/tw/search');
    expect(s).toContain('q=physics');
    expect(s).toContain('page=2');
    expect(s).toContain('#results');
  });

  it('does not corrupt a query value that repeats the region segment', () => {
    // A plain string replace of '/xx' would have hit whichever came first.
    const result = run('xx', '/xx/search?next=%2Fxx%2Fbook') as UrlTree;
    const s = result.toString();
    expect(s.startsWith('/tw/search')).toBe(true);
    expect(s).toContain('%2Fxx%2Fbook');
  });

  it('rewrites a segment that had to be percent-encoded, rather than looping', () => {
    // paramMap decodes ('a b'); state.url does not ('/a%20b/search'). The old
    // string replace compared the two, matched nothing, and returned the URL
    // unchanged — navigating to it re-entered this guard forever.
    const result = run('a b', '/a%20b/search') as UrlTree;
    expect(result).toBeInstanceOf(UrlTree);
    expect(result.toString()).toBe('/tw/search');
  });

  it('rewrites a bare region with no child path', () => {
    expect((run('xx', '/xx') as UrlTree).toString()).toBe('/tw');
  });

  it('passes through when there is no region parameter at all', () => {
    expect(run(null, '/')).toBe(true);
  });

  // Every feature route lives under `:region`, so a link that arrives without
  // the prefix binds `region` to the *page name*. These used to be rewritten
  // as if they were bad region codes, which dropped the page: every link the
  // backend puts in an email (`/verify?token=…`, `/reset-password?token=…`,
  // `/messages?chat=…`, `/book?isbn=…`) landed on the homepage instead.
  describe('a route path that arrived without its region prefix', () => {
    it('keeps the page and gains the region, rather than replacing the page', () => {
      expect((run('messages', '/messages') as UrlTree).toString()).toBe('/tw/messages');
    });

    it('keeps the query string that the page needs', () => {
      const result = run('messages', '/messages?chat=abc-123') as UrlTree;
      expect(result.toString()).toBe('/tw/messages?chat=abc-123');
    });

    it('fixes the activation link in the registration email', () => {
      const result = run('verify', '/verify?token=t0ken&type=register') as UrlTree;
      const s = result.toString();
      expect(s.startsWith('/tw/verify')).toBe(true);
      expect(s).toContain('token=t0ken');
      expect(s).toContain('type=register');
    });

    it('fixes the waitlist email link', () => {
      expect((run('book', '/book?isbn=9780134685991') as UrlTree).toString())
        .toBe('/tw/book?isbn=9780134685991');
    });

    it('keeps every segment of a deeper path', () => {
      // Previously became `/tw/settings`, a route that does not exist.
      expect((run('account', '/account/settings') as UrlTree).toString()).toBe('/tw/account/settings');
    });

    it('matches a route with parameters by its first segment', () => {
      expect((run('listing', '/listing/9f1c') as UrlTree).toString()).toBe('/tw/listing/9f1c');
    });

    it('uses the region the viewer is currently in', () => {
      mockRegionService.region.mockReturnValue('hk');
      expect((run('messages', '/messages') as UrlTree).toString()).toBe('/hk/messages');
    });

    it('still replaces a segment that is not a route of this app', () => {
      // A genuinely wrong region code keeps the old behaviour: `/xx/search`
      // is a mistyped region, not a page called `xx`.
      expect((run('xx', '/xx/search') as UrlTree).toString()).toBe('/tw/search');
    });
  });
});

describe('rootRedirectGuard', () => {
  let mockRegionService: any;

  const run = async (url: string) =>
    (await TestBed.runInInjectionContext(() => rootRedirectGuard({} as any, stateWith(url)))) as UrlTree;

  beforeEach(() => {
    mockRegionService = {
      region: vi.fn(() => 'hk'),
      detectInitialRegion: vi.fn(() => Promise.resolve()),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: RegionService, useValue: mockRegionService }],
    });
    TestBed.inject(Router);
  });

  it('prefixes the current region onto a bare path', async () => {
    expect((await run('/search')).toString()).toBe('/hk/search');
  });

  it('does not leave a trailing slash at the root', async () => {
    expect((await run('/')).toString()).toBe('/hk');
  });

  it('keeps the query string at the root', async () => {
    // Facebook and Instagram add ?fbclid=… to every outbound link, campaign
    // links carry ?utm_…; "/tw/?fbclid=…" matched no route and showed a 404.
    expect((await run('/?fbclid=abc')).toString()).toBe('/hk?fbclid=abc');
    expect((await run('/?utm_source=line&utm_medium=social')).toString()).toBe('/hk?utm_source=line&utm_medium=social');
  });

  it('keeps the query string and fragment on a bare path', async () => {
    expect((await run('/search?q=calculus#results')).toString()).toBe('/hk/search?q=calculus#results');
  });

  it('defaults to tw when the service has no region yet', async () => {
    mockRegionService.region.mockReturnValue('');
    expect((await run('/search')).toString()).toBe('/tw/search');
  });

  it('redirects to the region IP detection settled on', async () => {
    let region = 'tw';
    mockRegionService.region.mockImplementation(() => region);
    mockRegionService.detectInitialRegion.mockImplementation(async () => { region = 'hk'; });
    expect((await run('/')).toString()).toBe('/hk');
  });
});
