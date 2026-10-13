import { describe, it, expect } from 'vitest';
import { normalizeQuery } from '../../src/services/catalog/lookups';

describe('normalizeQuery', () => {
  it('maps case, spacing and full-width variants of a query to one cache key', () => {
    const forms = ['Calculus', 'calculus ', 'CALCULUS', '  calculus', 'ｃａｌｃｕｌｕｓ'];
    expect(new Set(forms.map(normalizeQuery))).toEqual(new Set(['calculus']));
    expect(normalizeQuery('Linear   Algebra\tDone Right')).toBe('linear algebra done right');
  });
});
