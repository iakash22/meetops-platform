import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpMetrics } from '../src/shared/metrics.js';

// Guards infra/monitoring/prometheus/api-alerts.rules.yml (P9 item #13) against drift from what the API emits.
const RULES = new URL('../../../infra/monitoring/prometheus/api-alerts.rules.yml', import.meta.url);
const text = readFileSync(RULES, 'utf8');

type Rule = {
  alert: string;
  expr: string;
  for?: string;
  severity?: string;
  summary?: string;
  runbook?: string;
};
function parse(src: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*(?:- )?(alert|expr|for|severity|summary|runbook):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, keyof Rule, string];
    const value = raw.replace(/^'(.*)'$/, '$1');
    if (key === 'alert') rules.push({ alert: value, expr: '' });
    else if (rules.length) rules[rules.length - 1]![key] = value;
  }
  return rules;
}

const PROMQL_WORDS = new Set([
  'sum',
  'by',
  'rate',
  'increase',
  'clamp_min',
  'histogram_quantile',
  'and',
  'on',
  'resets',
  'le',
  'instance',
  'job',
  'route',
  'status',
]);

function emittedMetricNames(): Set<string> {
  const m = new HttpMetrics(
    () => 1,
    () => ({ rss: 1, heapUsed: 1 }),
  );
  m.observe('GET', '/x', 200, 0.01);
  const names = new Set(['up']); // synthesised by Prometheus for every target
  for (const line of m.render().split('\n')) {
    const n = /^([a-z_:][a-z0-9_:]*)[{ ]/.exec(line)?.[1];
    if (n && !line.startsWith('#')) names.add(n);
  }
  return names;
}

describe('API Prometheus alert rules', () => {
  const rules = parse(text);

  it('defines the P9 #13 alerts (down, 5xx rate, latency, /ready failures)', () => {
    expect(rules.map((r) => r.alert)).toEqual(
      expect.arrayContaining([
        'MeetOpsApiDown',
        'MeetOpsApiHigh5xxRate',
        'MeetOpsApiHighLatencyP95',
        'MeetOpsApiNotReady',
      ]),
    );
    expect(new Set(rules.map((r) => r.alert)).size).toBe(rules.length);
  });

  it('every rule has an expr, for, a known severity, a summary and a runbook anchor that exists', () => {
    const doc = readFileSync(
      new URL('../../../docs/14-observability/alerts.md', import.meta.url),
      'utf8',
    );
    for (const r of rules) {
      expect(r.expr, r.alert).not.toBe('');
      expect(r.for, r.alert).toMatch(/^\d+[smh]$/);
      expect(['page', 'ticket'], r.alert).toContain(r.severity);
      expect(r.summary, r.alert).toBeTruthy();
      expect(r.runbook, r.alert).toBe(`docs/14-observability/alerts.md#${r.alert.toLowerCase()}`);
      expect(doc, r.alert).toContain(`## ${r.alert}`);
    }
  });

  it('only references metrics that apps/api/src/shared/metrics.ts emits', () => {
    const emitted = emittedMetricNames();
    for (const r of rules) {
      const stripped = r.expr.replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '');
      const idents = stripped.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? [];
      const metrics = idents.filter(
        (i) => !PROMQL_WORDS.has(i) && !/^\d/.test(i) && !/^e\d*$/.test(i),
      );
      expect(metrics.length, r.alert).toBeGreaterThan(0);
      for (const name of metrics) expect(emitted, `${r.alert}: ${name}`).toContain(name);
    }
  });

  it('scopes every expression to job="meetops-api" and uses route templates, not raw URLs', () => {
    for (const r of rules) {
      expect(r.expr, r.alert).toContain('job="meetops-api"');
      expect(r.expr, r.alert).not.toMatch(/route="[^"]*\?/);
    }
  });

  it('has balanced brackets in every expression', () => {
    for (const r of rules) {
      for (const [o, c] of [
        ['(', ')'],
        ['{', '}'],
        ['[', ']'],
      ] as const) {
        expect(r.expr.split(o).length, `${r.alert} ${o}`).toBe(r.expr.split(c).length);
      }
    }
  });
});
