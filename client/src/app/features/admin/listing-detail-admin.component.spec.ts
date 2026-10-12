import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { AdminListingDetailComponent } from './listing-detail-admin.component';

describe('AdminListingDetailComponent.deleteListing', () => {
  let component: AdminListingDetailComponent;
  let deleteListing: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AdminListingDetailComponent, HttpClientTestingModule, RouterTestingModule],
    });
    component = TestBed.createComponent(AdminListingDetailComponent).componentInstance;
    deleteListing = vi.fn();
    navigate = vi.fn();
    (component as any).adminService = { deleteListing };
    (component as any).confirms = { askDanger: vi.fn().mockResolvedValue(true) };
    (component as any).router = { navigate };
    (component as any).i18n = {
      t: (k: string) => k,
      tOrNull: (k: unknown) => (typeof k === 'string' ? k : null),
    };
    component.listing = { id: 'l1' } as any;
  });

  it('asks for a reason when the server reports open orders', async () => {
    deleteListing.mockReturnValue(
      throwError(() => ({
        error: { error: { code: 'admin.errInvalidReason' }, open_orders: 2 },
      })),
    );
    await component.deleteListing();

    expect(deleteListing).toHaveBeenCalledWith('l1');
    expect(component.openOrdersToCancel).toBe(2);
    expect(component.errorMsg).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('goes back to the listings list once the listing is deleted', async () => {
    deleteListing.mockReturnValue(of(undefined));
    await component.deleteListing();
    // An absolute path: '../..' from the 'listings/:id' route landed on the
    // admin root with this page still rendered.
    const [commands] = navigate.mock.calls[0];
    expect(commands.slice(-2)).toEqual(['admin', 'listings']);
    expect(component.openOrdersToCancel).toBe(0);
  });
});
