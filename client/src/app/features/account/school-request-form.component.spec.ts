import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { SchoolRequestFormComponent } from './school-request-form.component';
import { AccountService } from '../../core/services/account.service';
import { I18nService } from '../../core/i18n.service';

// Keys come back as themselves, so assertions read as "which message", not
// "which wording" — and a key the backend sent that is not in this set comes
// back null, the way the real dictionary treats an unknown code.
const KNOWN = new Set(['acct.errSchoolRequestWebsite', 'acct.errSchoolRequestName']);
const i18nMock = {
  t: (key: string) => key,
  tOrNull: (key: unknown) => (typeof key === 'string' && KNOWN.has(key) ? key : null),
  lang: signal('en'),
};

describe('SchoolRequestFormComponent', () => {
  let fixture: ComponentFixture<SchoolRequestFormComponent>;
  let component: SchoolRequestFormComponent;
  let accountService: { createSchoolRequest: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    accountService = { createSchoolRequest: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [SchoolRequestFormComponent],
      providers: [
        { provide: AccountService, useValue: accountService },
        { provide: I18nService, useValue: i18nMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SchoolRequestFormComponent);
    component = fixture.componentInstance;
    component.eduEmail = ' student@unknown.edu.tw ';
    fixture.detectChanges();
  });

  const el = () => fixture.nativeElement as HTMLElement;

  function fillAndSubmit(name: string, website: string) {
    component.schoolName = name;
    component.schoolWebsite = website;
    component.submit();
    fixture.detectChanges();
  }

  it('starts as a single link and opens the form on click', () => {
    expect(el().querySelector('form')).toBeNull();
    const toggle = el().querySelector('button.link-btn') as HTMLButtonElement;
    expect(toggle.textContent).toContain('acct.schoolRequestToggle');

    toggle.click();
    fixture.detectChanges();

    const form = el().querySelector('form')!;
    expect(form).not.toBeNull();
    const website = form.querySelectorAll('input')[1] as HTMLInputElement;
    expect(website.type).toBe('url');
  });

  it('checks the fields before spending a request', () => {
    component.toggle();
    fillAndSubmit('Example University', 'example.edu.tw');
    expect(component.websiteError).toBe('acct.errSchoolRequestWebsite');
    expect(component.nameError).toBe('');

    fillAndSubmit(' X ', 'https://example.edu.tw');
    expect(component.nameError).toBe('acct.errSchoolRequestName');

    expect(accountService.createSchoolRequest).not.toHaveBeenCalled();
  });

  it('sends the typed address along and collapses to a thank-you on success', () => {
    accountService.createSchoolRequest.mockReturnValue(of({ id: 1, status: 'pending' }));
    component.toggle();
    fillAndSubmit('  Example University ', ' https://www.example.edu.tw ');

    expect(accountService.createSchoolRequest).toHaveBeenCalledWith({
      school_name: 'Example University',
      school_website: 'https://www.example.edu.tw',
      edu_email: 'student@unknown.edu.tw',
    });
    expect(component.submitted).toBe(true);
    expect(el().querySelector('form')).toBeNull();
    expect(el().querySelector('button.link-btn')).toBeNull();
    expect(el().textContent).toContain('acct.schoolRequestSuccess');
  });

  it('omits edu_email when nothing was typed', () => {
    accountService.createSchoolRequest.mockReturnValue(of({ id: 1 }));
    component.eduEmail = '';
    component.toggle();
    fillAndSubmit('Example University', 'https://example.edu.tw');
    expect(accountService.createSchoolRequest.mock.calls[0][0]).not.toHaveProperty('edu_email');
  });

  it("shows the backend's field error and keeps the form open", () => {
    accountService.createSchoolRequest.mockReturnValue(throwError(() => new HttpErrorResponse({
      status: 400,
      error: { school_website: ['acct.errSchoolRequestWebsite'] },
    })));
    component.toggle();
    fillAndSubmit('Example University', 'https://example.edu.tw');

    expect(component.submitted).toBe(false);
    expect(component.open).toBe(true);
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('acct.errSchoolRequestWebsite');
  });

  it('gives the throttle its own message', () => {
    accountService.createSchoolRequest.mockReturnValue(throwError(() => new HttpErrorResponse({
      status: 429,
      error: { detail: 'Request was throttled.' },
    })));
    component.toggle();
    fillAndSubmit('Example University', 'https://example.edu.tw');
    expect(component.errorMessage).toBe('acct.schoolRequestThrottled');
  });

  it('falls back to a generic failure for anything unreadable', () => {
    accountService.createSchoolRequest.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
    component.toggle();
    fillAndSubmit('Example University', 'https://example.edu.tw');
    expect(component.errorMessage).toBe('acct.schoolRequestFailed');
  });
});
