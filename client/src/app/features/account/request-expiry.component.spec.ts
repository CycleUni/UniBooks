import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { RequestExpiryComponent } from './request-expiry.component';

describe('RequestExpiryComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [RequestExpiryComponent] });
  });

  function render(expiresAt: string | null) {
    const fixture = TestBed.createComponent(RequestExpiryComponent);
    fixture.componentRef.setInput('expiresAt', expiresAt);
    fixture.detectChanges();
    return fixture;
  }

  it('says when a request ends', () => {
    const text = render('2027-05-25T04:00:00.000Z').nativeElement.textContent as string;
    expect(text).toContain('2027/05/25');
  });

  it('says nothing about a date for a request without an end', () => {
    const text = render(null).nativeElement.textContent as string;
    expect(text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
  });

  it('offers half a year or no end, and offers exactly those two', () => {
    const fixture = render('2027-05-25T04:00:00.000Z');
    expect(fixture.componentInstance.options.map((o) => o.value)).toEqual(['half_year', 'unlimited']);
  });
});
