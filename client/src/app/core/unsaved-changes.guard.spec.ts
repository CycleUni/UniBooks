import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { vi } from 'vitest';
import { unsavedChangesGuard, HasUnsavedChanges } from './unsaved-changes.guard';
import { ConfirmService } from './services/confirm.service';
import { I18nService } from './i18n.service';

describe('unsavedChangesGuard', () => {
  let ask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    ask = vi.fn(() => Promise.resolve(true));
    TestBed.configureTestingModule({
      providers: [
        { provide: ConfirmService, useValue: { ask } },
        { provide: I18nService, useValue: { t: (k: string) => k } },
      ],
    });
  });

  function run(component: HasUnsavedChanges | null) {
    return TestBed.runInInjectionContext(() =>
      unsavedChangesGuard(
        component as HasUnsavedChanges,
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
        {} as RouterStateSnapshot,
      ),
    );
  }

  const dirty: HasUnsavedChanges = {
    hasUnsavedChanges: () => true,
    unsavedChangesMessage: () => 'sell.leaveConfirm',
  };

  it('lets a clean component go without asking', () => {
    const result = run({ hasUnsavedChanges: () => false, unsavedChangesMessage: () => 'x' });
    expect(result).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('lets anything that does not implement the interface go', () => {
    expect(run(null)).toBe(true);
    expect(run({} as HasUnsavedChanges)).toBe(true);
  });

  /**
   * The bug this replaced: mobile browsers suppress a native confirm() raised
   * during a navigation, and a suppressed one reads as "cancel" — the page
   * then refused to leave with nothing on screen to say why.
   */
  it('asks through the app dialog, not the native one', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    await run(dirty);
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ message: 'sell.leaveConfirm' });
    nativeConfirm.mockRestore();
  });

  it('leaves or stays with the answer', async () => {
    ask.mockResolvedValueOnce(true);
    await expect(run(dirty)).resolves.toBe(true);
    ask.mockResolvedValueOnce(false);
    await expect(run(dirty)).resolves.toBe(false);
  });
});
