import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { ListingsComponent, editablePhotos } from './listings';
import { SELL_MAX_PHOTOS } from '../sell/sell';
import { Subject } from 'rxjs';
import { en } from '../../core/i18n/en';

describe('ListingsComponent.submitEdit', () => {
  let component: ListingsComponent;
  let updateListing: ReturnType<typeof vi.fn>;
  let toastError: ReturnType<typeof vi.fn>;

  const manualListing = {
    id: 'l1',
    book_source: 'manual',
    book_title: 'Linear Algebra',
    book_authors: 'Strang',
    isbn: '9780980232714',
    price: 300,
    condition: 'good',
    description: '',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ListingsComponent, HttpClientTestingModule, RouterTestingModule],
    });
    component = TestBed.createComponent(ListingsComponent).componentInstance;

    updateListing = vi.fn().mockReturnValue(of({}));
    toastError = vi.fn();
    (component as any).listingService = { updateListing };
    (component as any).toast = { error: toastError, success: vi.fn() };
    (component as any).accountService = { clearProfileCache: vi.fn() };
    component.loadMyListings = vi.fn();

    component.editingListing = { ...manualListing };
    component.editForm = {
      price: 300,
      condition: 'good',
      category: '',
      course_name: '',
      professor_name: '',
      private_note: '',
      description: '',
      photos: [],
      book_title: manualListing.book_title,
      book_authors: manualListing.book_authors,
      isbn: manualListing.isbn,
    } as any;
  });

  it('leaves the book fields out when the seller only touched the listing', () => {
    // A Book row is shared by every listing of that title, so the backend
    // refuses book-field edits once a second seller lists the same manual
    // book. Sending the unchanged title/authors/ISBN with a price edit made
    // that refusal apply to edits that changed no book field at all.
    component.editForm.price = 250;
    component.submitEdit();

    const payload = updateListing.mock.calls[0][1];
    expect(payload.price).toBe(250);
    expect('book_title' in payload).toBe(false);
    expect('book_authors' in payload).toBe(false);
    expect('isbn' in payload).toBe(false);
  });

  it('still sends the book fields the seller actually changed', () => {
    component.editForm.book_title = 'Linear Algebra, 5th ed.';
    component.submitEdit();

    const payload = updateListing.mock.calls[0][1];
    expect(payload.book_title).toBe('Linear Algebra, 5th ed.');
    expect('book_authors' in payload).toBe(false);
    expect('isbn' in payload).toBe(false);
  });

  it('treats null and empty-string as the same ISBN', () => {
    component.editingListing = { ...manualListing, isbn: null };
    component.editForm.isbn = '';
    component.submitEdit();

    expect('isbn' in updateListing.mock.calls[0][1]).toBe(false);
  });

  it('shows the reason the backend gave instead of a blanket failure', () => {
    updateListing.mockReturnValue(throwError(() => ({
      status: 403,
      error: { error: { code: 'listing.errBookShared' } },
    })));

    component.submitEdit();

    expect(toastError).toHaveBeenCalledWith(en['listing.errBookShared']);
  });
});

