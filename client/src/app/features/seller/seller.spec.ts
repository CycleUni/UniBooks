import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { SellerPageComponent } from './seller';
import { AccountService } from '../../core/services/account.service';
import { ListingService } from '../../core/services/listing.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { SeoService } from '../../core/services/seo.service';
import { en } from '../../core/i18n/en';

describe('SellerPageComponent', () => {
  let fixture: ComponentFixture<SellerPageComponent>;
  let component: SellerPageComponent;
  let getPublicUserProfile: ReturnType<typeof vi.fn>;
  let getListings: ReturnType<typeof vi.fn>;

  const i18n = {
    lang: () => 'en',
    t: (key: string, params?: Record<string, string | number>) => {
      let text = en[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  };

  beforeEach(async () => {
    getPublicUserProfile = vi.fn().mockReturnValue(of({
      id: 'seller1',
      display_name: 'Alice',
      school_name: 'NTU',
      created_at: '2025-01-01',
    }));
    getListings = vi.fn().mockReturnValue(of({
      count: 2,
      results: [{ id: 'l1', price: 100 }],
    }));

    await TestBed.configureTestingModule({
      imports: [SellerPageComponent, HttpClientTestingModule],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'seller1' })) } },
        { provide: AccountService, useValue: { getPublicUserProfile } },
        { provide: ListingService, useValue: { getListings } },
        { provide: I18nService, useValue: i18n },
        { provide: RegionService, useValue: { region: () => 'tw', currency: () => ({ code: 'TWD', symbol: 'NT$', decimal_places: 0 }) } },
        { provide: SeoService, useValue: { setPage: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SellerPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads seller and listings initially', () => {
    expect(getPublicUserProfile).toHaveBeenCalledWith('seller1');
    expect(getListings).toHaveBeenCalledWith(undefined, 'seller1', 1);
    expect(component.seller?.display_name).toBe('Alice');
    expect(component.listings.length).toBe(1);
  });

  it('appends listings on onLoadMore on phones', () => {
    component.isPhone = true;
    fixture.detectChanges();

    expect(component.hasMoreListings).toBe(true);

    getListings.mockReturnValue(of({
      count: 2,
      results: [{ id: 'l2', price: 200 }],
    }));

    component.onLoadMore();

    expect(getListings).toHaveBeenCalledWith(undefined, 'seller1', 2);
    expect(component.listings.length).toBe(2);
    expect(component.hasMoreListings).toBe(false);
  });

  it('starts at page 1 on phone, ignoring ?page=3', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SellerPageComponent, HttpClientTestingModule],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'seller1' })),
            snapshot: { queryParamMap: convertToParamMap({ page: '3' }) },
          },
        },
        { provide: AccountService, useValue: { getPublicUserProfile } },
        { provide: ListingService, useValue: { getListings } },
        { provide: I18nService, useValue: i18n },
        { provide: RegionService, useValue: { region: () => 'tw', currency: () => ({ code: 'TWD', symbol: 'NT$', decimal_places: 0 }) } },
        { provide: SeoService, useValue: { setPage: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SellerPageComponent);
    component = fixture.componentInstance;
    component.isPhone = true;
    fixture.detectChanges();

    expect(component.currentPage).toBe(1);
    expect(getListings).toHaveBeenCalledWith(undefined, 'seller1', 1);
  });

  it('opens page 3 on desktop when carrying ?page=3', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SellerPageComponent, HttpClientTestingModule],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'seller1' })),
            snapshot: { queryParamMap: convertToParamMap({ page: '3' }) },
          },
        },
        { provide: AccountService, useValue: { getPublicUserProfile } },
        { provide: ListingService, useValue: { getListings } },
        { provide: I18nService, useValue: i18n },
        { provide: RegionService, useValue: { region: () => 'tw', currency: () => ({ code: 'TWD', symbol: 'NT$', decimal_places: 0 }) } },
        { provide: SeoService, useValue: { setPage: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SellerPageComponent);
    component = fixture.componentInstance;
    component.isPhone = false;
    fixture.detectChanges();

    expect(component.currentPage).toBe(3);
    expect(getListings).toHaveBeenCalledWith(undefined, 'seller1', 3);
  });

  // Only a 404 means "no such seller"; anything else may work on retry.
  it('says the page failed to load, not that the seller is gone, on a non-404', () => {
    component.seller = null;
    getPublicUserProfile.mockReturnValueOnce(throwError(() => ({ status: 503 })));
    component.loadSeller('seller1');
    expect(component.loadFailed).toBe(true);
    expect(component.error).toBe(false);

    component.loadSeller('seller1');
    expect(component.loadFailed).toBe(false);
    expect(component.seller).not.toBeNull();
  });

  it('says the seller is gone on a 404', () => {
    component.seller = null;
    getPublicUserProfile.mockReturnValueOnce(throwError(() => ({ status: 404 })));
    component.loadSeller('seller1');
    expect(component.error).toBe(true);
    expect(component.loadFailed).toBe(false);
  });

  it('shows a failed listings load as failed, not as "no listings"', () => {
    getListings.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    component.loadListings('seller1');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(component.listingsFailed).toBe(true);
    expect(el.querySelector('ui-error-state')).not.toBeNull();
    expect(el.querySelector('.empty-state')).toBeNull();
  });
});
