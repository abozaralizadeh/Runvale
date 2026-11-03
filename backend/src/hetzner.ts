import crypto from 'node:crypto';
import { config } from './config.js';

export class ProviderError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

async function api<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.hetznerApi}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ProviderError("We couldn't reach Hetzner. Try again in a minute.");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
  if (res.status === 401) throw new ProviderError("Hetzner rejected that token. Check it has Read & Write access.", 400);
  if (!res.ok) {
    const code = data.error?.code;
    if (code === 'resource_unavailable') throw new ProviderError('Hetzner has no stock of that server right now. Pick another size or location.', 409);
    throw new ProviderError(`Hetzner said: ${data.error?.message ?? res.status}`, res.status >= 500 ? 502 : 400);
  }
  return data;
}

interface ServerType {
  name: string;
  cores: number;
  memory: number;
  disk: number;
  architecture: string;
  deprecated?: boolean | null;
  deprecation?: unknown;
  prices: { location: string; price_monthly: { net: string; gross: string } }[];
}

export interface HetznerOption {
  name: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  location: string;
  monthlyNet: number;
  available: boolean | null;
}

// Real prices and stock for this account, so nobody sees a price we made up at the moment they pay.
export async function preflight(token: string): Promise<{ options: HetznerOption[] }> {
  const [types, datacenters] = await Promise.all([
    api<{ server_types: ServerType[] }>(token, '/server_types?per_page=50'),
    api<{ datacenters?: { location: { name: string }; server_types?: { available?: number[] } }[] }>(token, '/datacenters?per_page=50').catch(() => ({ datacenters: undefined })),
  ]);
  const idByName = new Map(types.server_types.map((t) => [t.name, (t as ServerType & { id?: number }).id]));
  const stock = new Map<string, Set<number>>();
  for (const dc of datacenters.datacenters ?? []) {
    const set = stock.get(dc.location.name) ?? new Set<number>();
    for (const id of dc.server_types?.available ?? []) set.add(id);
    stock.set(dc.location.name, set);
  }

  const options: HetznerOption[] = [];
  for (const type of types.server_types) {
    if (type.architecture !== 'x86' || type.deprecated || type.deprecation) continue;
    for (const price of type.prices) {
      const id = idByName.get(type.name);
      const set = stock.get(price.location);
      options.push({
        name: type.name, vcpu: type.cores, ramGb: type.memory, diskGb: type.disk, location: price.location,
        monthlyNet: Math.round(Number(price.price_monthly.net) * 100) / 100,
        available: set && id !== undefined ? set.has(id) : null,
      });
    }
  }
  options.sort((a, b) => a.monthlyNet - b.monthlyNet);
  return { options: options.filter((o) => o.ramGb >= 2) };
}

async function ensureSshKey(token: string, publicKey: string): Promise<number> {
  const body = publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
  const { ssh_keys } = await api<{ ssh_keys: { id: number; public_key: string }[] }>(token, '/ssh_keys?per_page=50');
  const existing = ssh_keys.find((k) => k.public_key.trim().split(/\s+/).slice(0, 2).join(' ') === body);
  if (existing) return existing.id;
  const name = `airchitect-${crypto.randomBytes(3).toString('hex')}`;
  const { ssh_key } = await api<{ ssh_key: { id: number } }>(token, '/ssh_keys', { method: 'POST', body: { name, public_key: publicKey.trim() } });
  return ssh_key.id;
}

export interface CreateServer {
  name: string;
  serverType: string;
  location: string;
  sshPublicKey: string;
  userData: string;
}

export async function createServer(token: string, input: CreateServer) {
  const keyId = await ensureSshKey(token, input.sshPublicKey);
  const name = `${input.name}-${crypto.randomBytes(2).toString('hex')}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  const { server } = await api<{ server: { id: number; name: string; status: string; public_net: { ipv4?: { ip: string } } } }>(token, '/servers', {
    method: 'POST',
    body: {
      name,
      server_type: input.serverType,
      location: input.location,
      image: 'ubuntu-24.04',
      ssh_keys: [keyId],
      user_data: input.userData,
      labels: { managed_by: 'airchitect' },
    },
  });
  const ip = server.public_net.ipv4?.ip;
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    ip,
    siteUrl: ip ? `https://${ip.replaceAll('.', '-')}.sslip.io` : undefined,
  };
}