describe('ListingsComponent listing management', () => {
  let component: ListingsComponent;
  let getMyProfile: ReturnType<typeof vi.fn>;
  let updateListing: ReturnType<typeof vi.fn>;
  let deleteListing: ReturnType<typeof vi.fn>;
  let askDanger: ReturnType<typeof vi.fn>;
  let toast: { success: any; error: any; info: any };

  const listing = (over: Record<string, any> = {}) => ({
    id: 'l1', book_title: 'Calculus', price: 300, condition: 'new', status: 'active', ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ListingsComponent, HttpClientTestingModule, RouterTestingModule],
    });
    component = TestBed.createComponent(ListingsComponent).componentInstance;

    getMyProfile = vi.fn().mockReturnValue(of({
      myListings: { count: 3, results: [listing()] },
      myListingCounts: { all: 3, active: 1, reserved: 0, sold: 1, removed: 1 },
    }));
    updateListing = vi.fn().mockReturnValue(of({}));
    deleteListing = vi.fn().mockReturnValue(of({}));
    askDanger = vi.fn().mockResolvedValue(true);
    toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

    (component as any).accountService = { getMyProfile, clearProfileCache: vi.fn() };
    (component as any).listingService = { updateListing, deleteListing };
    (component as any).confirms = { askDanger };
    (component as any).toast = toast;
    (component as any).syncUrl = vi.fn();
    (component as any).i18n = { t: (k: string) => k };
  });

  it('asks the server for the chosen status and order', () => {
    component.onStatusChange('sold');
    // The default order is not sent: the backend defaults to it, and leaving
    // it out lets the unfiltered first page share the shell's cached request.
    expect(getMyProfile).toHaveBeenLastCalledWith(1, '', { status: 'sold', sort: undefined });

    component.onSortChange('price_desc');
    expect(getMyProfile).toHaveBeenLastCalledWith(1, '', { status: 'sold', sort: 'price_desc' });
  });

  // A failed load is not "no listings yet": the empty state would invite
  // the user to list a book they may well have listed already.
  it('marks a failed first load as failed, not empty, and lets a retry clear it', () => {
    getMyProfile.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    component.loadMyListings();
    expect(component.loadFailed).toBe(true);
    expect(component.loading).toBe(false);
    // The error state says it on an empty page; no toast on top of it.
    expect(toast.error).not.toHaveBeenCalled();

    component.loadMyListings();
    expect(component.loadFailed).toBe(false);
    expect(component.myListings.length).toBe(1);
  });

  it('starts over at page one whenever the list changes shape', () => {
    component.currentPage = 3;
    component.onStatusChange('active');
    expect(component.currentPage).toBe(1);

    component.currentPage = 3;
    component.onSearchQuery('calc');
    expect(component.currentPage).toBe(1);

    component.currentPage = 3;
    component.onSortChange('oldest');
    expect(component.currentPage).toBe(1);
  });

  it('keeps the tab counts, which describe the whole shelf', () => {
    component.loadMyListings();
    expect(component.counts).toEqual({ all: 3, active: 1, reserved: 0, sold: 1, removed: 1 });
    expect(component.totalListings).toBe(3);
  });

  it('confirms before deleting, and does nothing when refused', async () => {
    askDanger.mockResolvedValueOnce(false);
    await component.onDelete('l1');
    expect(deleteListing).not.toHaveBeenCalled();

    await component.onDelete('l1');
    expect(deleteListing).toHaveBeenCalledWith('l1');
    expect(toast.success).toHaveBeenCalledWith('acct.listingDeleted');
  });

  it('saves a status change through the edit form', () => {
    component.editingListing = listing();
    component.editForm = {
      price: 300, condition: 'new', status: 'sold',
      category: '', course_name: '', professor_name: '',
      private_note: '', description: '', photos: [],
    };
    component.submitEdit();
    const payload = updateListing.mock.calls[0][1];
    expect(payload.status).toBe('sold');
    expect(toast.success).toHaveBeenCalledWith('acct.saved');
    expect(component.editingListing).toBeNull();
  });

  it('copies the public link of a listing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    (component as any).regionLink = { path: () => ['/', 'tw', 'listing', 'l1'] };

    await component.onListingAction({ type: 'copy_link', id: 'l1' });

    expect(writeText).toHaveBeenCalledWith(`${location.origin}/tw/listing/l1`);
    expect(toast.success).toHaveBeenCalledWith('acct.linkCopied');
  });

  it('offers to clear the filters when a filtered list comes back empty', () => {
    expect(component.hasFilters).toBe(false);
    component.status = 'sold';
    expect(component.hasFilters).toBe(true);
    component.clearFilters();
    expect(component.status).toBe('');
    expect(component.searchQuery).toBe('');
  });
});

