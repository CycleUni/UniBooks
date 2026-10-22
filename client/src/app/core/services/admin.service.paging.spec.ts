import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AdminService } from './admin.service';

describe('AdminService paging', () => {
  it('asks for the page shown, for regions and currencies too', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const admin = TestBed.inject(AdminService);
    const http = TestBed.inject(HttpTestingController);

    admin.getRegions(2).subscribe();
    admin.getCurrencies(3).subscribe();

    expect(http.expectOne((r) => r.url === '/admin/regions').request.params.get('page')).toBe('2');
    expect(http.expectOne((r) => r.url === '/admin/currencies').request.params.get('page')).toBe('3');
    http.verify();
  });
});
