import { courseKey } from './course-key';
// The server's own function: the two must name every course the same way, or a
// request made here would never match a listing keyed there. It imports nothing.
import { courseKey as serverCourseKey } from '../../../../server/src/lib/course';

describe('courseKey', () => {
  it('treats spelling variants of one course as the same', () => {
    expect(courseKey('微積分 (一)')).toBe(courseKey('微積分（一）'));
    expect(courseKey('Calculus I')).toBe(courseKey('calculus  i'));
    expect(courseKey('微積分')).not.toBe(courseKey('微積分(一)'));
  });

  it('is empty for text that is only punctuation', () => {
    expect(courseKey(' -- ')).toBe('');
  });

  it('gives the same key as the server for every spelling', () => {
    const spellings = [
      '微積分 (一)', '微積分（一）', '微積分(一)', '  微積分  ', '經 濟 學', '會計學（上）', '會計學(上)',
      'Calculus I', 'calculus  i', 'CALCULUS-I', 'Calculus I.', 'Ｃａｌｃｕｌｕｓ',
      '統計學：觀念與應用', '統計學:觀念與應用', '資料結構／演算法', '資料結構/演算法',
      'C++ 程式設計', 'C＋＋程式設計', 'Ⅲ', '３Ｄ設計', 'ｶﾀｶﾅ', 'école', 'école',
      '經濟學 ➕ 管理', '—', '', ' ', '。。。', 'a_b-c.d',
    ];
    for (const s of spellings) expect(courseKey(s), JSON.stringify(s)).toBe(serverCourseKey(s));
  });
});