describe('editablePhotos', () => {
  it('starts from every photo the listing carries, in order', () => {
    expect(editablePhotos({ photos: ['a.jpg', 'b.jpg', 'c.jpg'], photo_url: 'a.jpg' })).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('falls back to the cover photo only when there is no list', () => {
    expect(editablePhotos({ photo_url: 'a.jpg' })).toEqual(['a.jpg']);
    expect(editablePhotos({ photo_url: '' })).toEqual([]);
    expect(editablePhotos({ photos: [], photo_url: '' })).toEqual([]);
  });

  it('keeps photos beyond the form cap rather than dropping them on save', () => {
    const six = ['1', '2', '3', '4', '5', '6'].map(n => `${n}.jpg`);
    expect(editablePhotos({ photos: six })).toEqual(six);
  });
});

describe('ListingsComponent edit dialog photos', () => {
  let fixture: ComponentFixture<ListingsComponent>;
  let component: ListingsComponent;
  let updateListing: ReturnType<typeof vi.fn>;
  let uploadPhoto: ReturnType<typeof vi.fn>;
  let toast: { success: any; error: any; info: any };

  const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
  const photos = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.example/${i}.jpg`);
  const openEdit = (over: Record<string, any> = {}) => {
    const listing = { id: 'l1', book_title: 'Calculus', price: 300, condition: 'new', status: 'active', ...over };
    component.myListings = [listing];
    component.onListingAction({ type: 'edit', id: 'l1' });
  };
  const render = () => {
    (component as any).cdr.markForCheck();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ListingsComponent, HttpClientTestingModule, RouterTestingModule],
    });
    fixture = TestBed.createComponent(ListingsComponent);
    component = fixture.componentInstance;

    updateListing = vi.fn().mockReturnValue(of({}));
    uploadPhoto = vi.fn((f: File) => of({ url: `https://cdn.example/${f.name}` }));
    toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    (component as any).listingService = { updateListing, uploadPhoto };
    (component as any).accountService = { getMyProfile: vi.fn().mockReturnValue(of({ myListings: [] })), clearProfileCache: vi.fn() };
    (component as any).metadataService = { getMetadata: vi.fn().mockReturnValue(of({})) };
    (component as any).toast = toast;
    (component as any).syncUrl = vi.fn();
  });

  it('shares the cap with the sell form', () => {
    expect(component.maxPhotos).toBe(SELL_MAX_PHOTOS);
  });

  it('opens with every photo the listing has, not just the first', () => {
    openEdit({ photos: photos(3), photo_url: photos(1)[0] });
    expect(component.editForm.photos).toEqual(photos(3));
    expect(render().querySelectorAll('.photo-grid .photo-preview img').length).toBe(3);
  });

  it('removes only the photo whose delete button was pressed', () => {
    openEdit({ photos: photos(3) });
    const buttons = render().querySelectorAll<HTMLButtonElement>('.photo-preview .delete-photo-btn');
    buttons[1].click();
    expect(component.editForm.photos).toEqual([photos(3)[0], photos(3)[2]]);
  });

  it('saves the whole photo list back, so an edit keeps them all', () => {
    openEdit({ photos: photos(4) });
    component.editForm.price = 250;
    component.submitEdit();
    expect(updateListing.mock.calls[0][1].photos).toEqual(photos(4));
  });

  it('adds uploaded photos after the existing ones, in the order picked', async () => {
    openEdit({ photos: photos(1) });
    await component.onFileSelected({ target: { files: [file('a.jpg'), file('b.jpg')], value: 'x' } });
    expect(component.editForm.photos).toEqual([photos(1)[0], 'https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
    expect(component.photoError).toBe('');
    expect(component.isUploadingPhoto).toBe(false);
  });

  it('uploads only as many as fit under the cap and says the rest were left out', async () => {
    openEdit({ photos: photos(SELL_MAX_PHOTOS - 1) });
    await component.onFileSelected({ target: { files: [file('a.jpg'), file('b.jpg')], value: 'x' } });
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
    expect(component.editForm.photos.length).toBe(SELL_MAX_PHOTOS);
    expect(component.photoError).toContain(String(SELL_MAX_PHOTOS));
  });

  it('counts photos still uploading against the cap', async () => {
    const pending = new Subject<{ url: string }>();
    uploadPhoto.mockReturnValueOnce(pending);
    openEdit({ photos: photos(SELL_MAX_PHOTOS - 1) });

    const first = component.onFileSelected({ target: { files: [file('a.jpg')], value: 'x' } });
    expect(component.isUploadingPhoto).toBe(true);
    // A second pick while the first is on its way has no room left.
    await component.onFileSelected({ target: { files: [file('b.jpg')], value: 'x' } });
    expect(uploadPhoto).toHaveBeenCalledTimes(1);

    pending.next({ url: 'https://cdn.example/a.jpg' });
    pending.complete();
    await first;
    expect(component.editForm.photos.length).toBe(SELL_MAX_PHOTOS);
    expect(component.isUploadingPhoto).toBe(false);
  });

  it('keeps the rest of a batch when one upload fails', async () => {
    uploadPhoto.mockImplementation((f: File) =>
      f.name === 'bad.jpg' ? throwError(() => new Error('boom')) : of({ url: `https://cdn.example/${f.name}` }));
    openEdit({ photos: [] });
    await component.onFileSelected({ target: { files: [file('bad.jpg'), file('good.jpg')], value: 'x' } });
    expect(component.editForm.photos).toEqual(['https://cdn.example/good.jpg']);
    expect(toast.error).toHaveBeenCalled();
  });

  it('hides the add button once the listing is at the cap', () => {
    openEdit({ photos: photos(SELL_MAX_PHOTOS - 1) });
    expect(render().querySelector('.photo-upload input[type="file"]')).not.toBeNull();

    component.editForm.photos = photos(SELL_MAX_PHOTOS);
    expect(render().querySelector('.photo-upload input[type="file"]')).toBeNull();
    expect(render().querySelector('.photo-count')?.textContent?.trim()).toBe(`${SELL_MAX_PHOTOS}/${SELL_MAX_PHOTOS}`);
  });

  describe('mobile gestures and pagination', () => {
    let getMyProfile: ReturnType<typeof vi.fn>;
    let clearProfileCache: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getMyProfile = vi.fn().mockReturnValue(of({
        myListings: { count: 30, results: Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, price: 100 })) },
        myListingCounts: { all: 30 },
      }));
      clearProfileCache = vi.fn();
      (component as any).accountService = { getMyProfile, clearProfileCache };
    });

    it('re-fetches page 1 and clears cache on onRefresh', () => {
      component.isPhone = true;
      component.onRefresh();

      expect(clearProfileCache).toHaveBeenCalled();
      expect(getMyProfile).toHaveBeenCalledWith(1, '', { status: '', sort: undefined });
      expect(component.refreshing).toBe(false);
    });

    it('appends listings on onLoadMore on phones', () => {
      component.isPhone = true;
      component.loading = false;
      component.currentPage = 1;
      component.myListings = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, price: 100 }));
      component.totalListings = 30;

      expect(component.hasMoreListings).toBe(true);

      const page2 = Array.from({ length: 10 }, (_, i) => ({ id: `l${20 + i}`, price: 100 }));
      getMyProfile.mockReturnValue(of({
        myListings: { count: 30, results: page2 },
      }));

      component.onLoadMore();

      expect(getMyProfile).toHaveBeenCalledWith(2, '', { status: '', sort: undefined });
      expect(component.myListings.length).toBe(30);
      expect(component.hasMoreListings).toBe(false);
    });

    it('starts at page 1 on phone, ignoring ?page=3', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [ListingsComponent, HttpClientTestingModule, RouterTestingModule],
        providers: [
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: {
                queryParamMap: convertToParamMap({ page: '3' }),
              },
            },
          },
        ],
      });
      const fixture = TestBed.createComponent(ListingsComponent);
      const comp = fixture.componentInstance;
      comp.isPhone = true;
      comp.loadMyListings = vi.fn();
      comp.ngOnInit();

      expect(comp.currentPage).toBe(1);
    });

    it('opens page 3 on desktop when carrying ?page=3', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [ListingsComponent, HttpClientTestingModule, RouterTestingModule],
        providers: [
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: {
                queryParamMap: convertToParamMap({ page: '3' }),
              },
            },
          },
        ],
      });
      const fixture = TestBed.createComponent(ListingsComponent);
      const comp = fixture.componentInstance;
      comp.isPhone = false;
      comp.loadMyListings = vi.fn();
      comp.ngOnInit();

      expect(comp.currentPage).toBe(3);
    });
  });
});
