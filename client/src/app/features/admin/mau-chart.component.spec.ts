import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdminMauChartComponent } from './mau-chart.component';
import { I18nService } from '../../core/i18n.service';

describe('AdminMauChartComponent', () => {
  let fixture: ComponentFixture<AdminMauChartComponent>;
  let component: AdminMauChartComponent;

  const fakeI18n = {
    t: (key: string) => key,
    tOrNull: (key: string) => key,
    lang: () => 'zh-TW',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminMauChartComponent],
      providers: [{ provide: I18nService, useValue: fakeI18n }],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminMauChartComponent);
    component = fixture.componentInstance;
  });

  it('shows empty note when series has no positive MAU', () => {
    component.series = [
      { month: '2026-09', mau: 0 },
      { month: '2026-10', mau: 0 },
      { month: '2026-11', mau: 0 },
    ];
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.empty-note')).not.toBeNull();
    const hiddenBox = el.querySelector('[hidden]');
    expect(hiddenBox).not.toBeNull();
  });

  it('renders canvas and accessible data table when series has data', () => {
    component.series = [
      { month: '2026-09', mau: 120 },
      { month: '2026-10', mau: 230 },
      { month: '2026-11', mau: 310 },
    ];
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.empty-note')).toBeNull();
    const canvas = el.querySelector('canvas');
    expect(canvas).not.toBeNull();

    const rows = el.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('2026-09');
    expect(rows[0].textContent).toContain('120');
    expect(rows[1].textContent).toContain('2026-10');
    expect(rows[1].textContent).toContain('230');
    expect(rows[2].textContent).toContain('2026-11');
    expect(rows[2].textContent).toContain('310');
  });
});
