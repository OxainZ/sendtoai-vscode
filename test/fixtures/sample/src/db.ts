export interface User { id: number; name: string; email: string; createdAt: Date }

const users: User[] = [
  { id: 1, name: 'Ada', email: 'ada@example.com', createdAt: new Date('2026-01-04') },
  { id: 2, name: 'Linus', email: 'linus@example.com', createdAt: new Date('2026-02-11') },
];

export const db = {
  all: () => users,
  byId: (id: number) => users.find(u => u.id === id),
};
