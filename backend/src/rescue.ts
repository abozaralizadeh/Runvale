import { generateKit, type KitOptions } from './kit.js';
import { quote, type QuoteInput } from './placement.js';
import { analyze, checkDependencies, loadDir, loadGithub, type RepoFiles } from './repo.js';

export interface RescueInput extends Partial<Omit<QuoteInput, 'needsDatabase'>> {
  source: string;
  domain?: string;
  sshPublicKey?: string;
}

async function loadSource(source: string, local: boolean): Promise<{ files: RepoFiles; name: string; repoUrl?: string; ref?: string }> {
  return local ? loadDir(source) : loadGithub(source);
}

// `local` reads a folder on disk, so only the CLI and MCP server may set it. Never the web API.
export async function rescue(input: RescueInput, { local = false } = {}) {
  const { files, name, repoUrl, ref } = await loadSource(input.source, local);
  const analysis = analyze(files, name);
  await checkDependencies(analysis);

  const placement = quote({
    monthlyUsers: input.monthlyUsers ?? 2_000,
    needsDatabase: analysis.needsPostgres,
    monthlyBudget: input.monthlyBudget ?? 20,
    euOnly: input.euOnly ?? false,
    egressTb: input.egressTb ?? 0.2,
    storageGb: input.storageGb ?? 10,
    currentMonthlySpend: input.currentMonthlySpend,
  });

  const pick = placement.options[1] ?? placement.options[0];
  const options: KitOptions = {
    repoUrl,
    ref,
    domain: input.domain,
    sshPublicKey: input.sshPublicKey,
    monthlyBudget: input.monthlyBudget,
    euOnly: input.euOnly,
    provider: pick?.providerId,
    plan: pick?.plan,
  };
  const deployable = analysis.stack !== 'unknown';
  return { analysis, quote: placement, deployable, repoUrl, ref, kit: deployable ? generateKit(analysis, options) : {}, options };
}
