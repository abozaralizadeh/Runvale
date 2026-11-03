import { strToU8, zipSync } from 'fflate';
import { useMemo, useState, type FormEvent } from 'react';
import { go } from '../App';
import { api, type DeployedServer, type HetznerOption, type RescueResult } from '../api';
import { ErrorNote, Findings, Passed, Section, Toggle, euro } from '../ui';

function downloadKit(name: string, kit: Record<string, string>) {
  const zip = zipSync(Object.fromEntries(Object.entries(kit).map(([path, text]) => [path, strToU8(text)])));
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-deploy-kit.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

export function RescuePage({ params }: { params: URLSearchParams }) {
  const [repoUrl, setRepoUrl] = useState(params.get('repo') ?? '');
  const [budget, setBudget] = useState(20);
  const [eu, setEu] = useState(true);
  const [result, setResult] = useState<RescueResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await api.rescue({ repoUrl: repoUrl.trim(), monthlyBudget: budget, euOnly: eu }));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="hero compact">
        <span className="eyebrow">Rescue & run</span>
        <h1>Give us your repo. Get a hardened server, ready to deploy.</h1>
        <p>We read your code, flag what's unsafe, and write everything needed to run it on any cloud: container, HTTPS, firewall, backups. It's all plain files you own.</p>
        <form className="bar" onSubmit={submit}>
          <label className="sr" htmlFor="repo-url">GitHub address</label>
          <input id="repo-url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/you/your-app" autoComplete="off" spellCheck={false} />
          <button disabled={busy || !repoUrl.trim()}>{busy ? 'Reading…' : 'Rescue it'}</button>
        </form>
        <div className="bar-options">
          <label className="inline">Budget <span className="with-unit small"><i>€</i><input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></span> a month</label>
          <Toggle checked={eu} onChange={setEu}>European companies only</Toggle>
        </div>
        <ErrorNote message={error} />
        {busy && <p className="working" role="status">Downloading your repo and reading the code.</p>}
      </div>
      {result && <Result result={result} />}
    </>
  );
}

