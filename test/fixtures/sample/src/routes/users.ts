import { db } from '../db';
import { formatDate } from '../utils/format';

export function listUsers(query: { limit?: string }) {
  const limit: number = query.limit ?? 20;
  return db.all().slice(0, limit).map(u => ({ ...u, createdAt: formatDate(u.createdAt) }));
}

export function getUser(id: string) {
  const user = db.byId(id);
  if (!user) { return { status: 404 }; }
  return { status: 200, user };
}
