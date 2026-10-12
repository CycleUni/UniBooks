import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { UiSearchField } from './search-field.component';
import { I18nService } from '../../core/i18n.service';

@Component({
  standalone: true,
  imports: [UiSearchField, FormsModule],
  template: `
    <ui-search-field
      [showScan]="showScan"
      [(ngModel)]="query"
      (search)="onSearch($event)"
      (scan)="onScan()"
    ></ui-search-field>
  `
})
class TestHostComponent {
  query = '';
  showScan = false;
  lastSearch = '';
  scanEmitted = false;

  onSearch(q: string) {
    this.lastSearch = q;
  }

  onScan() {
    this.scanEmitted = true;
  }
}

describe('UiSearchField', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;
  let searchField: UiSearchField;
  let inputEl: HTMLInputElement;

  const mockI18n = {
    lang: () => 'en',
    t: (key: string) => {
      const dict: Record<string, string> = {
        'common.search': 'Search',
        'common.searchPlaceholder': 'Search by title, ISBN, course, or professor...',
        'common.clear': 'Clear',
        'search.scanBarcode': 'Scan a barcode',
      };
      return dict[key] ?? key;
    }
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [
        { provide: I18nService, useValue: mockI18n }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    searchField = fixture.debugElement.query(By.directive(UiSearchField)).componentInstance;
    inputEl = fixture.debugElement.query(By.css('input[type="search"]')).nativeElement;
  });

  it('submit emits the trimmed query', async () => {
    host.query = '  calculus 101  ';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const formEl = fixture.debugElement.query(By.css('form')).nativeElement as HTMLFormElement;
    formEl.dispatchEvent(new Event('submit'));

    expect(host.lastSearch).toBe('calculus 101');
  });

  it('empty query does not emit', async () => {
    host.query = '   ';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const formEl = fixture.debugElement.query(By.css('form')).nativeElement as HTMLFormElement;
    formEl.dispatchEvent(new Event('submit'));

    expect(host.lastSearch).toBe('');
  });

  it('Enter during IME composition does not submit', async () => {
    host.query = 'algorithm';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // 1. In the middle of composition
    inputEl.dispatchEvent(new Event('compositionstart'));
    expect(searchField.isComposing).toBe(true);

    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.lastSearch).toBe('');

    // 2. Immediately after compositionend (confirming candidate word with Enter)
    inputEl.dispatchEvent(new Event('compositionend'));
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.lastSearch).toBe('');

    // 3. With isComposing property on the event
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(host.lastSearch).toBe('');
  });

  it('clear button empties and keeps focus', async () => {
    host.query = 'operating systems';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let clearBtn = fixture.debugElement.query(By.css('.clear-button'));
    expect(clearBtn).toBeTruthy();

    const focusSpy = vi.spyOn(inputEl, 'focus');

    clearBtn.nativeElement.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(searchField.value).toBe('');
    expect(host.query).toBe('');
    expect(focusSpy).toHaveBeenCalled();

    clearBtn = fixture.debugElement.query(By.css('.clear-button'));
    expect(clearBtn).toBeNull();
  });

  it('scan button only when enabled and emits scan', () => {
    expect(fixture.debugElement.query(By.css('.scan-button'))).toBeNull();

    host.showScan = true;
    fixture.detectChanges();

    const scanBtn = fixture.debugElement.query(By.css('.scan-button'));
    expect(scanBtn).toBeTruthy();

    scanBtn.nativeElement.click();
    expect(host.scanEmitted).toBe(true);
  });

  it('searches when the magnifier is tapped, like the keyboard search key', async () => {
    host.query = 'organic chemistry';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.debugElement.query(By.css('button.search-submit')).nativeElement as HTMLButtonElement;
    expect(button.type).toBe('submit');
    expect(button.getAttribute('aria-label')).toBe('Search');
    button.click();

    expect(host.lastSearch).toBe('organic chemistry');
  });

  it('focuses the input when the magnifier is tapped with nothing typed', () => {
    const focusSpy = vi.spyOn(inputEl, 'focus');
    fixture.debugElement.query(By.css('button.search-submit')).nativeElement.click();

    expect(host.lastSearch).toBe('');
    expect(focusSpy).toHaveBeenCalled();
  });

  it('focus() works', () => {
    const focusSpy = vi.spyOn(inputEl, 'focus');
    searchField.focus();
    expect(focusSpy).toHaveBeenCalled();
  });

  it('blurs the input on submit so mobile keyboard closes', async () => {
    host.query = 'physics';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const blurSpy = vi.spyOn(inputEl, 'blur');
    const formEl = fixture.debugElement.query(By.css('form')).nativeElement as HTMLFormElement;
    formEl.dispatchEvent(new Event('submit'));

    expect(blurSpy).toHaveBeenCalled();
    expect(host.lastSearch).toBe('physics');
  });
});
