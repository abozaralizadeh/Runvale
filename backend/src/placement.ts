import fs from 'node:fs';

interface Provider {
  name: string;
  hq: string;
  euHq: boolean;
  euRegion: string;
  egress: { includedTb: number | null; overPerTb: number; currency: string };
  reliability: number;
  ops: number;
  stability: number;
  deploy: 'api' | 'paste';
  url: string;
  warning?: string;
}

interface Plan {
  provider: string;
  plan: string;
  vcpu: number;
  ramGb: number;
  price: number;
  currency: string;
  apiName?: string;
  source: string;
}

interface Catalog {
  asOf: string;
  source: string;
  usdToEur: number;
  note: string;
  providers: Record<string, Provider>;
  plans: Plan[];
}

export const catalog = JSON.parse(fs.readFileSync(new URL('../data/providers.json', import.meta.url), 'utf8')) as Catalog;

const toEur = (amount: number, currency: string) => (currency === 'USD' ? amount * catalog.usdToEur : amount);
const round = (n: number) => Math.round(n * 100) / 100;

export interface QuoteInput {
  monthlyUsers: number;
  needsDatabase: boolean;
  monthlyBudget: number;
  euOnly: boolean;
  egressTb: number;
  storageGb: number;
  currentMonthlySpend?: number;
}

export interface QuoteOption {
  label: 'Budget' | 'Balanced' | 'Premium';
  providerId: string;
  provider: string;
  plan: string;
  apiName?: string;
  specs: string;
  region: string;
  hq: string;
  monthly: { compute: number; egress: number; backups: number; total: number };
  overBudgetBy: number;
  score: number;
  deploy: 'api' | 'paste';
  url: string;
  reasons: string[];
  warning?: string;
}

export interface Quote {
  need: { vcpu: number; ramGb: number; why: string };
  options: QuoteOption[];
  excluded: number;
  yearlySaving?: number;
  asOf: string;
  note: string;
}

export function sizeFor(input: Pick<QuoteInput, 'monthlyUsers' | 'needsDatabase'>) {
  const { monthlyUsers: users, needsDatabase: db } = input;
  if (users <= 5_000) return { vcpu: 1, ramGb: db ? 4 : 2, why: `Up to 5,000 users a month fits a small server${db ? ', with room for the database on the same box' : ''}.` };
  if (users <= 50_000) return { vcpu: 2, ramGb: 8, why: 'Up to 50,000 users a month needs a mid-size server.' };
  return { vcpu: 8, ramGb: 16, why: 'Above 50,000 users a month, plan for a large server. Consider moving the database off it.' };
}

function cost(plan: Plan, provider: Provider, input: QuoteInput) {
  const compute = toEur(plan.price, plan.currency);
  const { includedTb, overPerTb, currency } = provider.egress;
  const billableTb = includedTb === null ? 0 : Math.max(0, input.egressTb - includedTb);
  const egress = toEur(billableTb * overPerTb, currency);
  // Off-site backups go to a different provider, priced like Cloudflare R2 ($0.015 per GB).
  const backups = toEur(Math.max(input.storageGb, 10) * 0.015, 'USD');
  return { compute: round(compute), egress: round(egress), backups: round(backups), total: round(compute + egress + backups) };
}

