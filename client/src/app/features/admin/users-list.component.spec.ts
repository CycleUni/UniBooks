import { AdminUsersListComponent } from './users-list.component';

describe('AdminUsersListComponent bulk selection', () => {
  const host = (users: any[]) =>
    Object.assign(Object.create(AdminUsersListComponent.prototype), {
      authStore: { user: () => ({ id: 'me' }) },
      users,
    }) as AdminUsersListComponent;

  it('offers only rows the API can switch: not yourself, not staff or admin', () => {
    const list = host([
      { id: 'me', role: 'user' },
      { id: 'a', role: 'admin' },
      { id: 's', role: 'staff' },
      { id: 'u', role: 'user' },
    ]);
    expect(list.pageIds).toEqual(['u']);
    expect(list.canToggle({ id: 'u', role: 'user' } as any)).toBe(true);
    expect(list.canToggle({ id: 'me', role: 'user' } as any)).toBe(false);
  });
});
