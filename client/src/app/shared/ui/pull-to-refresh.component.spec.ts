import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { UiPullToRefresh } from './pull-to-refresh.component';

import { signal } from '@angular/core';

@Component({
  standalone: true,
  imports: [UiPullToRefresh],
  template: `
    <ui-pull-to-refresh [refreshing]="refreshing()" (refresh)="onRefresh()">
      <div class="test-content">Item 1</div>
    </ui-pull-to-refresh>
  `
})
class HostComponent {
  readonly refreshing = signal(false);
  refreshed = false;
  onRefresh() {
    this.refreshed = true;
    this.refreshing.set(true);
  }
}

describe('UiPullToRefresh', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let ptrElement: HTMLElement;

  const stubPhone = (isPhone: boolean) => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 900px') ? isPhone : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  };

  beforeEach(async () => {
    stubPhone(true);
    await TestBed.configureTestingModule({
      imports: [HostComponent, UiPullToRefresh]
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    ptrElement = fixture.nativeElement.querySelector('ui-pull-to-refresh');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing on desktop (>900px)', () => {
    stubPhone(false);
    fixture.detectChanges();

    const ptr = fixture.debugElement.children[0].children[0].componentInstance as UiPullToRefresh;
    const touchStart = new TouchEvent('touchstart', {
      touches: [{ clientX: 100, clientY: 100 } as Touch]
    });
    ptrElement.dispatchEvent(touchStart);

    expect(ptr.pullDistance).toBe(0);
    expect(ptr.isPulling).toBe(false);
  });

  it('engages on phone when downward drag starts at the top', () => {
    const ptr = fixture.debugElement.children[0].children[0].componentInstance as UiPullToRefresh;

    ptrElement.dispatchEvent(new TouchEvent('touchstart', {
      touches: [{ clientX: 100, clientY: 100 } as Touch]
    }));

    ptrElement.dispatchEvent(new TouchEvent('touchmove', {
      touches: [{ clientX: 100, clientY: 150 } as Touch],
      cancelable: true
    }));
    fixture.detectChanges();

    expect(ptr.isPulling).toBe(true);
    expect(ptr.pullDistance).toBeGreaterThan(0);
  });

  it('resets without emitting refresh if released before 70px threshold', () => {
    const ptr = fixture.debugElement.children[0].children[0].componentInstance as UiPullToRefresh;

    ptrElement.dispatchEvent(new TouchEvent('touchstart', {
      touches: [{ clientX: 100, clientY: 100 } as Touch]
    }));
    // Drag down by 40px (resistance yields 20px < 70px)
    ptrElement.dispatchEvent(new TouchEvent('touchmove', {
      touches: [{ clientX: 100, clientY: 140 } as Touch],
      cancelable: true
    }));
    fixture.detectChanges();

    ptrElement.dispatchEvent(new TouchEvent('touchend'));
    fixture.detectChanges();

    expect(host.refreshed).toBe(false);
    expect(ptr.pullDistance).toBe(0);
    expect(ptr.isRefreshing).toBe(false);
  });

  it('triggers refresh when pulled past threshold and released', () => {
    const ptrDebug = fixture.debugElement.query(By.directive(UiPullToRefresh));
    const ptr = ptrDebug.componentInstance as UiPullToRefresh;

    ptrElement.dispatchEvent(new TouchEvent('touchstart', {
      touches: [{ clientX: 100, clientY: 100 } as Touch]
    }));
    // Drag down by 200px (yields 100px >= 70px threshold)
    ptrElement.dispatchEvent(new TouchEvent('touchmove', {
      touches: [{ clientX: 100, clientY: 300 } as Touch],
      cancelable: true
    }));
    fixture.detectChanges();

    expect(ptr.pullDistance).toBeGreaterThanOrEqual(70);

    ptrElement.dispatchEvent(new TouchEvent('touchend'));
    fixture.detectChanges();

    expect(host.refreshed).toBe(true);
    expect(ptr.isRefreshing).toBe(true);
    expect(ptr.pullDistance).toBe(52); // Holding position

    // Reset via [refreshing]="false"
    host.refreshing.set(false);
    fixture.detectChanges();

    expect(ptr.isRefreshing).toBe(false);
    expect(ptr.pullDistance).toBe(0);
  });

  it('does not engage if page is scrolled down', () => {
    const ptr = fixture.debugElement.children[0].children[0].componentInstance as UiPullToRefresh;

    // Simulate scrolled window
    window.scrollY = 150;

    ptrElement.dispatchEvent(new TouchEvent('touchstart', {
      touches: [{ clientX: 100, clientY: 100 } as Touch]
    }));
    ptrElement.dispatchEvent(new TouchEvent('touchmove', {
      touches: [{ clientX: 100, clientY: 200 } as Touch],
      cancelable: true
    }));
    fixture.detectChanges();

    expect(ptr.isPulling).toBe(false);
    expect(ptr.pullDistance).toBe(0);

    window.scrollY = 0;
  });

  it('ignores horizontal swipe gestures', () => {
    const ptr = fixture.debugElement.children[0].children[0].componentInstance as UiPullToRefresh;

    ptrElement.dispatchEvent(new TouchEvent('touchstart', {
      touches: [{ clientX: 100, clientY: 100 } as Touch]
    }));
    // Swiping sideways (deltaX: 80, deltaY: 20)
    ptrElement.dispatchEvent(new TouchEvent('touchmove', {
      touches: [{ clientX: 180, clientY: 120 } as Touch],
      cancelable: true
    }));
    fixture.detectChanges();

    expect(ptr.isPulling).toBe(false);
    expect(ptr.pullDistance).toBe(0);
  });
});