function Result({ result }: { result: RescueResult }) {
  const { analysis: a, kit, quote, deployable } = result;
  const files = Object.keys(kit);
  const [open, setOpen] = useState(files.find((f) => f.endsWith('RUNBOOK.md')) ?? files[0] ?? '');
  const best = quote.options[1] ?? quote.options[0];

  return (
    <div className="report">
      <div className="title-block slim">
        <div className="title-main">
          <span className="eyebrow">Project report</span>
          <h2>{a.name}</h2>
          <p>{deployable ? "We know how to run this." : "We can't run this one yet: we didn't recognise the setup."}</p>
        </div>
        <dl className="facts">
          <div><dt>Stack</dt><dd>{a.stackLabel}</dd></div>
          <div><dt>Database</dt><dd>{a.database === 'none' ? 'None seen' : a.database}</dd></div>
          <div><dt>Settings needed</dt><dd>{a.envVars.length}</dd></div>
          <div><dt>Files read</dt><dd>{a.fileCount}</dd></div>
          {best && <div><dt>Best fit</dt><dd>{best.provider}, {euro(best.monthly.total)}/mo</dd></div>}
        </dl>
      </div>

      <Section label="Code check" title={a.findings.length ? 'Fix these before you go live' : 'No problems found'}>
        <Findings findings={a.findings} />
        <Passed items={a.passed} />
      </Section>

      {deployable && (
        <>
          <Section
            label="Deploy kit"
            title="Your files"
            aside={<button type="button" onClick={() => downloadKit(a.name, kit)}>Download the kit</button>}
          >
            <div className="kit">
              <ul role="tablist" aria-label="Kit files">
                {files.map((f) => (
                  <li key={f}><button type="button" role="tab" aria-selected={open === f} onClick={() => setOpen(f)}>{f}</button></li>
                ))}
              </ul>
              <pre tabIndex={0}><code>{kit[open]}</code></pre>
            </div>
          </Section>

          <Section label="Deploy" title="Put it online">
            <div className="deploy-grid">
              <div className="prose">
                <h4>Any cloud</h4>
                <ol>
                  <li>Create an Ubuntu 24.04 server with 2 GB of RAM or more.</li>
                  <li>Paste <code>deploy/cloud-init.yaml</code> into its "user data" box.</li>
                  <li>Wait about 5 minutes. It's online at <code>https://your-ip.sslip.io</code>, with HTTPS.</li>
                </ol>
                <p className="fine">Add your SSH key to the file first, or you won't be able to log in. The one-click route below does it for you.</p>
              </div>
              {result.repoUrl && <HetznerDeploy repoUrl={result.repoUrl} envVars={a.envVars} />}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function HetznerDeploy({ repoUrl, envVars }: { repoUrl: string; envVars: string[] }) {
  const [token, setToken] = useState('');
  const [options, setOptions] = useState<HetznerOption[] | null>(null);
  const [choice, setChoice] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [domain, setDomain] = useState('');
  const [env, setEnv] = useState(envVars.map((v) => `${v}=`).join('\n'));
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [server, setServer] = useState<DeployedServer | null>(null);

  const selected = useMemo(() => options?.find((o) => `${o.name}@${o.location}` === choice), [options, choice]);

  const check = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.preflight(token.trim());
      setOptions(res.options);
      const first = res.options.find((o) => o.available !== false);
      setChoice(first ? `${first.name}@${first.location}` : '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deploy = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.deploy({
        token: token.trim(), repoUrl, serverType: selected.name, location: selected.location,
        sshPublicKey: sshKey.trim(), domain: domain.trim() || undefined, env: env.trim() ? `${env.trim()}\n` : undefined,
      });
      setServer(created);
      setToken('');
      const url = domain.trim() ? `https://${domain.trim()}` : created.siteUrl;
      if (url) await api.addWatch({ url, label: created.name }).catch(() => undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (server) {
    const url = domain.trim() ? `https://${domain.trim()}` : server.siteUrl;
    return (
      <div className="panel deployed">
        <span className="eyebrow">Server created</span>
        <h4>{server.name}</h4>
        <p>Your server is starting. It installs everything, then builds your app, which can take 5 to 10 minutes.</p>
        {url && <p>It will appear at <a href={url} target="_blank" rel="noreferrer">{url}</a></p>}
        {server.ip && <p>Log in with <code>ssh deploy@{server.ip}</code></p>}
        <button type="button" className="ghost" onClick={() => go('watch')}>See it in Watch</button>
      </div>
    );
  }

  return (
    <form className="panel deploy-form" onSubmit={deploy}>
      <h4>One click on Hetzner</h4>
      <p className="fine">Uses your own Hetzner account, so the bill and the server stay yours. Your token is used for this request and never saved.</p>
      <label>
        <span>Hetzner API token (Read & Write)</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      </label>
      {!options && <button type="button" className="ghost" disabled={busy || token.trim().length < 20} onClick={() => void check()}>{busy ? 'Checking…' : 'See real prices and stock'}</button>}
      {options && (
        <>
          <label>
            <span>Server</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {options.map((o) => (
                <option key={`${o.name}@${o.location}`} value={`${o.name}@${o.location}`} disabled={o.available === false}>
                  {o.name} in {o.location}: {o.vcpu} vCPU, {o.ramGb} GB, {euro(o.monthlyNet)}/mo{o.available === false ? ' (out of stock)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Your SSH public key</span>
            <textarea rows={2} value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="ssh-ed25519 AAAA…" spellCheck={false} />
          </label>
          <label>
            <span>Your domain (optional)</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" spellCheck={false} />
          </label>
          {envVars.length > 0 && (
            <label>
              <span>App settings</span>
              <textarea rows={Math.min(envVars.length + 1, 8)} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
            </label>
          )}
          {selected && (
            <>
              <label className="toggle">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>Create this server on my Hetzner account. It costs {euro(selected.monthlyNet)} a month before tax until I delete it.</span>
              </label>
              <button disabled={busy || !agreed || !sshKey.trim()}>{busy ? 'Creating…' : 'Create server and deploy'}</button>
            </>
          )}
        </>
      )}
      <ErrorNote message={error} />
    </form>
  );
}
