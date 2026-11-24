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

  it('finds an option through its matchHint and shows the hint while it matches', () => {
    const dropdown = create();
    dropdown.options = [
      { value: '', label: 'Pick one' },
      { value: 'management', label: '商管學院', matchHint: (q) => (q === '資管' ? '資訊管理學系' : undefined) },
      { value: 'law', label: '法學院' },
    ];
    dropdown.searchQuery = '資管';
    expect(dropdown.optionRows.map((r) => [r.opt.value, r.hint])).toEqual([['management', '資訊管理學系']]);
    dropdown.searchQuery = '';
    expect(dropdown.optionRows.every((r) => r.hint === undefined)).toBe(true);
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

describe('UiDropdown allowCustom', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiDropdown],
      providers: [{ provide: I18nService, useValue: { lang: () => 'en', t: (key: string) => key } }],
    });
  });

  function create(allowCustom: boolean) {
    const dropdown = TestBed.createComponent(UiDropdown).componentInstance;
    dropdown.options = [{ value: 'Calculus', label: 'Calculus' }, { value: 'Statistics', label: 'Statistics' }];
    dropdown.allowCustom = allowCustom;
    return dropdown;
  }

  it('offers the typed text when no option is exactly that', () => {
    const dropdown = create(true);
    dropdown.searchQuery = '  Linear Algebra ';
    expect(dropdown.customCandidate).toBe('Linear Algebra');
  });

  it('offers nothing when an option matches exactly, whatever its case', () => {
    const dropdown = create(true);
    dropdown.searchQuery = 'calculus';
    expect(dropdown.customCandidate).toBeNull();
  });

  it('still offers the text when it only partly matches an option', () => {
    const dropdown = create(true);
    dropdown.searchQuery = 'Calc';
    expect(dropdown.customCandidate).toBe('Calc');
  });

  it('offers nothing without allowCustom, or with an empty search', () => {
    const plain = create(false);
    plain.searchQuery = 'Linear Algebra';
    expect(plain.customCandidate).toBeNull();
    const custom = create(true);
    custom.searchQuery = '   ';
    expect(custom.customCandidate).toBeNull();
  });

  it('selects the typed text as the value and shows it', () => {
    const dropdown = create(true);
    const changes: string[] = [];
    dropdown.registerOnChange((v: string) => changes.push(v));
    dropdown.selectCustom('Linear Algebra');
    expect(changes).toEqual(['Linear Algebra']);
    expect(dropdown.selectedLabel).toBe('Linear Algebra');
  });

  it('shows a value that is not an option only with allowCustom', () => {
    const custom = create(true);
    custom.writeValue('Old course');
    expect(custom.selectedLabel).toBe('Old course');
    const plain = create(false);
    plain.writeValue('Old course');
    expect(plain.selectedLabel).toBe('');
  });
});
