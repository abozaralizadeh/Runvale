import { stringify } from 'yaml';
import type { Analysis } from './repo.js';

export interface KitOptions {
  repoUrl?: string;
  ref?: string;
  domain?: string;
  sshPublicKey?: string;
  monthlyBudget?: number;
  euOnly?: boolean;
  provider?: string;
  plan?: string;
}

export type KitFiles = Record<string, string>;

const NODE_IMAGE = 'node:24-alpine';
const INTERNAL_PORT = 8080;

const install: Record<Analysis['packageManager'], string> = {
  npm: 'if [ -f package-lock.json ]; then npm ci; else npm install; fi',
  pnpm: 'corepack enable && pnpm install --frozen-lockfile',
  yarn: 'corepack enable && yarn install --frozen-lockfile',
  bun: 'npm install -g bun && bun install --frozen-lockfile',
};

const buildArgs = (a: Analysis) => a.publicEnvVars.map((v) => `ARG ${v}\nENV ${v}=$${v}`).join('\n');

function nodeHealth(port: number) {
  return `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
}

function dockerfile(a: Analysis): string | undefined {
  const args = buildArgs(a);
  switch (a.stack) {
    case 'nextjs':
      return `FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
${args}
RUN ${install[a.packageManager]}
ENV NEXT_TELEMETRY_DISABLED=1
RUN ${a.packageManager} run build

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=${INTERNAL_PORT}
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE ${INTERNAL_PORT}
CMD ["npm", "run", "start"]
`;
    case 'vite':
      return `FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
${args}
RUN ${install[a.packageManager]}
RUN ${a.packageManager} run build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/${a.outputDir} /usr/share/nginx/html
EXPOSE ${INTERNAL_PORT}
`;
    case 'static':
      return `FROM nginxinc/nginx-unprivileged:stable-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
EXPOSE ${INTERNAL_PORT}
`;
    case 'node':
      return `FROM ${NODE_IMAGE}
WORKDIR /app
COPY . .
RUN ${install[a.packageManager]}
${a.hasBuildScript ? `RUN ${a.packageManager} run build\n` : ''}ENV NODE_ENV=production PORT=${INTERNAL_PORT}
RUN chown -R node:node /app
USER node
EXPOSE ${INTERNAL_PORT}
CMD ["npm", "run", "start"]
`;
    case 'fastapi':
    case 'flask':
    case 'django': {
      const server = a.stack === 'fastapi' ? 'uvicorn' : 'gunicorn';
      const cmd =
        a.stack === 'fastapi'
          ? `["uvicorn", "${a.pythonEntry ?? 'main:app'}", "--host", "0.0.0.0", "--port", "${INTERNAL_PORT}"]`
          : `["gunicorn", "--bind", "0.0.0.0:${INTERNAL_PORT}", "${a.pythonEntry ?? 'app:app'}"]`;
      return `FROM python:3.13-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt ${server}
RUN useradd --create-home app && chown -R app:app /app
USER app
EXPOSE ${INTERNAL_PORT}
CMD ${cmd}
`;
    }
    default:
      return undefined;
  }
}

function compose(a: Analysis, hasOwnDockerfile: boolean): string {
  const port = hasOwnDockerfile ? a.port : INTERNAL_PORT;
  const usesNode = a.stack === 'nextjs' || a.stack === 'node';
  const usesPython = ['fastapi', 'flask', 'django'].includes(a.stack);
  const healthTest = usesNode
    ? ['CMD-SHELL', nodeHealth(port)]
    : usesPython
      ? ['CMD', 'python', '-c', `import socket; socket.create_connection(('127.0.0.1', ${port}), 2)`]
      : undefined;

  const logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
  const app: Record<string, unknown> = {
    build: {
      context: '..',
      dockerfile: hasOwnDockerfile ? 'Dockerfile' : 'deploy/Dockerfile',
      ...(a.publicEnvVars.length ? { args: Object.fromEntries(a.publicEnvVars.map((v) => [v, `\${${v}:-}`])) } : {}),
    },
    restart: 'unless-stopped',
    env_file: ['.env'],
    environment: {
      PORT: String(port),
      ...(a.needsPostgres ? { DATABASE_URL: `postgres://app:\${POSTGRES_PASSWORD}@db:5432/app` } : {}),
    },
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    pids_limit: 512,
    logging,
    ...(healthTest ? { healthcheck: { test: healthTest, interval: '30s', timeout: '5s', retries: 3, start_period: '30s' } } : {}),
    ...(a.needsPostgres ? { depends_on: { db: { condition: 'service_healthy' } } } : {}),
  };

  const services: Record<string, unknown> = {
    app,
    caddy: {
      image: 'caddy:2-alpine',
      restart: 'unless-stopped',
      ports: ['80:80', '443:443', '443:443/udp'],
      environment: { SITE_ADDRESS: '${SITE_ADDRESS:-:80}', UPSTREAM_PORT: String(port) },
      volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy_data:/data', 'caddy_config:/config'],
      depends_on: ['app'],
      logging,
    },
  };
  const volumes: Record<string, null> = { caddy_data: null, caddy_config: null };

  if (a.needsPostgres) {
    services.db = {
      image: 'postgres:17-alpine',
      restart: 'unless-stopped',
      environment: { POSTGRES_USER: 'app', POSTGRES_DB: 'app', POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?run deploy.sh or set it in .env}' },
      volumes: ['db_data:/var/lib/postgresql/data'],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U app'], interval: '10s', timeout: '5s', retries: 5 },
      logging,
    };
    volumes.db_data = null;
  }
  return stringify({ services, volumes });
}