export function quote(input: QuoteInput): Quote {
  const need = sizeFor(input);
  const entries = catalog.plans
    .map((plan) => ({ id: plan.provider, plan, provider: catalog.providers[plan.provider]! }))
    .filter(({ plan, provider }) => plan.vcpu >= need.vcpu && plan.ramGb >= need.ramGb && (!input.euOnly || provider.euHq));

  // Keep only each provider's smallest plan that fits, so the options are real alternatives.
  const best = new Map<string, (typeof entries)[number] & { monthly: ReturnType<typeof cost> }>();
  for (const entry of entries) {
    const monthly = cost(entry.plan, entry.provider, input);
    const current = best.get(entry.id);
    if (!current || monthly.total < current.monthly.total) best.set(entry.id, { ...entry, monthly });
  }
  const candidates = [...best.values()];
  const cheapest = Math.min(...candidates.map((c) => c.monthly.total));
  const scored = candidates.map((c) => ({
    ...c,
    // Trust matters, but on a €10 budget a €100 server isn't "better": price dominates.
    score: Math.round(
      100 * (0.5 * (cheapest / c.monthly.total) + 0.2 * (c.provider.reliability / 5) + 0.15 * (c.provider.ops / 5) + 0.15 * (c.provider.stability / 5)),
    ),
  }));

  const inBudget = scored.filter((c) => c.monthly.total <= input.monthlyBudget);
  const pool = inBudget.length ? inBudget : scored;
  const byPrice = [...pool].sort((a, b) => a.monthly.total - b.monthly.total);
  const byScore = [...pool].sort((a, b) => b.score - a.score);
  const trust = (p: Provider) => p.reliability + p.ops + p.stability;

  const chosen: { label: QuoteOption['label']; entry: (typeof scored)[number] }[] = [];
  const take = (label: QuoteOption['label'], list: typeof scored) => {
    const entry = list.find((e) => !chosen.some((c) => c.entry.id === e.id));
    if (entry) chosen.push({ label, entry });
  };
  take('Budget', byPrice);
  take('Balanced', byScore);

  // Premium has to be a real step up, even if that means showing something above the budget.
  const floor = Math.max(...chosen.map((c) => trust(c.entry.provider)));
  take('Premium', scored.filter((e) => trust(e.provider) > floor).sort((a, b) => a.monthly.total - b.monthly.total));

  const options = chosen
    .sort((a, b) => ['Budget', 'Balanced', 'Premium'].indexOf(a.label) - ['Budget', 'Balanced', 'Premium'].indexOf(b.label))
    .map(({ label, entry }): QuoteOption => {
      const { plan, provider, monthly } = entry;
      const reasons: string[] = [];
      if (label === 'Budget') reasons.push('The cheapest option that fits your app.');
      if (label === 'Balanced') reasons.push('Best mix of price, reliability and how easy it is to run.');
      if (label === 'Premium') reasons.push('A step up in reliability and tooling.');
      if (provider.egress.includedTb === null) reasons.push('Traffic is included in the price.');
      else if (monthly.egress > 0) reasons.push(`Your traffic adds €${monthly.egress.toFixed(2)} a month.`);
      if (provider.euHq) reasons.push(`European company (${provider.hq}), so your data stays under EU law.`);
      return {
        label,
        providerId: entry.id,
        provider: provider.name,
        plan: plan.plan,
        apiName: plan.apiName,
        specs: `${plan.vcpu} vCPU, ${plan.ramGb} GB RAM`,
        region: provider.euRegion,
        hq: provider.hq,
        monthly,
        overBudgetBy: round(Math.max(0, monthly.total - input.monthlyBudget)),
        score: entry.score,
        deploy: provider.deploy,
        url: provider.url,
        reasons,
        warning: provider.warning,
      };
    });

  const budget = options[0];
  const yearlySaving =
    input.currentMonthlySpend && budget ? round(Math.max(0, input.currentMonthlySpend - budget.monthly.total) * 12) : undefined;

  return { need, options, excluded: catalog.plans.length - entries.length, yearlySaving, asOf: catalog.asOf, note: catalog.note };
}

export function cloudIndex() {
  return {
    asOf: catalog.asOf,
    source: catalog.source,
    note: catalog.note,
    rows: catalog.plans
      .map((plan) => {
        const provider = catalog.providers[plan.provider]!;
        return {
          provider: provider.name,
          plan: plan.plan,
          vcpu: plan.vcpu,
          ramGb: plan.ramGb,
          monthlyEur: round(toEur(plan.price, plan.currency)),
          egressPerTbEur: provider.egress.includedTb === null ? 0 : round(toEur(provider.egress.overPerTb, provider.egress.currency)),
          includedTb: provider.egress.includedTb,
          hq: provider.hq,
          euHq: provider.euHq,
          url: provider.url,
          source: plan.source,
        };
      })
      .sort((a, b) => a.monthlyEur - b.monthlyEur),
  };
}
