#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { quote } from './placement.js';
import { rescue } from './rescue.js';
import { scanUrl, type Finding } from './scanner.js';

const USAGE = `Usage:
  airchitect scan <url>                     Security check of a live site
  airchitect quote [--budget 20] [--users 2000] [--eu] [--db]
                                            Find the best-fit cloud
  airchitect rescue <folder|github-url>     Check a project and write its deploy kit
      [--out dir] [--budget 20] [--eu] [--force]

Add --json to any command for machine-readable output.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    budget: { type: 'string', default: '20' },
    users: { type: 'string', default: '2000' },
    eu: { type: 'boolean', default: false },
    db: { type: 'boolean', default: false },
    out: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

const [command, target] = positionals;

function printFindings(findings: Finding[]) {
  for (const f of findings) {
    console.log(`  [${f.severity.toUpperCase()}] ${f.title}${f.evidence ? ` (${f.evidence})` : ''}`);
    console.log(`      Fix: ${f.fix}`);
  }
}

function printQuote(q: ReturnType<typeof quote>) {
  console.log(`Need: ${q.need.why}`);
  for (const o of q.options) {
    const over = o.overBudgetBy ? `  OVER BUDGET by €${o.overBudgetBy.toFixed(2)}` : '';
    console.log(`  ${o.label.padEnd(9)} ${o.provider} ${o.plan} (${o.specs}), ${o.region}: €${o.monthly.total.toFixed(2)}/mo${over}`);
  }
  console.log(`Prices as of ${q.asOf}. Check them before you buy.`);
}

async function main() {
  if (command === 'scan' && target) {
    const report = await scanUrl(target, { allowPrivate: true });
    if (values.json) return console.log(JSON.stringify(report, null, 2));
    console.log(`Grade ${report.grade} (${report.score}/100) for ${report.finalUrl}`);
    printFindings(report.findings);
    if (!report.owner.verified) console.log(`\nFor deeper checks, publish this at /.well-known/airchitect-verify.txt:\n  ${report.owner.token}`);
    return;
  }

  if (command === 'quote') {
    const q = quote({
      monthlyUsers: Number(values.users), needsDatabase: values.db, monthlyBudget: Number(values.budget),
      euOnly: values.eu, egressTb: 0.2, storageGb: 10,
    });
    return values.json ? console.log(JSON.stringify(q, null, 2)) : printQuote(q);
  }

  if (command === 'rescue' && target) {
    const remote = /github\.com/.test(target);
    const result = await rescue({ source: target, monthlyBudget: Number(values.budget), euOnly: values.eu }, { local: !remote });
    if (values.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.analysis.name}: ${result.analysis.stackLabel}, database: ${result.analysis.database}`);
    printFindings(result.analysis.findings);
    printQuote(result.quote);
    if (!result.deployable) return console.log("\nWe don't know how to run this project yet, so no kit was written.");
    const out = path.resolve(values.out ?? (remote ? `${result.analysis.name}-kit` : target));
    if (fs.existsSync(path.join(out, 'deploy')) && !values.force) {
      throw new Error(`${path.join(out, 'deploy')} already exists. Use --force to overwrite it.`);
    }
    for (const [file, content] of Object.entries(result.kit)) {
      const full = path.join(out, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, { mode: file.endsWith('.sh') ? 0o755 : 0o644 });
    }
    return console.log(`\nKit written to ${out}. Start with deploy/RUNBOOK.md.`);
  }

  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
