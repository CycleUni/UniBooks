import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { UiListingCard } from './listing-card.component';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

describe('UiListingCard', () => {
  let fixture: ComponentFixture<UiListingCard>;
  let component: UiListingCard;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiListingCard],
      providers: [
        {
          provide: RegionService,
          useValue: {
            regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }],
            currency: () => ({ code: 'TWD', decimal_places: 0 }),
            region: () => 'tw',
          },
        },
        provideRouter([]),
        { provide: I18nService, useValue: { lang: () => 'en', t: (key: string) => key } },
      ],
    });
    fixture = TestBed.createComponent(UiListingCard);
    component = fixture.componentInstance;
    component.item = {
      id: 'l1',
      price: 100,
      currency: 'TWD',
      condition: 'new',
      seller: 7,
      seller_name: 'Seller',
    };
  });

  it('offers a buyer contact and meetup', () => {
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('book.contactSeller');
    expect(text).toContain('checkout.arrangeMeetup');
    expect(text).not.toContain('listing.manageOwn');
  });

  it('offers the seller a way to manage their own copy instead of messaging themselves', () => {
    component.isOwn = true;
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).not.toContain('book.contactSeller');
    expect(text).not.toContain('checkout.arrangeMeetup');
    const manage = fixture.debugElement.query(By.css('.own-listing a'));
    expect(manage.nativeElement.textContent).toContain('listing.manageOwn');
    expect(manage.nativeElement.getAttribute('href')).toContain('/account/listings');
  });

  it("links the seller's name to their profile, outside the card's own link", () => {
    component.link = ['/listing', 'l1'];
    fixture.detectChanges();
    const sellerLink = fixture.debugElement.query(By.css('a.seller-link'));
    expect(sellerLink.nativeElement.textContent.trim()).toBe('Seller');
    expect(sellerLink.nativeElement.getAttribute('href')).toContain('/seller/7');
    // A link nested in the body link is invalid HTML and not keyboard-reachable.
    expect(sellerLink.nativeElement.closest('.listing-body')).toBeNull();
  });

  it("shows the seller's rating, reviews and completed sales", () => {
    component.item = {
      ...component.item,
      seller_average_rating: 4.5,
      seller_review_count: 12,
      seller_completed_sales: 1,
    };
    fixture.detectChanges();
    const text = fixture.debugElement.query(By.css('.seller-info')).nativeElement.textContent;
    expect(text).toContain('★ 4.5');
    expect(text).toContain('seller.reviewCount');
    expect(text).toContain('seller.salesCountOne');
    expect(text).not.toContain('seller.newSeller');
  });

  it('calls a seller nobody has reviewed a new seller rather than rating them zero', () => {
    component.item = {
      ...component.item,
      seller_average_rating: null,
      seller_review_count: 0,
      seller_completed_sales: 0,
    };
    fixture.detectChanges();
    const text = fixture.debugElement.query(By.css('.seller-info')).nativeElement.textContent;
    expect(text).toContain('seller.newSeller');
    expect(text).not.toContain('★');
    expect(text).not.toContain('seller.salesCount');
  });

  it('does not call a seller with completed sales new just because nobody has reviewed them', () => {
    component.item = {
      ...component.item,
      seller_average_rating: null,
      seller_review_count: 0,
      seller_completed_sales: 24,
    };
    fixture.detectChanges();
    const text = fixture.debugElement.query(By.css('.seller-info')).nativeElement.textContent;
    expect(text).toContain('seller.salesCount');
    expect(text).toContain('seller.noReviews');
    expect(text).not.toContain('seller.newSeller');
    expect(text).not.toContain('★');
  });
});
