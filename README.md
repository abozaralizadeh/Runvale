# Runvale

![Runvale demo: scan a site, compare clouds, rescue a repo, watch the app](site/demo/tour.gif)

Get a web app you built (often with an AI tool) safely onto a server you can afford.

Project site: https://abozaralizadeh.github.io/Runvale/ · [Full demo video (MP4)](site/demo/tour.mp4)

Runvale does four things:

- **Scan** a live app for leaked keys, missing security headers and weak settings, and explain the fixes in plain words.
- **Quote** where to host it. It compares European and US cloud providers by price, reliability and tooling and gives you three options.
- **Rescue** a GitHub repo or local folder. It checks the code for problems and writes a deploy kit: Dockerfile, Docker Compose, Caddy with HTTPS, a hardened server setup, backups and a runbook.
- **Watch** the app once it's live: uptime every 5 minutes, certificate expiry and a daily security rescan.

It also comes as a CLI and an MCP server, so coding agents can use it directly.

> Status: early beta. See [CHECKLIST.md](CHECKLIST.md) for what works, what's faked and what's missing.

## Quick install

You need Node.js 24 or newer.

```bash
git clone <this repo> runvale && cd runvale
```

```bash
cd backend && npm install && npm run dev
```

In a second terminal:

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. The API runs on port 8790.

### Run it on a server

On a fresh Ubuntu VM:

```bash
sudo ./setup_service.sh
```

It installs Node and Caddy, builds the app and starts the `runvale` service. To use your own domain, run `sudo DOMAIN=app.example.com ./setup_service.sh` instead. Without a domain, the script uses `<ip>.sslip.io`. Rerun it any time to update. Logs:

```bash
journalctl -u runvale.service -f
```

### Run it next to other apps

If the server already runs nginx for other sites, use the shared mode. It installs nothing, leaves the firewall and certificates alone, and serves the app under a path:

```bash
sudo SERVICE_NAME=my-runvale PORT=8607 BASE_PATH=/runvale/ NGINX_SNIPPET=/etc/nginx/snippets.d/runvale.conf ./setup_service.sh
```

It needs Node 24+, npm, nginx, rsync and curl already installed, and your nginx server block must include the snippet folder. The script writes only that snippet and a rate limit zone in `/etc/nginx/conf.d/`, runs `nginx -t`, and puts both back if the check fails. Settings live in `/etc/<service>.env`, and your own lines survive reruns.

Settings you can add to that file:

| Setting | Default | What it does |
|---|---|---|
| `SCAN_BLOCKLIST` | empty | Host names the scanner must never reach, comma separated. The server's own public IP is added for you as `SELF_ADDRESSES` |
| `SCANS_PER_IP_DAILY`, `SCANS_DAILY` | 50, 1000 | Scans per visitor and per server each day |
| `RESCUES_PER_IP_DAILY`, `RESCUES_DAILY` | 20, 300 | Repo checks per visitor and per server each day |
| `WATCH_ADDS_PER_IP_DAILY`, `MAX_WATCHES` | 20, 500 | New watches per visitor each day, and watches in total |
| `SCAN_DEADLINE_MS` | 40000 | How long one scan may keep fetching files |

### Use it from the command line

```bash
cd backend && npm run build
```

```bash
node dist/cli.js scan example.com
```

```bash
node dist/cli.js rescue ./my-app --out ./my-app
```

### Use it from a coding agent

After `npm run build`, add the MCP server to any MCP client:

```json
{ "mcpServers": { "runvale": { "command": "node", "args": ["/path/to/runvale/backend/dist/mcp.js"] } } }
```

The agent gets three tools: `scan_url`, `quote_cloud` and `rescue_project`.

## Run the tests

```bash
cd backend && npm test
```

Type checks:

```bash
cd backend && npm run typecheck
```

## How it works

See [docs/architecture.md](docs/architecture.md).

## Fair use

Only scan sites you own or have permission to test. The scan is passive and rate-limited, and the deeper checks need proof that the site is yours. To report misuse, open a GitHub issue.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, because contributions come with a licensing condition.

## License

Source available, free for non-commercial use ([PolyForm Noncommercial 1.0.0](LICENSE)). You can use it, study it, change it and share it for anything that isn't commercial. Commercial use needs written permission: ask by opening a GitHub issue.

Docs, screenshots and the demo video are under [CC BY-NC 4.0](LICENSE-docs.md). The deploy kits the tool generates for you are yours to use however you like, commercially too. Third-party parts keep their own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
