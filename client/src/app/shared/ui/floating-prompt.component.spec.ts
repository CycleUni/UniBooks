import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiFloatingPrompt } from './floating-prompt.component';

@Component({
  standalone: true,
  imports: [UiFloatingPrompt],
  template: `
    @if (showPush()) {
      <ui-floating-prompt
        title="Push?"
        acceptLabel="On"
        dismissLabel="Later"
        testId="push"
        [priority]="0"
        (accept)="accepted = 'push'"
      ></ui-floating-prompt>
    }
    @if (showLang()) {
      <ui-floating-prompt
        title="Language?"
        acceptLabel="Switch"
        dismissLabel="Keep"
        testId="lang"
        [priority]="1"
      ></ui-floating-prompt>
    }
  `,
})
class TwoPrompts {
  showPush = signal(true);
  showLang = signal(true);
  accepted = '';
}

describe('UiFloatingPrompt', () => {
  function render() {
    const fixture = TestBed.createComponent(TwoPrompts);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const shown = () =>
      Array.from(el.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid'));
    return { fixture, el, shown };
  }

  it('shows one prompt at a time: the higher priority first', () => {
    const { shown } = render();
    expect(shown()).toEqual(['lang']);
  });

  it('shows the next prompt once the first is answered', () => {
    const { fixture, shown } = render();
    fixture.componentInstance.showLang.set(false);
    fixture.detectChanges();
    expect(shown()).toEqual(['push']);
  });

  it('draws the question and both answers, and reports the one chosen', () => {
    const { fixture, el } = render();
    fixture.componentInstance.showLang.set(false);
    fixture.detectChanges();
    const card = el.querySelector('[data-testid="push"]')!;
    expect(card.getAttribute('role')).toBe('region');
    expect(card.textContent).toContain('Push?');
    const buttons = Array.from(card.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['On', 'Later']);
    buttons[0].click();
    expect(fixture.componentInstance.accepted).toBe('push');
  });
});
