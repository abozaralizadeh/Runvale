import { useEffect, useRef, useState, type FormEvent } from 'react';
import { go } from '../App';
import { api, type ScanReport } from '../api';
import { CopyButton, ErrorNote, Findings, Grade, Passed, Section } from '../ui';

const GRADE_LINE: Record<string, string> = {
  A: 'This looks well protected.',
  B: 'Good, with a few things to tidy up.',
  C: 'Some real gaps. Worth fixing soon.',
  D: "It's exposed. Fix this before you get more users.",
  F: "Don't ignore this. Someone could get in, or already has.",
};

export function ScanPage({ params }: { params: URLSearchParams }) {
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [report, setReport] = useState<ScanReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  const run = async (target: string) => {
    setBusy(true);
    setError('');
    try {
      setReport(await api.scan(target));
    } catch (err) {
      setReport(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (url && !started.current) {
      started.current = true;
      void run(url);
    }
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) void run(url.trim());
  };

  return (
    <>
      <div className="hero">
        <span className="eyebrow">Free security check</span>
        <h1>Built it with AI? Find out what's exposed before someone else does.</h1>
        <p>Paste your app's address. We read what any visitor can see: leaked keys, missing protections, weak settings. Then we tell you how to fix it in plain words.</p>
        <form className="bar" onSubmit={submit}>
          <label className="sr" htmlFor="scan-url">Your app's address</label>
          <input id="scan-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="yourapp.lovable.app" autoComplete="off" spellCheck={false} />
          <button disabled={busy || !url.trim()}>{busy ? 'Checking…' : 'Check it'}</button>
        </form>
        <ErrorNote message={error} />
        {busy && <p className="working" role="status">Reading your site and its code. This takes about 20 seconds.</p>}
      </div>

      {report && <Report report={report} rerun={() => void run(report.url)} busy={busy} />}

      {!report && !busy && (
        <ol className="path">
          <li><strong>Scan</strong> your live app for leaks and weak settings.</li>
          <li><strong>Quote</strong> the cheapest good cloud for your budget.</li>
          <li><strong>Rescue</strong> it from your repo: a hardened server, ready to deploy.</li>
          <li><strong>Watch</strong> it, with uptime and security checks every day.</li>
        </ol>
      )}
    </>
  );
}

function Report({ report, rerun, busy }: { report: ScanReport; rerun: () => void; busy: boolean }) {
  const counts = report.findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
  const { host, framework, backend } = report.platform;
  const facts = [
    ['Hosted on', host ?? 'Not sure'],
    ['Built with', framework ?? 'Not sure'],
    ['Database', backend ?? 'None seen'],
    ['Certificate', report.tls ? (report.tls.valid ? `${report.tls.daysLeft} days left` : 'Not trusted') : 'None'],
    ['Files read', String(report.stats.scripts + 1)],
  ];

  return (
    <div className="report">
      <div className="title-block">
        <Grade grade={report.grade} />
        <div className="title-main">
          <span className="eyebrow">Security report</span>
          <h2>{new URL(report.finalUrl).hostname}</h2>
          <p>{GRADE_LINE[report.grade]}</p>
          <div className="tally">
            {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
              <span key={s} className={`count sev-${s}`}><b>{counts[s] ?? 0}</b> {s}</span>
            ))}
          </div>
        </div>
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </div>

      <div className="actions">
        {report.fixPrompt && <CopyButton text={report.fixPrompt} label="Copy a prompt that fixes this" />}
        <button type="button" className="ghost" onClick={() => go('watch', { url: report.finalUrl })}>Watch this app</button>
        <button type="button" className="ghost" onClick={() => go('rescue')}>Move it somewhere safer</button>
      </div>

      <Section label="Findings" title={report.findings.length ? 'What to fix, worst first' : 'Nothing found'}>
        <Findings findings={report.findings} />
      </Section>

      {report.passed.length > 0 && (
        <Section label="Passed" title="What's already fine">
          <Passed items={report.passed} />
        </Section>
      )}

      <Section label="Go deeper" title={report.owner.verified ? "You've proved this site is yours" : 'Is this your site? Unlock the deeper checks'}>
        {report.owner.verified ? (
          <p className="prose">We also ran: {report.owner.checksRun.join(', ')}.</p>
        ) : (
          <div className="prose">
            <p>We also look for public <code>.env</code> and <code>.git</code> files and test whether anyone can read your Supabase tables. We only do that on sites you control. To prove it, publish this text at <code>/.well-known/airchitect-verify.txt</code>, or anywhere in your homepage's HTML:</p>
            <div className="token"><code>{report.owner.token}</code><CopyButton text={report.owner.token} label="Copy" /></div>
            <button type="button" className="ghost" disabled={busy} onClick={rerun}>{busy ? 'Checking…' : "I've added it, check again"}</button>
          </div>
        )}
      </Section>
    </div>
  );
}
