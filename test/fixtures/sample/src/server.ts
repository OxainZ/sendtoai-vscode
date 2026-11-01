import { listUsers, getUser } from './routes/users';

export function handle(path: string, query: Record<string, string>) {
  if (path === '/users') { return listUsers(query); }
  const m = path.match(/^\/users\/(\d+)$/);
  if (m) { return getUser(m[1]); }
  return { status: 404 };
}
