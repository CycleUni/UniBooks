import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CourseService } from './course.service';
import type { CourseDto } from '../../../../../server/src/api-types';

describe('CourseService', () => {
  let service: CourseService;
  let http: HttpTestingController;
  const row: CourseDto = { key: 'calc', name: 'Calculus', listingCount: 1, bookCount: 1, wantCount: 0, wanted: false };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(CourseService);
    http = TestBed.inject(HttpTestingController);
  });

  it('keeps the list it fetched, to show again at once when the visitor comes back', () => {
    expect(service.lastList('NTU')).toBeNull();
    service.list('NTU').subscribe();
    http.expectOne((r) => r.url === '/courses' && r.params.get('school') === 'NTU').flush([row]);
    expect(service.lastList('NTU')).toEqual([row]);
  });

  it('keeps nothing for a different school or search than the one fetched', () => {
    service.list('NTU', ' calc ').subscribe();
    http.expectOne((r) => r.url === '/courses').flush([row]);
    expect(service.lastList('NTU', 'calc')).toEqual([row]);
    expect(service.lastList('NTU', 'stats')).toBeNull();
    expect(service.lastList('NCKU', 'calc')).toBeNull();
  });
});
