/** Small seedable PRNG (mulberry32) so factory output is deterministic. */
export type Rng = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  id(prefix: string): string;
  /** Deterministic RFC 4122 v4-shaped UUID. */
  uuid(): string;
};

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let counter = 0;
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick() on empty list');
      return item;
    },
    uuid: () => {
      const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16)).join('');
      const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
    id: (prefix) =>
      `${prefix}_${(++counter).toString().padStart(4, '0')}_${Math.floor(next() * 0xffff)
        .toString(16)
        .padStart(4, '0')}`,
  };
}
