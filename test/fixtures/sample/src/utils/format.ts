export const formatDate = (d: Date) => d.toISOString().slice(0, 10);
export const initials = (name: string) => name.split(' ').map(p => p[0]).join('').toUpperCase();