const caddyfile = `{$SITE_ADDRESS} {
\tencode zstd gzip
\theader {
\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"
\t\tX-Content-Type-Options "nosniff"
\t\tX-Frame-Options "SAMEORIGIN"
\t\tReferrer-Policy "strict-origin-when-cross-origin"
\t\tPermissions-Policy "camera=(), microphone=(), geolocation=()"
\t\t-Server
\t\t-X-Powered-By
\t}
\treverse_proxy app:{$UPSTREAM_PORT}
}
`;

const nginxConf = `server {
    listen ${INTERNAL_PORT};
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location ~ /\\. {
        deny all;
    }
}
`;

const dockerignore = `.git
.env
.env.*
!.env.example
node_modules
dist
build
.next
deploy/.env
__pycache__
.venv
`;

function envExample(a: Analysis): string {
  const lines = ['# Fill these in. deploy.sh creates .env from this file on the first run.', 'SITE_ADDRESS=:80'];
  if (a.needsPostgres) lines.push('POSTGRES_PASSWORD=');
  for (const name of a.envVars) {
    if (a.needsPostgres && name === 'DATABASE_URL') continue;
    lines.push(`${name}=`);
  }
  return `${lines.join('\n')}\n`;
}

function deployScript(a: Analysis, opts: KitOptions): string {
  return `#!/usr/bin/env bash
# First run sets up the app. Every later run pulls the latest code and restarts it.
set -euo pipefail

APP_DIR=/opt/airchitect/app
REPO_URL="\${REPO_URL:-${opts.repoUrl ?? ''}}"
REF="\${REF:-${opts.ref ?? ''}}"
DOMAIN="\${DOMAIN:-${opts.domain ?? ''}}"

if [ -z "$REPO_URL" ]; then
  echo "Set REPO_URL to your git repository first." >&2
  exit 1
fi

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 \${REF:+--branch "$REF"} "$REPO_URL" "$APP_DIR"
fi

mkdir -p "$APP_DIR/deploy"
cp -rT /opt/airchitect/kit/deploy "$APP_DIR/deploy"
cp /opt/airchitect/kit/.dockerignore "$APP_DIR/.dockerignore"

ENV_FILE="$APP_DIR/deploy/.env"
if [ ! -f /opt/airchitect/.env ]; then
  cp "$APP_DIR/deploy/.env.example" /opt/airchitect/.env
fi
chmod 600 /opt/airchitect/.env
cp /opt/airchitect/.env "$ENV_FILE"
chmod 600 "$ENV_FILE"
${a.needsPostgres ? `
if ! grep -q '^POSTGRES_PASSWORD=.' "$ENV_FILE"; then
  password="$(openssl rand -hex 24)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" /opt/airchitect/.env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" "$ENV_FILE"
fi
` : ''}
# No domain yet? sslip.io turns the server's IP into a name, so HTTPS still works.
if [ -z "$DOMAIN" ]; then
  ip="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com)"
  DOMAIN="\${ip//./-}.sslip.io"
fi
sed -i "s/^SITE_ADDRESS=.*/SITE_ADDRESS=$DOMAIN/" "$ENV_FILE"

docker compose -f "$APP_DIR/deploy/docker-compose.yml" --env-file "$ENV_FILE" up -d --build --remove-orphans
docker image prune -f
echo "Live at https://$DOMAIN"
`;
}

