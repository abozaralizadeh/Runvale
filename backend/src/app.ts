import fs from 'node:fs';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { createServer, preflight, ProviderError } from './hetzner.js';
import { cloudInit, generateKit } from './kit.js';
import { logger } from './log.js';
import { BlockedTargetError } from './net.js';
import { cloudIndex, quote } from './placement.js';
import { RepoError } from './repo.js';
import { rescue } from './rescue.js';
import { scanUrl } from './scanner.js';
import { addWatch, listWatches, removeWatch, WatchError } from './watch.js';

const MAX_USER_DATA_BYTES = 32_000;
const MAX_CONCURRENT_JOBS = 4;

const QuoteBody = z.object({
  monthlyUsers: z.number().int().min(0).max(100_000_000).default(2_000),
  needsDatabase: z.boolean().default(false),
  monthlyBudget: z.number().min(0).max(100_000).default(20),
  euOnly: z.boolean().default(false),
  egressTb: z.number().min(0).max(10_000).default(0.2),
  storageGb: z.number().min(0).max(100_000).default(10),
  currentMonthlySpend: z.number().min(0).max(1_000_000).optional(),
});

const Domain = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, "That doesn't look like a domain name");
const SshKey = z.string().trim().regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [^\r\n]*)?$/, "That doesn't look like an SSH public key");

const RescueBody = z.object({
  repoUrl: z.string().min(1).max(300),
  domain: Domain.optional(),
  monthlyUsers: z.number().int().min(0).optional(),
  monthlyBudget: z.number().min(0).optional(),
  euOnly: z.boolean().optional(),
  egressTb: z.number().min(0).optional(),
  storageGb: z.number().min(0).optional(),
  currentMonthlySpend: z.number().min(0).optional(),
});

const Token = z.string().trim().min(20).max(200);

const DeployBody = z.object({
  token: Token,
  repoUrl: z.string().min(1).max(300),
  serverType: z.string().regex(/^[a-z0-9-]+$/),
  location: z.string().regex(/^[a-z0-9-]+$/),
  sshPublicKey: SshKey,
  domain: Domain.optional(),
  env: z.string().max(16_000).optional(),
});

const WatchBody = z.object({
  url: z.string().min(1).max(500),
  label: z.string().max(80).optional(),
  notifyUrl: z.string().max(500).optional(),
});

let jobs = 0;

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (jobs >= MAX_CONCURRENT_JOBS) throw new BusyError();
  jobs++;
  try {
    return await job();
  } finally {
    jobs--;
  }
}

class BusyError extends Error {}

function workspaceOf(req: FastifyRequest): string {
  const key = req.headers['x-workspace'];
  if (typeof key !== 'string' || key.length < 32 || key.length > 128) throw new WatchError('Missing workspace key');
  return key;
}

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger, trustProxy: config.trustProxy, bodyLimit: 256_000 });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid input' });
    if (err instanceof BlockedTargetError || err instanceof RepoError || err instanceof WatchError) {
      return reply.status(400).send({ error: err.message });
    }
    if (err instanceof ProviderError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof BusyError) return reply.status(503).send({ error: "We're busy right now. Try again in a moment." });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'Too many requests. Wait a minute and try again.' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    return reply.status(502).send({ error: "We couldn't finish that. The site or service may be unreachable." });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/index', async () => cloudIndex());

  app.post('/api/quote', async (req) => quote(QuoteBody.parse(req.body ?? {})));

  app.post('/api/scan', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { url } = z.object({ url: z.string().min(1).max(500) }).parse(req.body);
    return limited(() => scanUrl(url));
  });

  app.post('/api/rescue', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { repoUrl, ...rest } = RescueBody.parse(req.body);
    return limited(async () => {
      const { analysis, quote: placement, deployable, kit, repoUrl: resolved } = await rescue({ source: repoUrl, ...rest });
      return { analysis, quote: placement, deployable, kit, repoUrl: resolved };
    });
  });

  app.post('/api/deploy/hetzner/preflight', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = z.object({ token: Token }).parse(req.body);
    return preflight(token);
  });

  app.post('/api/deploy/hetzner', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const body = DeployBody.parse(req.body);
    return limited(async () => {
      const result = await rescue({ source: body.repoUrl, domain: body.domain, sshPublicKey: body.sshPublicKey });
      if (!result.deployable) throw new RepoError("We don't know how to run this repo yet, so nothing was created.");
      const userData = cloudInit(generateKit(result.analysis, result.options), { ...result.options, env: body.env });
      if (Buffer.byteLength(userData) > MAX_USER_DATA_BYTES) throw new RepoError('The setup file is too big for Hetzner. Trim your settings.');
      const server = await createServer(body.token, {
        name: result.analysis.name,
        serverType: body.serverType,
        location: body.location,
        sshPublicKey: body.sshPublicKey,
        userData,
      });
      req.log.info({ server: server.id, repo: result.repoUrl }, 'server created');
      return server;
    });
  });

  app.get('/api/watches', async (req) => listWatches(workspaceOf(req)));

  app.post('/api/watches', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = WatchBody.parse(req.body);
    return limited(() => addWatch(workspaceOf(req), body));
  });

  app.delete('/api/watches/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!removeWatch(workspaceOf(req), id)) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  if (fs.existsSync(config.publicDir)) {
    await app.register(fastifyStatic, { root: config.publicDir, wildcard: false });
    app.get('/*', (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
