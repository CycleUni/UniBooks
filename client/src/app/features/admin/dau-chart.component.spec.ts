import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdminDauChartComponent } from './dau-chart.component';
import { I18nService } from '../../core/i18n.service';

describe('AdminDauChartComponent', () => {
  let fixture: ComponentFixture<AdminDauChartComponent>;
  let component: AdminDauChartComponent;

  const fakeI18n = {
    t: (key: string) => key,
    tOrNull: (key: string) => key,
    lang: () => 'zh-TW',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminDauChartComponent],
      providers: [{ provide: I18nService, useValue: fakeI18n }],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminDauChartComponent);
    component = fixture.componentInstance;
  });

  it('shows empty note when series has no positive DAU', () => {
    component.series = [
      { date: '2026-11-13', dau: 0 },
      { date: '2026-11-14', dau: 0 },
    ];
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.empty-note')).not.toBeNull();
    const hiddenBox = el.querySelector('[hidden]');
    expect(hiddenBox).not.toBeNull();
  });

  it('renders canvas and accessible data table when series has data', () => {
    component.series = [
      { date: '2026-11-13', dau: 25 },
      { date: '2026-11-14', dau: 40 },
    ];
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.empty-note')).toBeNull();
    const canvas = el.querySelector('canvas');
    expect(canvas).not.toBeNull();

    const rows = el.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('2026-11-13');
    expect(rows[0].textContent).toContain('25');
    expect(rows[1].textContent).toContain('2026-11-14');
    expect(rows[1].textContent).toContain('40');
  });
});
