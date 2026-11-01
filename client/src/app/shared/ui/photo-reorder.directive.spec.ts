import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoReorderEvent, UiPhotoReorderDirective, movePhoto } from './photo-reorder.directive';

describe('movePhoto', () => {
  const photos = ['a', 'b', 'c', 'd'];

  it('moves a later photo to the front, making it the cover', () => {
    expect(movePhoto(photos, { from: 2, to: 0 })).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves the cover back, shifting the others up', () => {
    expect(movePhoto(photos, { from: 0, to: 3 })).toEqual(['b', 'c', 'd', 'a']);
  });

  it('returns a new array and leaves the original alone', () => {
    const moved = movePhoto(photos, { from: 1, to: 2 });
    expect(moved).not.toBe(photos);
    expect(photos).toEqual(['a', 'b', 'c', 'd']);
  });
});

@Component({
  standalone: true,
  imports: [UiPhotoReorderDirective],
  template: `
    <div uiPhotoReorder (photoReorder)="events.push($event)">
      @for (p of photos; track p) {
        <div data-reorder-item><img alt=""><button type="button">x</button></div>
      }
    </div>`,
})
class HostComponent {
  photos = ['a', 'b', 'c'];
  events: PhotoReorderEvent[] = [];
}

describe('UiPhotoReorderDirective', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const items = Array.from(fixture.nativeElement.querySelectorAll('[data-reorder-item]')) as HTMLElement[];
    // Three 100px boxes in a row, 10px apart.
    items.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: i * 110, right: i * 110 + 100, top: 0, bottom: 100 } as DOMRect);
    });
    return { fixture, items };
  }

  function pointer(type: string, target: EventTarget, x: number, y: number, pointerType = 'mouse') {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.assign(e, { pointerId: 1, pointerType });
    target.dispatchEvent(e);
  }

  it('drags with a mouse and reports the move on release', () => {
    const { fixture, items } = setup();
    pointer('pointerdown', items[0], 50, 50);
    pointer('pointermove', document, 160, 50);
    expect(items[1].classList).toContain('reorder-target');
    pointer('pointermove', document, 270, 50);
    pointer('pointerup', document, 270, 50);
    expect(fixture.componentInstance.events).toEqual([{ from: 0, to: 2 }]);
    expect(items.some(el => el.classList.contains('reorder-target') || el.style.transform)).toBe(false);
  });

  it('reports nothing when dropped back on its own slot', () => {
    const { fixture, items } = setup();
    pointer('pointerdown', items[1], 150, 50);
    pointer('pointermove', document, 50, 50);
    pointer('pointermove', document, 160, 50);
    pointer('pointerup', document, 160, 50);
    expect(fixture.componentInstance.events).toEqual([]);
  });

  it('needs a long press on touch; moving early is a scroll', () => {
    vi.useFakeTimers();
    const { fixture, items } = setup();
    pointer('pointerdown', items[2], 250, 50, 'touch');
    pointer('pointermove', document, 150, 50, 'touch');
    pointer('pointerup', document, 50, 50, 'touch');
    expect(fixture.componentInstance.events).toEqual([]);

    pointer('pointerdown', items[2], 250, 50, 'touch');
    vi.advanceTimersByTime(400);
    pointer('pointermove', document, 50, 50, 'touch');
    pointer('pointerup', document, 50, 50, 'touch');
    expect(fixture.componentInstance.events).toEqual([{ from: 2, to: 0 }]);
  });

  it('never starts from the remove button', () => {
    const { fixture, items } = setup();
    pointer('pointerdown', items[0].querySelector('button')!, 90, 10);
    pointer('pointermove', document, 270, 50);
    pointer('pointerup', document, 270, 50);
    expect(fixture.componentInstance.events).toEqual([]);
  });
});
