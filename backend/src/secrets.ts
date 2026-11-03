export interface SecretHit {
  kind: string;
  severity: 'critical' | 'high' | 'medium';
  masked: string;
}

const PATTERNS: { kind: string; severity: SecretHit['severity']; re: RegExp }[] = [
  { kind: 'Stripe live secret key', severity: 'critical', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/g },
  { kind: 'AWS access key', severity: 'critical', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'OpenAI API key', severity: 'critical', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: 'Anthropic API key', severity: 'critical', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { kind: 'GitHub token', severity: 'critical', re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: 'Slack token', severity: 'critical', re: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g },
  { kind: 'SendGrid API key', severity: 'critical', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'Resend API key', severity: 'critical', re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}\b/g },
  { kind: 'Private key', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { kind: 'Database password in a connection string', severity: 'critical', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:"'`/@]+:[^\s:"'`/@${}]{3,}@[^\s"'`]+/g },
  { kind: 'Google API key', severity: 'medium', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function mask(secret: string): string {
  return secret.length <= 12 ? '••••' : `${secret.slice(0, 6)}••••${secret.slice(-2)}`;
}

export function jwtRole(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { role?: unknown; iss?: unknown };
    return typeof payload.role === 'string' ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

export function findSecrets(text: string): SecretHit[] {
  const hits = new Map<string, SecretHit>();
  for (const { kind, severity, re } of PATTERNS) {
    for (const [match] of text.matchAll(re)) hits.set(match, { kind, severity, masked: mask(match) });
  }
  for (const [token] of text.matchAll(JWT)) {
    if (jwtRole(token) === 'service_role') {
      hits.set(token, { kind: 'Supabase service_role key', severity: 'critical', masked: mask(token) });
    }
  }
  return [...hits.values()];
}

export function findSupabase(text: string): { url?: string; anonKey?: string } {
  const url = /https:\/\/[a-z0-9]{20}\.supabase\.co/.exec(text)?.[0];
  const publishable = /\bsb_publishable_[A-Za-z0-9_-]{20,}\b/.exec(text)?.[0];
  const anon = [...text.matchAll(JWT)].map((m) => m[0]).find((t) => jwtRole(t) === 'anon');
  return { url, anonKey: anon ?? publishable };
}
