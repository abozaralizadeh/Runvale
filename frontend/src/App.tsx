import { useEffect, useState } from 'react';
import { BRAND } from './api';
import { QuotePage } from './pages/QuotePage';
import { RescuePage } from './pages/RescuePage';
import { ScanPage } from './pages/ScanPage';
import { WatchPage } from './pages/WatchPage';

const PAGES = [
  { id: 'scan', label: 'Scan', hint: 'Is it safe?' },
  { id: 'quote', label: 'Quote', hint: 'Where should it live?' },
  { id: 'rescue', label: 'Rescue', hint: 'Move it' },
  { id: 'watch', label: 'Watch', hint: 'Keep it running' },
] as const;

export interface Route {
  page: string;
  params: URLSearchParams;
}

function readRoute(): Route {
  const [path = '', query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { page: PAGES.some((p) => p.id === path) ? path : 'scan', params: new URLSearchParams(query) };
}

export const go = (page: string, params: Record<string, string> = {}) => {
  const query = new URLSearchParams(params).toString();
  window.location.hash = `/${page}${query ? `?${query}` : ''}`;
};

export function App() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const update = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return (
    <>
      <header className="top">
        <a className="brand" href="#/scan">
          <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 7 16 22 27 7" /><circle cx="16" cy="14" r="2.6" /></svg>
          {BRAND}
        </a>
        <nav aria-label="Main">
          {PAGES.map((p, i) => (
            <a key={p.id} href={`#/${p.id}`} aria-current={route.page === p.id ? 'page' : undefined}>
              <span className="step">{i + 1}</span>
              <span>{p.label}</span>
              <small>{p.hint}</small>
            </a>
          ))}
        </nav>
      </header>
      <main key={`${route.page}?${route.params}`}>
        {route.page === 'scan' && <ScanPage params={route.params} />}
        {route.page === 'quote' && <QuotePage />}
        {route.page === 'rescue' && <RescuePage params={route.params} />}
        {route.page === 'watch' && <WatchPage params={route.params} />}
      </main>
      <footer className="bottom">
        <p>Free beta, no account needed. Results can miss things, so treat them as help and not a guarantee.</p>
        <p>The scanner only reads what any visitor can see, unless you prove a site is yours. We don't keep scan results.</p>
      </footer>
    </>
  );
}
