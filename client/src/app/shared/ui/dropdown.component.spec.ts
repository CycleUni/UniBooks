import { TestBed } from '@angular/core/testing';
import { UiDropdown, DropdownOption } from './dropdown.component';
import { I18nService } from '../../core/i18n.service';

describe('UiDropdown groups', () => {
  const options: DropdownOption[] = [
    { value: '', label: 'All Universities' },
    { value: 'NTU', label: 'National Taiwan University', group: 'Taipei City', keywords: ['國立臺灣大學', 'NTU', 'ntu.edu.tw'] },
    { value: 'NTNU', label: 'National Taiwan Normal University', group: 'Taipei City' },
    { value: 'NCKU', label: 'National Cheng Kung University', group: 'Tainan City' },
  ];

  function create(pinSelected = false) {
    TestBed.configureTestingModule({
      imports: [UiDropdown],
      providers: [
        { provide: I18nService, useValue: { lang: () => 'en', t: (key: string) => key } },
      ],
    });
    const fixture = TestBed.createComponent(UiDropdown);
    const dropdown = fixture.componentInstance;
    dropdown.options = options;
    dropdown.pinSelected = pinSelected;
    return dropdown;
  }

  const headings = (dropdown: UiDropdown) =>
    dropdown.optionRows.filter((r) => r.heading).map((r) => `${r.heading}:${r.opt.value}`);

  it('matches an option by its keywords, e.g. a school name in another language', () => {
    const dropdown = create();
    dropdown.searchQuery = '臺灣大學';
    expect(dropdown.filteredOptions.map((o) => o.value)).toEqual(['NTU']);
    dropdown.searchQuery = 'ntu.edu';
    expect(dropdown.filteredOptions.map((o) => o.value)).toEqual(['NTU']);
  });

  it('heads each group once, on its first option', () => {
    const dropdown = create();
    expect(headings(dropdown)).toEqual(['Taipei City:NTU', 'Tainan City:NCKU']);
    // The ungrouped "all" option has no heading.
    expect(dropdown.optionRows[0].heading).toBeNull();
  });

  it('lists a whole group when its heading is searched', () => {
    const dropdown = create();
    dropdown.searchQuery = 'taipei';
    expect(dropdown.filteredOptions.map((o) => o.value)).toEqual(['NTU', 'NTNU']);
    expect(headings(dropdown)).toEqual(['Taipei City:NTU']);
  });

  it('still matches on the option label', () => {
    const dropdown = create();
    dropdown.searchQuery = 'cheng kung';
    expect(dropdown.filteredOptions.map((o) => o.value)).toEqual(['NCKU']);
  });

  it('keeps the pinned selection out of the groups, so none is headed twice', () => {
    const dropdown = create(true);
    dropdown.writeValue('NTNU');
    const rows = dropdown.optionRows;
    expect(rows[0].opt.value).toBe('NTNU');
    expect(rows[0].heading).toBeNull();
    expect(headings(dropdown)).toEqual(['Taipei City:NTU', 'Tainan City:NCKU']);
  });

  it('gives a selection already in place its group heading', () => {
    const dropdown = create(true);
    dropdown.writeValue('NTU');
    dropdown.searchQuery = 'taipei';
    expect(headings(dropdown)).toEqual(['Taipei City:NTU']);
  });
});
