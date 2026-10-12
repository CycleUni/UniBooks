import { Component, OnInit, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { bookPreviewState, bookQueryParams, hasBookPreviewState, navigationWantsBookPreview } from './book-preview';

/** Reads the flag the way the book page does: from a queryParamMap
 *  subscription opened in ngOnInit. */
@Component({ template: '' })
class ProbePage implements OnInit {
  static seen: Array<{ isbn: string | null; preview: boolean }> = [];
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  ngOnInit() {
    this.route.queryParamMap.subscribe(params => {
      ProbePage.seen.push({ isbn: params.get('isbn'), preview: navigationWantsBookPreview(this.router) });
    });
  }
}

@Component({ template: '' })
class ListPage {}

describe('book preview state', () => {
  it('recognises only the exact state list pages attach', () => {
    expect(hasBookPreviewState(bookPreviewState())).toBe(true);
    expect(hasBookPreviewState({ bookPreview: 'true' })).toBe(false);
    expect(hasBookPreviewState(null)).toBe(false);
    expect(hasBookPreviewState(undefined)).toBe(false);
  });

  it('addresses a book by isbn, falling back to id, and never adds a cache flag', () => {
    expect(bookQueryParams({ isbn: '9781449319793', id: 2 })).toEqual({ isbn: '9781449319793' });
    expect(bookQueryParams({ id: 2 })).toEqual({ id: 2 });
    expect(bookQueryParams({ isbn: '', id: '' })).toEqual({});
  });

  describe('as seen by the book page', () => {
    let harness: RouterTestingHarness;
    let router: Router;

    beforeEach(async () => {
      ProbePage.seen = [];
      TestBed.configureTestingModule({
        providers: [provideRouter([
          { path: 'tw', component: ListPage },
          { path: 'tw/book', component: ProbePage },
        ])],
      });
      harness = await RouterTestingHarness.create('/tw');
      router = TestBed.inject(Router);
    });

    it('is set when a list link navigated with it', async () => {
      await router.navigate(['/tw/book'], { queryParams: { isbn: '1' }, state: bookPreviewState() });
      harness.detectChanges();
      expect(ProbePage.seen).toEqual([{ isbn: '1', preview: true }]);
    });

    it('is absent for a link opened directly', async () => {
      await harness.navigateByUrl('/tw/book?isbn=1');
      expect(ProbePage.seen).toEqual([{ isbn: '1', preview: false }]);
    });

    it('follows each navigation when the page is reused for another book', async () => {
      await router.navigate(['/tw/book'], { queryParams: { isbn: '1' }, state: bookPreviewState() });
      harness.detectChanges();
      await router.navigate(['/tw/book'], { queryParams: { isbn: '2' } });
      harness.detectChanges();
      await router.navigate(['/tw/book'], { queryParams: { isbn: '3' }, state: bookPreviewState() });
      harness.detectChanges();
      expect(ProbePage.seen).toEqual([
        { isbn: '1', preview: true },
        { isbn: '2', preview: false },
        { isbn: '3', preview: true },
      ]);
    });
  });
});