function backupScript(a: Analysis): string {
  return `#!/usr/bin/env bash
# Runs every night. Keeps 7 days on this server and, if you set BACKUP_REMOTE in
# /opt/airchitect/backup.env, copies them off-site. Backups on the same server aren't enough.
set -euo pipefail

DIR=/var/backups/airchitect
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date +%F)"
COMPOSE="docker compose -f /opt/airchitect/app/deploy/docker-compose.yml --env-file /opt/airchitect/app/deploy/.env"

${a.needsPostgres ? '$COMPOSE exec -T db pg_dump -U app app | gzip > "$DIR/db-$STAMP.sql.gz"' : 'tar -czf "$DIR/env-$STAMP.tar.gz" -C /opt/airchitect .env'}
find "$DIR" -type f -mtime +7 -delete

[ -f /opt/airchitect/backup.env ] && . /opt/airchitect/backup.env
if [ -n "\${BACKUP_REMOTE:-}" ]; then
  rclone copy "$DIR" "$BACKUP_REMOTE"
fi
`;
}

function appSpec(a: Analysis, opts: KitOptions): string {
  return stringify({
    apiVersion: 'airchitect.dev/v1alpha1',
    kind: 'App',
    metadata: { name: a.name },
    budget: { run_monthly_cap: `${opts.monthlyBudget ?? 20} EUR`, on_cap: 'notify-only' },
    constraints: { data_residency: opts.euOnly ? 'EU' : 'any' },
    stack: {
      components: {
        web: { kind: 'web-app', framework: a.stack },
        ...(a.database === 'none' ? {} : { db: { kind: a.database, managed_by: a.needsPostgres ? 'this-server' : 'external' } }),
      },
    },
    placement: { strategy: 'best-fit', decided: opts.provider ? { web: `${opts.provider}/${opts.plan ?? 'unknown'}` } : {} },
    operations: { autonomy: 'L0', backups_offsite: false },
  });
}

function runbook(a: Analysis, opts: KitOptions): string {
  const database = a.needsPostgres
    ? 'A private Postgres runs next to your app, with no public port. `DATABASE_URL` is set for you.'
    : a.database === 'none'
      ? 'No database was found.'
      : `Your app uses ${a.database}, which stays where it is. Add its settings to \`.env\`.`;
  return `# Running ${a.name}

Generated by Airchitect. These files are yours, and nothing here depends on us.

## What you get

- ${a.stackLabel} in a container that doesn't run as root${a.stack === 'dockerfile' ? ' (check your Dockerfile, it is used as it is)' : ''}
- Caddy in front, with automatic HTTPS and security headers
- A hardened Ubuntu server: firewall (22, 80, 443), key-only SSH, automatic security updates, fail2ban
- Nightly backups, 7 days on the server
- ${database}

## Deploy

1. Create an Ubuntu 24.04 server with at least 2 GB of RAM at any provider.
2. Paste \`deploy/cloud-init.yaml\` into the provider's "user data" or "cloud-init" box.
3. Wait about 5 minutes. Your app appears at \`https://<ip-with-dashes>.sslip.io\`, for example \`https://203-0-113-10.sslip.io\`.

The first build can take longer on a small server.

## Your settings

Log in with \`ssh deploy@<server-ip>\` and edit \`/opt/airchitect/.env\`:

${a.envVars.length ? a.envVars.map((v) => `- \`${v}\``).join('\n') : '- Your app needs no settings.'}

Then run \`sudo /opt/airchitect/deploy.sh\` to apply them.

## Everyday jobs

| Job | Command |
|---|---|
| Update to the latest code | \`sudo /opt/airchitect/deploy.sh\` |
| See logs | \`docker compose -f /opt/airchitect/app/deploy/docker-compose.yml logs -f app\` |
| Use your own domain | Point an A record at the server, then run \`sudo DOMAIN=example.com /opt/airchitect/deploy.sh\` |
| Back up now | \`sudo /opt/airchitect/backup.sh\` |

## Backups off-site

Set up \`rclone\` as root, then create \`/opt/airchitect/backup.env\` with a line like \`BACKUP_REMOTE=r2:my-backups\`. Keep backups at a different provider, because a backup on the same server dies with the server.
${opts.repoUrl ? '' : '\n## Before you deploy\n\nWe could not find a git address for this project. Set `REPO_URL` at the top of `deploy/deploy.sh`.\n'}`;
}

