import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { UiGoogleButtonFrame } from './google-button-frame.component';

describe('UiGoogleButtonFrame', () => {
  let fixture: ComponentFixture<UiGoogleButtonFrame>;
  let el: HTMLElement;
  const q = (s: string) => el.querySelector(s) as HTMLElement | null;
  const set = (inputs: Partial<UiGoogleButtonFrame>) => {
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [UiGoogleButtonFrame] }).compileComponents();
    fixture = TestBed.createComponent(UiGoogleButtonFrame);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('gives Google an element to draw into, by id when asked', () => {
    set({ buttonId: 'google-btn' });
    expect(fixture.componentInstance.host.nativeElement).toBe(q('#google-btn'));
  });

  it('shows the placeholder until the button is drawn', () => {
    expect(q('.google-placeholder')).toBeTruthy();
    set({ ready: true });
    expect(q('.google-placeholder')).toBeNull();
  });

  it('replaces the placeholder with the note when Google cannot load', () => {
    set({ failed: true, failedLabel: 'unavailable' });
    expect(q('.google-placeholder')).toBeNull();
    expect(q('.google-failed')?.textContent).toContain('unavailable');
  });

  it('veils the button with a spinner while busy, blocking only when asked', () => {
    set({ ready: true });
    expect(q('.google-veil')).toBeNull();
    set({ busy: true });
    expect(q('.google-veil .spinner')).toBeTruthy();
    expect(q('.google-veil')!.classList).not.toContain('blocking');
    set({ blocking: true, busyLabel: 'checking' });
    expect(q('.google-veil')!.classList).toContain('blocking');
    expect(q('.google-veil')!.textContent).toContain('checking');
    expect(q('.google-wrap')!.getAttribute('aria-busy')).toBe('true');
  });

  it('aligns to the start inside a left-aligned form', () => {
    set({ align: 'start' });
    expect(q('.google-wrap')!.classList).toContain('start');
  });
});
