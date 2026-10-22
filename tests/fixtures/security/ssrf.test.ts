import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOST,
  ssrfPayloads,
  ssrfScenarios,
  ssrfUrlPayloads,
  withAllowedHost,
} from './ssrf.js';

describe('SSRF fixture shape', () => {
  it('covers SS-01..SS-32 exactly once, in order', () => {
    const ids = ssrfPayloads.map((p) => p.id);
    expect(ids).toEqual(
      Array.from({ length: 32 }, (_, i) => `SS-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('every url payload has at least one non-empty URL and a note', () => {
    for (const p of ssrfPayloads) {
      expect(p.note.length).toBeGreaterThan(0);
      if (p.kind === 'url') {
        expect(p.urls.length).toBeGreaterThan(0);
        for (const u of p.urls) expect(u).toMatch(/^[a-z]+:/);
      } else {
        expect(p.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('flattens to one row per URL and separates scenarios', () => {
    const urlCount = ssrfPayloads.reduce((n, p) => n + (p.kind === 'url' ? p.urls.length : 0), 0);
    expect(ssrfUrlPayloads).toHaveLength(urlCount);
    expect(ssrfScenarios.map((s) => s.id)).toEqual([
      'SS-18',
      'SS-19',
      'SS-20',
      'SS-29',
      'SS-30',
      'SS-31',
      'SS-32',
    ]);
  });

  it('withAllowedHost swaps the placeholder host', () => {
    expect(withAllowedHost(`https://${ALLOWED_HOST}@evil.example/`, 'api.openai.com')).toBe(
      'https://api.openai.com@evil.example/',
    );
    expect(withAllowedHost(`https://${ALLOWED_HOST.toUpperCase()}./`, 'api.x.ai')).toBe(
      'https://API.X.AI./',
    );
  });
});
