import { useEffect, useMemo, useState } from 'react';
import { go } from '../App';
import { api, type CloudIndex, type Quote, type QuoteOption } from '../api';
import { ErrorNote, Section, Toggle, euro } from '../ui';

export function QuotePage() {
  const [users, setUsers] = useState(2000);
  const [budget, setBudget] = useState(20);
  const [traffic, setTraffic] = useState(0.2);
  const [current, setCurrent] = useState('');
  const [db, setDb] = useState(true);
  const [eu, setEu] = useState(true);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .quote({ monthlyUsers: users, monthlyBudget: budget, egressTb: traffic, needsDatabase: db, euOnly: eu, currentMonthlySpend: current ? Number(current) : undefined })
        .then((q) => {
          setQuote(q);
          setError('');
        })
        .catch((err: Error) => setError(err.message));
    }, 200);
    return () => clearTimeout(timer);
  }, [users, budget, traffic, db, eu, current]);

  return (
    <>
      <div className="hero compact">
        <span className="eyebrow">Placement quote</span>
        <h1>Tell us your budget. We'll find where your app should live.</h1>
        <p>The same server can cost €5.50 or €113 a month, depending on who you rent it from. We compare them for you, traffic and backups included.</p>
      </div>

      <div className="quote-grid">
        <form className="panel controls" onSubmit={(e) => e.preventDefault()}>
          <label>
            <span>Monthly budget</span>
            <div className="with-unit"><i>€</i><input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></div>
          </label>
          <label>
            <span>Users a month</span>
            <input type="number" min={0} step={500} value={users} onChange={(e) => setUsers(Number(e.target.value))} />
          </label>
          <label>
            <span>Traffic a month</span>
            <div className="with-unit"><input type="number" min={0} step={0.1} value={traffic} onChange={(e) => setTraffic(Number(e.target.value))} /><i>TB</i></div>
          </label>
          <label>
            <span>What you pay today (optional)</span>
            <div className="with-unit"><i>€</i><input type="number" min={0} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="0" /></div>
          </label>
          <Toggle checked={db} onChange={setDb}>My app has its own database</Toggle>
          <Toggle checked={eu} onChange={setEu}>European companies only</Toggle>
        </form>

        <div>
          <ErrorNote message={error} />
          {quote && (
            <>
              <p className="need">{quote.need.why}</p>
              {quote.yearlySaving ? <p className="saving">That's about <b>{euro(quote.yearlySaving)}</b> a year less than you pay now.</p> : null}
              <div className="options">
                {quote.options.map((o) => <OptionCard key={o.providerId} option={o} />)}
              </div>
              <p className="fine">Reference prices from {quote.asOf}, excluding tax. {quote.note}</p>
            </>
          )}
        </div>
      </div>

      <IndexTable />
    </>
  );
}

function OptionCard({ option: o }: { option: QuoteOption }) {
  const recommended = o.label === 'Balanced';
  return (
    <article className={`option${recommended ? ' recommended' : ''}`}>
      <header>
        <span className="eyebrow">{recommended ? 'Balanced · our pick' : o.label}</span>
        <h3>{o.provider}</h3>
        <p className="spec">{o.plan}, {o.specs}</p>
        <p className="spec">{o.region}</p>
      </header>
      <p className="price">{euro(o.monthly.total)}<small>/month</small></p>
      {o.overBudgetBy > 0 && <p className="over">{euro(o.overBudgetBy)} over your budget</p>}
      <dl className="breakdown">
        <div><dt>Server</dt><dd>{euro(o.monthly.compute)}</dd></div>
        <div><dt>Traffic</dt><dd>{euro(o.monthly.egress)}</dd></div>
        <div><dt>Backups</dt><dd>{euro(o.monthly.backups)}</dd></div>
      </dl>
      <ul className="reasons">{o.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      {o.warning && <p className="caution">{o.warning}</p>}
      <div className="option-actions">
        <button type="button" onClick={() => go('rescue')}>Move my app here</button>
        <a href={o.url} target="_blank" rel="noreferrer">See their prices</a>
      </div>
    </article>
  );
}

function IndexTable() {
  const [index, setIndex] = useState<CloudIndex | null>(null);
  const [euOnly, setEuOnly] = useState(false);

  useEffect(() => {
    api.index().then(setIndex).catch(() => setIndex(null));
  }, []);

  const rows = useMemo(() => (index?.rows ?? []).filter((r) => !euOnly || r.euHq), [index, euOnly]);
  if (!index) return null;

  return (
    <Section label="Cloud Index" title="Every plan we compare" aside={<Toggle checked={euOnly} onChange={setEuOnly}>European only</Toggle>}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Provider</th><th>Plan</th><th className="num">vCPU</th><th className="num">RAM</th><th className="num">€/month</th><th>Traffic</th><th>Based in</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.provider + r.plan}>
                <td><a href={r.url} target="_blank" rel="noreferrer">{r.provider}</a></td>
                <td><a href={r.source} target="_blank" rel="noreferrer" title="Where this price comes from">{r.plan}</a></td>
                <td className="num">{r.vcpu}</td>
                <td className="num">{r.ramGb} GB</td>
                <td className="num">{r.monthlyEur.toFixed(2)}</td>
                <td>{r.includedTb === null ? 'Included' : `${r.includedTb} TB, then €${r.egressPerTbEur}/TB`}</td>
                <td>{r.hq}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">Prices come from each provider's own pricing page or API, checked {index.asOf}. Click a plan to see its source. Hetzner is read live.</p>
    </Section>
  );
}
