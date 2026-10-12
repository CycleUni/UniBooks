import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { UiFocusTrapDirective } from './focus-trap.directive';

@Component({
  template: `
    <button id="out">Out</button>
    <div id="trap" uiFocusTrap="test-title" (escape)="onEscape()">
      <h1 id="test-title">Title</h1>
      <!-- Sorts before btn1 and matches the focusable selector, but is not
           rendered — the shape the meetup dialog's mobile-only date input has
           on a desktop. It must not be treated as focusable. -->
      <input id="hidden-input"  style="display: none;" />
      <button id="btn1">Btn 1</button>
      <button id="btn2">Btn 2</button>
      <button id="disabled-btn" disabled>Disabled</button>
    </div>
  `,
  standalone: true,
  imports: [UiFocusTrapDirective]
})
class TestHostComponent {
  escaped = false;
  onEscape() { this.escaped = true; }
}

describe('UiFocusTrapDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let component: TestHostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent]
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(TestHostComponent);
    component = fixture.componentInstance;
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  });

  afterEach(() => {
    document.body.removeChild(fixture.nativeElement);
  });

  it('should initialize and add ARIA attributes', () => {
    const trap = fixture.debugElement.query(By.directive(UiFocusTrapDirective)).nativeElement;
    expect(trap.getAttribute('role')).toBe('dialog');
    expect(trap.getAttribute('aria-modal')).toBe('true');
    expect(trap.getAttribute('aria-labelledby')).toBe('test-title');
  });

  it('should focus the first element initially', async () => {
    await new Promise(r => setTimeout(r, 10));
    const btn1 = fixture.debugElement.query(By.css('#btn1')).nativeElement;
    expect(document.activeElement).toBe(btn1);
  });

  it('should trap focus on tab', async () => {
    await new Promise(r => setTimeout(r, 10));
    const trap = fixture.debugElement.query(By.directive(UiFocusTrapDirective));
    const btn2 = fixture.debugElement.query(By.css('#btn2')).nativeElement;
    btn2.focus();
    expect(document.activeElement).toBe(btn2);
    
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    trap.nativeElement.dispatchEvent(event);
    
    const btn1 = fixture.debugElement.query(By.css('#btn1')).nativeElement;
    expect(document.activeElement).toBe(btn1);
  });

  it('skips elements that match the selector but are not rendered', async () => {
    await new Promise(r => setTimeout(r, 10));
    // btn1, not the display:none input that precedes it: focus() on an
    // unrendered element is a no-op, which would leave focus on <body>.
    const btn1 = fixture.debugElement.query(By.css('#btn1')).nativeElement;
    expect(document.activeElement).toBe(btn1);

    // Shift+Tab off the first element wraps to the last *focusable* one, so a
    // trailing disabled button must not be treated as the boundary.
    const trap = fixture.debugElement.query(By.directive(UiFocusTrapDirective));
    trap.nativeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));

    const btn2 = fixture.debugElement.query(By.css('#btn2')).nativeElement;
    expect(document.activeElement).toBe(btn2);
  });

  it('should emit escape event on Esc key', () => {
    const trap = fixture.debugElement.query(By.directive(UiFocusTrapDirective));
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    trap.nativeElement.dispatchEvent(event);
    expect(component.escaped).toBe(true);
  });
});
