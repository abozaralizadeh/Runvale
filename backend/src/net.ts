import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { config } from './config.js';

export class BlockedTargetError extends Error {}

export const USER_AGENT = 'RunvaleScanner/0.1 (passive security check)';

function parseIp(ip: string) {
  const parsed = ipaddr.parse(ip);
  return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
}

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  return parseIp(ip).range() === 'unicast';
}

// The server's own addresses and names, from SCAN_BLOCKLIST and SELF_ADDRESSES. A name also blocks its subdomains.
export function blocklist(entries: string[]) {
  const ips = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    const value = entry.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!value) continue;
    if (ipaddr.isValid(value)) ips.add(parseIp(value).toNormalizedString());
    else names.push(value);
  }
  return {
    address: (ip: string) => ipaddr.isValid(ip) && ips.has(parseIp(ip).toNormalizedString()),
    name: (host: string) => {
      const h = host.toLowerCase().replace(/\.$/, '');
      return names.some((n) => h === n || h.endsWith(`.${n}`));
    },
  };
}

const blocked = blocklist(config.blockedTargets);

// Public, and not this server. Private addresses are allowed only for tests and local runs.
function reachable(ip: string, allowPrivate: boolean) {
  return !blocked.address(ip) && (allowPrivate || isPublicAddress(ip));
}

type LookupCallback = (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;

// The check runs inside the connection itself, so a hostname can't pass the check and then
// resolve to an internal address when the socket opens (DNS rebinding).
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (addresses.some((a) => !reachable(a.address, allowPrivate))) {
        return callback(new BlockedTargetError(`${hostname} points to a private address`));
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    });
  };
}

function agentFor(allowPrivate: boolean) {
  return new Agent({ connect: { timeout: 8_000, lookup: guardedLookup(allowPrivate) } as object });
}

const publicAgent = agentFor(false);
const privateAgent = agentFor(true);

export function parseTarget(input: string, allowPrivate = config.allowPrivateTargets): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new BlockedTargetError("That doesn't look like a web address");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError('Only http and https addresses can be checked');
  }
  if (url.username || url.password) throw new BlockedTargetError('Addresses with a password in them are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (blocked.name(host) || blocked.address(host)) throw new BlockedTargetError("This server can't check itself");
  if (!allowPrivate) {
    if (url.port && url.port !== '80' && url.port !== '443') {
      throw new BlockedTargetError('Only the standard web ports (80 and 443) can be checked');
    }
    // Connections to a literal IP skip DNS, so the lookup guard never sees them.
    if (net.isIP(host) && !isPublicAddress(host)) throw new BlockedTargetError('Private addresses are not allowed');
  }
  return url;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
  redirects?: number;
  allowPrivate?: boolean;
}

export interface FetchResult {
  status: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
  hops: string[];
}

export function headerValue(headers: FetchResult['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

export async function safeFetch(input: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { maxBytes = 3_000_000, timeoutMs = 10_000, redirects = 5, allowPrivate = config.allowPrivateTargets } = options;
  const hops: string[] = [];
  let current = parseTarget(input, allowPrivate).href;

  for (let hop = 0; ; hop++) {
    const target = parseTarget(current, allowPrivate);
    const res = await request(target, {
      dispatcher: allowPrivate ? privateAgent : publicAgent,
      method: (options.method ?? 'GET') as 'GET',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...options.headers },
      body: options.body,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const location = headerValue(res.headers, 'location');
    if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects > 0) {
      await res.body.dump();
      if (hop >= redirects) throw new Error('Too many redirects');
      hops.push(target.href);
      current = new URL(location, target).href;
      continue;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk as Buffer);
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size));
        truncated = true;
        res.body.destroy();
        break;
      }
      size += buf.length;
      chunks.push(buf);
    }
    return { status: res.statusCode, url: target.href, headers: res.headers, body: Buffer.concat(chunks), truncated, hops };
  }
}

export interface TlsInfo {
  valid: boolean;
  error?: string;
  protocol?: string;
  issuer?: string;
  expiresAt?: string;
  daysLeft?: number;
}

export function readTls(hostname: string, port = 443, allowPrivate = config.allowPrivateTargets): Promise<TlsInfo | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: hostname,
      port,
      servername: net.isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: false,
      lookup: guardedLookup(allowPrivate) as never,
      timeout: 8_000,
    });
    const finish = (value: TlsInfo | null) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('error', () => finish(null));
    socket.once('timeout', () => finish(null));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const expires = cert.valid_to ? new Date(cert.valid_to) : undefined;
      finish({
        valid: socket.authorized,
        error: socket.authorizationError ? String(socket.authorizationError) : undefined,
        protocol: socket.getProtocol() ?? undefined,
        issuer: [cert.issuer?.O ?? cert.issuer?.CN].flat()[0],
        expiresAt: expires?.toISOString(),
        daysLeft: expires ? Math.floor((expires.getTime() - Date.now()) / 86_400_000) : undefined,
      });
    });
  });
}
