export function add(x: number, y: number) { return x + y; }

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
