import { departmentHint, matchedDepartments } from './department-match';

describe('matchedDepartments', () => {
  const management = [
    { name: '資訊管理學系', aliases: ['資管'] },
    { name: '會計學系', aliases: ['會計'] },
  ];

  it('finds a department by short name, full name, or either with 系', () => {
    for (const q of ['資管', '資管系', '資訊管理系', '資訊管理學系', ' 資 管 ']) {
      expect(matchedDepartments(management, q)).toEqual(['資訊管理學系']);
    }
  });

  it('names nothing for a one-character keyword, an unrelated one, or a college without departments', () => {
    expect(matchedDepartments(management, '系')).toEqual([]);
    expect(matchedDepartments(management, '資')).toEqual([]);
    expect(matchedDepartments(management, '微積分')).toEqual([]);
    expect(matchedDepartments(undefined, '資管')).toEqual([]);
  });
});

describe('matchedDepartments in English', () => {
  const engineering = [
    { name: 'Mechanical Engineering', aliases: ['機械工程學系', '機械', 'ME'] },
    { name: 'Civil Engineering', aliases: ['土木工程學系', '土木'] },
  ];

  it('finds a department by its other-language spelling, or a whole two-letter short name', () => {
    expect(matchedDepartments(engineering, '機械系')).toEqual(['Mechanical Engineering']);
    expect(matchedDepartments(engineering, 'me')).toEqual(['Mechanical Engineering']);
    expect(matchedDepartments(engineering, 'civil')).toEqual(['Civil Engineering']);
  });

  it('does not read two letters inside a longer name as a short name', () => {
    expect(matchedDepartments(engineering, 'ee')).toEqual([]);
  });
});

describe('departmentHint', () => {
  const engineering = ['機械', '土木', '化學', '材料'].map((n) => ({ name: `${n}工程學系`, aliases: [] }));

  it('lists up to three matched names in the page language, then …', () => {
    expect(departmentHint(engineering, '工程', 'zh-TW')).toBe('機械工程學系、土木工程學系、化學工程學系…');
    expect(departmentHint(engineering.slice(0, 2), '工程', 'en')).toBe('機械工程學系, 土木工程學系');
    expect(departmentHint(engineering, '法律', 'zh-TW')).toBeUndefined();
  });
});
