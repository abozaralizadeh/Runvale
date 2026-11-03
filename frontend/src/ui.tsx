import { useState, type ReactNode } from 'react';
import type { Finding, Severity } from './api';

export const euro = (n: number) => `€${n.toFixed(2)}`;

const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Note' };

export function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <p className="empty">Nothing to fix here.</p>;
  return (
    <ul className="findings">
      {findings.map((f) => (
        <li key={f.id + (f.evidence ?? '')} className={`finding sev-${f.severity}`}>
          <span className="sev-tag">{SEVERITY_LABEL[f.severity]}</span>
          <div>
            <h4>{f.title}</h4>
            <p>{f.why}</p>
            <p className="fix"><strong>Fix:</strong> {f.fix}</p>
            {f.evidence && <code className="evidence">{f.evidence}</code>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Passed({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="passed">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return message ? <p className="error" role="alert">{message}</p> : null;
}

export function Grade({ grade }: { grade: string }) {
  return <div className={`grade grade-${grade}`} aria-label={`Grade ${grade}`}>{grade}</div>;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Section({ label, title, children, aside }: { label: string; title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="block">
      <header className="block-head">
        <div>
          <span className="eyebrow">{label}</span>
          <h3>{title}</h3>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
