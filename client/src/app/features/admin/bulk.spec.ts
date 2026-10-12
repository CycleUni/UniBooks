import { vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import { RowSelection, reportBulk, runBulk } from './bulk';
import { I18nService } from '../../core/i18n.service';
import { ToastService } from '../../core/services/toast.service';

describe('RowSelection', () => {
  it('ticks and unticks rows one at a time', () => {
    const sel = new RowSelection<number>();
    sel.toggle(1);
    sel.toggle(2);
    sel.toggle(1);
    expect(sel.list).toEqual([2]);
    expect(sel.has(2)).toBe(true);
  });

  it('select all ticks the whole page, and unticks it once all are ticked', () => {
    const sel = new RowSelection<string>();
    sel.toggle('a');
    expect(sel.allOf(['a', 'b'])).toBe(false);
    sel.toggleAll(['a', 'b']);
    expect(sel.list).toEqual(['a', 'b']);
    expect(sel.allOf(['a', 'b'])).toBe(true);
    sel.toggleAll(['a', 'b']);
    expect(sel.size).toBe(0);
  });

  it('an empty page is never "all ticked"', () => {
    expect(new RowSelection<number>().allOf([])).toBe(false);
  });
});

describe('runBulk', () => {
  it('runs every id and keeps going past a failure', async () => {
    const seen: number[] = [];
    const result = await firstValueFrom(
      runBulk([1, 2, 3], (id) => {
        seen.push(id);
        return id === 2 ? throwError(() => ({ error: { error: { code: 'x' } } })) : of(null);
      }),
    );
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(result.done.sort()).toEqual([1, 3]);
    expect(result.failed.map((f) => f.id)).toEqual([2]);
  });
});

describe('reportBulk', () => {
  const i18n = {
    t: (k: string, p?: object) => `${k} ${JSON.stringify(p ?? {})}`,
    tOrNull: () => null,
  } as unknown as I18nService;

  it('reports a count when everything went through', () => {
    const toast = { success: vi.fn(), error: vi.fn() } as unknown as ToastService;
    reportBulk(toast, i18n, { done: [1, 2], failed: [] });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('admin.bulk.done {"n":2}'));
  });

  it('says how many failed and why', () => {
    const toast = { success: vi.fn(), error: vi.fn() } as unknown as ToastService;
    reportBulk(toast, i18n, { done: [1], failed: [{ id: 2, error: {} }] });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('admin.bulk.partial'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
