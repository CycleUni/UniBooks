import { TestBed } from '@angular/core/testing';
import { UiBottomSheet } from './bottom-sheet.component';

describe('UiBottomSheet', () => {
  const create = () => {
    const fixture = TestBed.createComponent(UiBottomSheet);
    fixture.componentInstance.title = 'Choose school';
    fixture.detectChanges();
    return fixture;
  };

  it('moves itself to <body> and locks page scroll while open', () => {
    const fixture = create();
    expect(fixture.nativeElement.parentElement).toBe(document.body);
    expect(document.documentElement.style.overflow).toBe('hidden');
    fixture.destroy();
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('closes on a backdrop tap', () => {
    const fixture = create();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.nativeElement.querySelector('.backdrop').click();
    expect(closed).toBe(1);
    fixture.destroy();
  });

  it('closes when dragged down past the threshold, springs back otherwise', () => {
    const fixture = create();
    const sheet = fixture.componentInstance;
    let closed = 0;
    sheet.closed.subscribe(() => closed++);
    const touch = (y: number) => ({ touches: [{ clientY: y }] }) as unknown as TouchEvent;

    sheet.dragStart(touch(100));
    sheet.dragMove(touch(150));
    sheet.dragEnd();
    expect(closed).toBe(0);
    expect(sheet.dragY).toBe(0);

    sheet.dragStart(touch(100));
    sheet.dragMove(touch(220));
    sheet.dragEnd();
    expect(closed).toBe(1);
    fixture.destroy();
  });
});
