import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UiVerifiedBadge } from './verified-badge.component';
import { I18nService } from '../../core/i18n.service';
import { describe, expect, it, beforeEach } from 'vitest';

describe('UiVerifiedBadge', () => {
  let component: UiVerifiedBadge;
  let fixture: ComponentFixture<UiVerifiedBadge>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UiVerifiedBadge],
      providers: [
        {
          provide: I18nService,
          useValue: {
            t: (key: string) => (key === 'acct.verifiedBadge' ? '已驗證學校信箱' : key),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UiVerifiedBadge);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the accessible label', () => {
    const el = fixture.nativeElement as HTMLElement;
    const badge = el.querySelector('.verified-badge');
    expect(badge).toBeTruthy();
    expect(badge?.getAttribute('aria-label')).toBe('已驗證學校信箱');
    expect(badge?.getAttribute('title')).toBe('已驗證學校信箱');
    expect(badge?.getAttribute('role')).toBe('img');
  });

  it('supports custom size', () => {
    component.size = 20;
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelector('svg');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
  });
});
