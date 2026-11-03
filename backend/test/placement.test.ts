import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudIndex, quote, sizeFor } from '../src/placement.ts';

const base = { monthlyUsers: 2_000, needsDatabase: false, monthlyBudget: 20, euOnly: false, egressTb: 0.2, storageGb: 10 };

test('options are real alternatives inside the budget', () => {
  const q = quote(base);
  assert.equal(q.options.length, 3);
  assert.equal(new Set(q.options.map((o) => o.providerId)).size, 3);
  assert.ok(q.options[0]!.monthly.total <= 20);
  assert.ok(q.options[1]!.monthly.total <= 20);
  assert.ok(q.options[0]!.monthly.total <= q.options[1]!.monthly.total);
});

test('Premium is a real step up, and says so when it costs more than the budget', () => {
  const q = quote({ ...base, euOnly: true, needsDatabase: true, monthlyBudget: 8 });
  const [, balanced, premium] = q.options;
  assert.ok(premium!.monthly.total > balanced!.monthly.total);
  assert.ok(premium!.monthly.total > 8);
  assert.equal(premium!.overBudgetBy, Math.round((premium!.monthly.total - 8) * 100) / 100);
});

test('EU only drops American companies', () => {
  const q = quote({ ...base, euOnly: true, monthlyBudget: 500 });
  for (const o of q.options) assert.ok(!['AWS', 'Azure', 'Google Cloud', 'DigitalOcean', 'Vultr'].includes(o.provider), o.provider);
});

test('egress changes the answer', () => {
  const cheap = quote({ ...base, monthlyBudget: 500 }).options;
  const heavy = quote({ ...base, monthlyBudget: 500, egressTb: 10 }).options;
  const aws = (list: typeof cheap) => list.find((o) => o.provider === 'AWS');
  assert.ok(!aws(heavy) || aws(heavy)!.monthly.egress > 800);
  assert.ok(heavy[0]!.monthly.egress === 0);
  assert.ok(cheap.length === 3);
});

test('an impossible budget is reported, not hidden', () => {
  const q = quote({ ...base, monthlyBudget: 1 });
  assert.ok(q.options.length > 0);
  assert.ok(q.options[0]!.overBudgetBy > 0);
});

test('a heavy app gets a bigger server', () => {
  assert.equal(sizeFor({ monthlyUsers: 100_000, needsDatabase: true }).ramGb, 16);
  for (const o of quote({ ...base, monthlyUsers: 100_000, monthlyBudget: 500 }).options) assert.match(o.specs, /^8 vCPU/);
});

test('savings are worked out against the current bill', () => {
  const q = quote({ ...base, currentMonthlySpend: 60 });
  assert.ok(q.yearlySaving! > 500);
});

test('the index is sorted and has real rows', () => {
  const { rows } = cloudIndex();
  assert.ok(rows.length > 20);
  assert.ok(rows[0]!.monthlyEur <= rows[1]!.monthlyEur);
});
