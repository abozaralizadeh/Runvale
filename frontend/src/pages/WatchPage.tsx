import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, setWorkspaceKey, workspaceKey, type Watch } from '../api';
import { CopyButton, ErrorNote, Section } from '../ui';

const STATUS_LABEL: Record<string, string> = { up: 'Up', down: 'Down', pending: 'Checking' };
const REFRESH_MS = 30_000;

export function WatchPage({ params }: { params: URLSearchParams }) {
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [notifyUrl, setNotifyUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keyInput, setKeyInput] = useState('');

  const load = useCallback(() => {
    api.watches().then(setWatches).catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.addWatch({ url: url.trim(), notifyUrl: notifyUrl.trim() || undefined });
      setUrl('');
      setNotifyUrl('');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.removeWatch(id).catch((err: Error) => setError(err.message));
    load();
  };

  return (
    <>
      <div className="hero compact">
        <span className="eyebrow">Watch</span>
        <h1>Know when your app breaks before your customers tell you.</h1>
        <p>We check every app every 5 minutes, watch its certificate, and rerun the security scan each day. No account: your list is tied to this browser.</p>
        <form className="bar" onSubmit={add}>
          <label className="sr" htmlFor="watch-url">App address</label>
          <input id="watch-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="yourapp.com" autoComplete="off" spellCheck={false} />
          <button disabled={busy || !url.trim()}>{busy ? 'Adding…' : 'Watch it'}</button>
        </form>
        <label className="hook">
          <span>Slack or Discord webhook for alerts (optional)</span>
          <input value={notifyUrl} onChange={(e) => setNotifyUrl(e.target.value)} placeholder="https://hooks.slack.com/…" spellCheck={false} />
        </label>
        <ErrorNote message={error} />
      </div>

      {watches && watches.length === 0 && <p className="empty big">Nothing watched yet. Add your first app above.</p>}

      <div className="watch-list">
        {watches?.map((w) => (
          <article key={w.id} className={`watch status-${w.status}`}>
            <header>
              <span className="dot" aria-hidden="true" />
              <div>
                <h3>{w.label}</h3>
                <a href={w.url} target="_blank" rel="noreferrer">{w.url}</a>
              </div>
              <span className="status-word">{STATUS_LABEL[w.status] ?? w.status}</span>
            </header>
            <dl className="stats">
              <div><dt>Uptime</dt><dd>{w.uptime === null ? 'n/a' : `${w.uptime}%`}</dd></div>
              <div><dt>Response</dt><dd>{w.responseMs === null ? 'n/a' : `${w.responseMs} ms`}</dd></div>
              <div><dt>Certificate</dt><dd>{w.tlsDays === null ? 'n/a' : `${w.tlsDays} days`}</dd></div>
              <div><dt>Security</dt><dd>{w.grade ?? 'n/a'}</dd></div>
            </dl>
            <ol className="events">
              {w.events.slice(0, 4).map((e) => (
                <li key={e.at + e.message}><time>{new Date(e.at).toLocaleString()}</time> {e.message}</li>
              ))}
            </ol>
            <div className="watch-actions">
              <a href={`#/scan?url=${encodeURIComponent(w.url)}`}>Full report</a>
              <button type="button" className="link" onClick={() => void remove(w.id)}>Stop watching</button>
            </div>
          </article>
        ))}
      </div>

      <Section label="Your list" title="Use it on another device">
        <div className="prose">
          <p>This key opens your list. Treat it like a password: anyone who has it can see the apps you watch.</p>
          <div className="token"><code>{workspaceKey()}</code><CopyButton text={workspaceKey()} label="Copy" /></div>
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyInput.trim().length >= 32) {
                setWorkspaceKey(keyInput.trim());
                setKeyInput('');
                load();
              }
            }}
          >
            <label className="sr" htmlFor="key-input">Paste a key</label>
            <input id="key-input" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="Paste a key from another device" spellCheck={false} />
            <button type="submit" className="ghost" disabled={keyInput.trim().length < 32}>Use this key</button>
          </form>
        </div>
      </Section>
    </>
  );
}
