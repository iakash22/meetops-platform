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

  it('handles many distinct percent-encoded runs on the fallback path quickly', () => {
    let payload = '';
    for (let i = 0; i < 4000; i++) {
      payload += `%${Math.floor(i / 256)
        .toString(16)
        .padStart(2, '0')}%${(i % 256).toString(16).padStart(2, '0')}x`;
    }
    const started = Date.now();
    queryString.parse(`q=${payload}%zz`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
