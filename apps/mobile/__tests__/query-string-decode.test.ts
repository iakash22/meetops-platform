// Regression guard for the decode-uri-component override (GHSA-qr28-fpjm-wq7f).
// expo-router 4 loads query-string 7 with `__importStar(require('query-string'))`, and query-string 7
// `require`s decode-uri-component, which is ESM-only (default export) from 0.4.x on. Without
// patches/query-string@7.1.3.patch, every decode throws "decodeComponent is not a function".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const queryString = require('query-string') as typeof import('query-string');

describe('query-string with patched decode-uri-component', () => {
  it('decodes percent-encoded values', () => {
    expect(queryString.parse('a=%C3%A5&b=x%20y&c=%F0%9F%A6%84')).toEqual({
      a: 'å',
      b: 'x y',
      c: '🦄',
    });
  });

  it('falls back to the custom decoder on malformed input instead of throwing', () => {
    expect(queryString.parse('q=%C3%A5%zz')).toEqual({ q: 'å%zz' });
  });

  it('round-trips through stringify', () => {
    const query = { id: 'a b/c', tag: ['x', 'ü'] };
    expect(queryString.parse(queryString.stringify(query))).toEqual(query);
  });

  it('loads the ESM-only decode-uri-component >=0.5 (CJS 0.2.x has no default export)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const decodeModule = require('decode-uri-component') as { default?: unknown };
    expect(typeof decodeModule.default).toBe('function');
  });

  // GHSA-qr28-fpjm-wq7f: <=0.5.0 runs one full-string regex replace per distinct percent-encoded run on the
  // fallback path (forced by a trailing %zz), so the cost is quadratic. The advisory PoC payload is timed at
  // n and 4n runs (best of 3 each, to damp GC/CI noise). Linear code grows ~4x; quadratic grows ~16x or more
  // (0.2.2 measured ~170 ms -> ~4.4 s). The ratio does not depend on machine speed; the absolute ceiling is a
  // loose backstop (0.5.1 takes ~35-50 ms at 16000 runs, 0.2.2 ~4.4 s).
  const payloadOf = (runs: number) => {
    let payload = '';
    for (let i = 0; i < runs; i++) {
      const high = Math.floor(i / 256)
        .toString(16)
        .padStart(2, '0');
      const low = (i % 256).toString(16).padStart(2, '0');
      payload += `%${high}%${low}x`;
    }
    return `q=${payload}%zz`;
  };
  const bestOf3 = (input: string) => {
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      queryString.parse(input);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it('decodes many distinct percent-encoded runs in linear time on the fallback path', () => {
    const small = payloadOf(4000);
    const large = payloadOf(16000);
    queryString.parse(small); // warm up the JIT
    const smallMs = bestOf3(small);
    const largeMs = bestOf3(large);
    const growth = largeMs / Math.max(smallMs, 1);
    expect(largeMs).toBeLessThan(1000);
    expect(growth).toBeLessThan(8);
  });
});
