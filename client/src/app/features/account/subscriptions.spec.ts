import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { SubscriptionsComponent } from './subscriptions';
import { AccountService } from '../../core/services/account.service';
import { RegionLinkService } from '../../core/region-link.service';

describe('SubscriptionsComponent', () => {
  let component: SubscriptionsComponent;
  const navigate = vi.fn();

  beforeEach(() => {
    navigate.mockReset();
    TestBed.configureTestingModule({
      imports: [SubscriptionsComponent],
      providers: [
        { provide: AccountService, useValue: {} },
        { provide: Router, useValue: { navigate } },
        { provide: RegionLinkService, useValue: { path: (p: unknown[]) => ['/tw', ...p.map(s => String(s).slice(1))] } },
      ],
    });
    component = TestBed.createComponent(SubscriptionsComponent).componentInstance;
  });

  it('View now opens the book page by ISBN', () => {
    component.viewBook({ isbn: '9780131103627', book: 'b1' });
    expect(navigate).toHaveBeenCalledWith(['/tw', 'book'], { queryParams: { isbn: '9780131103627' } });
  });

  it('View now opens a book without an ISBN by its id', () => {
    component.viewBook({ isbn: '', book: 'b1' });
    expect(navigate).toHaveBeenCalledWith(['/tw', 'book'], { queryParams: { id: 'b1' } });
  });
});
