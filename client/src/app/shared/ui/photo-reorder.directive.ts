import {
  Directive,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';

/** How long a finger has to rest on a photo before it lifts for dragging. */
const LONG_PRESS_MS = 350;
/** Movement that turns a press into a scroll (touch) or a drag (mouse). */
const MOVE_SLOP_PX = 8;

export interface PhotoReorderEvent {
  from: number;
  to: number;
}

/** A copy of `list` with the item at `from` moved to `to`; the first photo is the listing's cover. */
export function movePhoto<T>(list: readonly T[], { from, to }: PhotoReorderEvent): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * Lets the photos inside the host be reordered by dragging: a long press on
 * touch (so a swipe over the grid still scrolls the page), or simply pressing
 * and moving with a mouse. Each draggable photo carries `data-reorder-item`;
 * its position among those siblings is its index. Buttons inside a photo
 * (the remove ✕) never start a drag.
 *
 * The photos stay in place while dragging — only the lifted one follows the
 * pointer and the slot it would land in is marked — and `(photoReorder)`
 * fires once on release, so the parent moves its array a single time.
 */
@Directive({
  selector: '[uiPhotoReorder]',
  standalone: true,
})
export class UiPhotoReorderDirective implements OnInit, OnDestroy {
  @Input() reorderDisabled = false;
  @Output() photoReorder = new EventEmitter<PhotoReorderEvent>();

  private pointerId: number | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private startX = 0;
  private startY = 0;
  private item: HTMLElement | null = null;
  private fromIndex = -1;
  private toIndex = -1;
  private dragging = false;
  private suppressClick = false;
  private rects: DOMRect[] = [];

  private readonly onPointerDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onPointerMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onPointerUp = (e: PointerEvent) => this.pointerUp(e);
  private readonly onPointerCancel = () => this.reset();
  // A drag in progress must not scroll the page under the finger.
  private readonly onTouchMove = (e: TouchEvent) => {
    if (this.dragging) e.preventDefault();
  };
  // Long-pressing an image opens the browser's save/share menu on mobile.
  private readonly onContextMenu = (e: Event) => {
    if (this.pressTimer || this.dragging) e.preventDefault();
  };
  // The release that ends a drag must not also click what is under it.
  private readonly onClick = (e: Event) => {
    if (this.suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      this.suppressClick = false;
    }
  };

  constructor(
    private el: ElementRef<HTMLElement>,
    private zone: NgZone,
  ) {}

  ngOnInit() {
    const host = this.el.nativeElement;
    // Pointer moves fire constantly; only the final reorder needs change detection.
    this.zone.runOutsideAngular(() => {
      host.addEventListener('pointerdown', this.onPointerDown);
      host.addEventListener('touchmove', this.onTouchMove, { passive: false });
      host.addEventListener('contextmenu', this.onContextMenu);
      host.addEventListener('click', this.onClick, true);
    });
  }

  ngOnDestroy() {
    const host = this.el.nativeElement;
    host.removeEventListener('pointerdown', this.onPointerDown);
    host.removeEventListener('touchmove', this.onTouchMove);
    host.removeEventListener('contextmenu', this.onContextMenu);
    host.removeEventListener('click', this.onClick, true);
    this.reset();
  }

  private items(): HTMLElement[] {
    return Array.from(
      this.el.nativeElement.querySelectorAll<HTMLElement>(':scope > [data-reorder-item]'),
    );
  }

  private pointerDown(e: PointerEvent) {
    if (this.reorderDisabled || this.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    const item = target.closest<HTMLElement>('[data-reorder-item]');
    if (!item || item.parentElement !== this.el.nativeElement) return;
    const items = this.items();
    if (items.length < 2) return;

    this.pointerId = e.pointerId;
    this.item = item;
    this.fromIndex = this.toIndex = items.indexOf(item);
    this.startX = e.clientX;
    this.startY = e.clientY;
    if (e.pointerType === 'mouse') {
      // Keep the browser's native image drag from taking over.
      e.preventDefault();
    } else {
      this.pressTimer = setTimeout(() => {
        this.pressTimer = null;
        this.startDrag();
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    }
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('pointercancel', this.onPointerCancel);
  }

  private pointerMove(e: PointerEvent) {
    if (e.pointerId !== this.pointerId || !this.item) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (!this.dragging) {
      if (Math.hypot(dx, dy) < MOVE_SLOP_PX) return;
      // A touch that moves before the long press ends is a scroll.
      if (e.pointerType !== 'mouse') {
        this.reset();
        return;
      }
      this.startDrag();
    }
    this.item.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`;
    this.markTarget(e.clientX, e.clientY);
  }

  private pointerUp(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    const { dragging, fromIndex: from, toIndex: to } = this;
    // Only the click from this same release; one released outside the grid
    // never arrives, and the flag must not eat the next real click.
    this.suppressClick = dragging;
    if (dragging) setTimeout(() => (this.suppressClick = false));
    this.reset();
    if (dragging && from !== to && to >= 0) {
      this.zone.run(() => this.photoReorder.emit({ from, to }));
    }
  }

  private startDrag() {
    if (!this.item) return;
    this.dragging = true;
    // Taken before the lifted photo moves, so its home slot stays a target.
    this.rects = this.items().map((el) => el.getBoundingClientRect());
    this.el.nativeElement.classList.add('reordering');
    this.item.classList.add('reorder-dragging');
  }

  /** The photo whose box is under the pointer becomes the drop slot; its own box puts it back. */
  private markTarget(x: number, y: number) {
    const index = this.rects.findIndex(
      (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
    );
    if (index < 0 || index === this.toIndex) return;
    this.toIndex = index;
    this.items().forEach((el, i) =>
      el.classList.toggle('reorder-target', i === index && i !== this.fromIndex),
    );
  }

  private reset() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('pointercancel', this.onPointerCancel);
    this.el.nativeElement.classList.remove('reordering');
    for (const el of this.items()) el.classList.remove('reorder-target');
    if (this.item) {
      this.item.classList.remove('reorder-dragging');
      this.item.style.transform = '';
    }
    this.item = null;
    this.pointerId = null;
    this.dragging = false;
    this.rects = [];
  }
}