const sshHardening = `PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 3
`;

const autoUpgrades = `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
`;

const fail2ban = `[sshd]
enabled = true
maxretry = 5
bantime = 1h
`;

const b64 = (text: string) => Buffer.from(text).toString('base64');

export function cloudInit(files: KitFiles, opts: KitOptions & { env?: string }): string {
  const kit = Object.entries(files)
    .filter(([path]) => path.startsWith('deploy/') || path === '.dockerignore')
    .filter(([path]) => path !== 'deploy/cloud-init.yaml' && path !== 'deploy/RUNBOOK.md')
    .map(([path, content]) => ({
      path: `/opt/airchitect/kit/${path}`,
      encoding: 'b64',
      content: b64(content),
      permissions: path.endsWith('.sh') ? '0755' : '0644',
    }));

  const config = {
    package_update: true,
    package_upgrade: true,
    packages: ['ufw', 'fail2ban', 'unattended-upgrades', 'git', 'curl', 'ca-certificates', 'rclone'],
    ssh_pwauth: false,
    disable_root: true,
    users: [
      {
        name: 'deploy',
        groups: ['sudo'],
        shell: '/bin/bash',
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        lock_passwd: true,
        ...(opts.sshPublicKey ? { ssh_authorized_keys: [opts.sshPublicKey] } : {}),
      },
    ],
    write_files: [
      { path: '/etc/ssh/sshd_config.d/10-airchitect.conf', content: sshHardening, permissions: '0644' },
      { path: '/etc/apt/apt.conf.d/20auto-upgrades', content: autoUpgrades, permissions: '0644' },
      { path: '/etc/fail2ban/jail.d/airchitect.conf', content: fail2ban, permissions: '0644' },
      ...kit,
      { path: '/opt/airchitect/deploy.sh', encoding: 'b64', content: b64(files['deploy/deploy.sh'] ?? ''), permissions: '0755' },
      { path: '/opt/airchitect/backup.sh', encoding: 'b64', content: b64(files['deploy/backup.sh'] ?? ''), permissions: '0755' },
      { path: '/etc/cron.d/airchitect-backup', content: '30 3 * * * root /opt/airchitect/backup.sh >> /var/log/airchitect-backup.log 2>&1\n', permissions: '0644' },
      ...(opts.env ? [{ path: '/opt/airchitect/.env', encoding: 'b64', content: b64(opts.env), permissions: '0600' }] : []),
    ],
    runcmd: [
      ['ufw', 'default', 'deny', 'incoming'],
      ['ufw', 'default', 'allow', 'outgoing'],
      ['ufw', 'allow', 'OpenSSH'],
      ['ufw', 'allow', '80/tcp'],
      ['ufw', 'allow', '443/tcp'],
      ['ufw', 'allow', '443/udp'],
      ['ufw', '--force', 'enable'],
      ['systemctl', 'restart', 'ssh'],
      ['systemctl', 'enable', '--now', 'fail2ban'],
      ['sh', '-c', 'curl -fsSL https://get.docker.com | sh'],
      ['usermod', '-aG', 'docker', 'deploy'],
      ['sh', '-c', '/opt/airchitect/deploy.sh >> /var/log/airchitect-deploy.log 2>&1'],
    ],
  };
  return `#cloud-config\n${stringify(config, { lineWidth: 0 })}`;
}

export function generateKit(a: Analysis, opts: KitOptions = {}): KitFiles {
  const own = a.stack === 'dockerfile';
  const files: KitFiles = {
    'airchitect.yaml': appSpec(a, opts),
    '.dockerignore': dockerignore,
    'deploy/docker-compose.yml': compose(a, own),
    'deploy/Caddyfile': caddyfile,
    'deploy/.env.example': envExample(a),
    'deploy/deploy.sh': deployScript(a, opts),
    'deploy/backup.sh': backupScript(a),
    'deploy/RUNBOOK.md': runbook(a, opts),
  };
  const docker = dockerfile(a);
  if (docker) files['deploy/Dockerfile'] = docker;
  if (a.stack === 'vite' || a.stack === 'static') files['deploy/nginx.conf'] = nginxConf;
  files['deploy/cloud-init.yaml'] = cloudInit(files, opts);
  return files;
}
