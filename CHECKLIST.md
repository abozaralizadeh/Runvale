# Checklist

Where the project stands. Good places to help are under "Faked or limited" and "Still missing".

## Done and tested

- [x] Scan: passive security check of a live URL (TLS, headers, cookies, leaked keys in JS, source maps, mixed content).
- [x] Owner checks after proving the site is yours: exposed `.env`/`.git`, Supabase tables readable without login.
- [x] Quote: Budget, Balanced and Premium picks from the price catalog, EU-only filter, traffic and backups priced in.
- [x] Rescue: GitHub repo or local folder to a deploy kit (Dockerfile, compose, Caddy, hardened cloud-init, backups, runbook).
- [x] Deploy kits built and run in real Docker for Vite, Flask, FastAPI, Express with Postgres and Next.js. All non-root, all behind Caddy with security headers.
- [x] `VITE_` settings get baked into the built JS.
- [x] Watch: uptime every 5 minutes, certificate days, daily rescan, webhook alerts, list key to open the same list on another device.
- [x] CLI (`scan`, `quote`, `rescue`).
- [x] MCP server: a real stdio test lists the three tools and calls each one.
- [x] SSRF protection on every outbound request, including redirects and DNS.
- [x] Backend tests pass. Frontend and backend type-check and build.
- [x] Demo recording of the real UI (`site/demo/`), re-recordable from `demos/tour.json`.
- [x] Project site in `site/`, ready for GitHub Pages.

## Faked or limited

- [ ] Hetzner deploy is only tested against a fake Hetzner API.
- [ ] Prices for everyone except Hetzner come from a static catalog (`backend/data/providers.json`), not live APIs. Each price was read from the provider's own page or API on 3 Nov 2026 and links to its source. Next step: refresh OVHcloud, Vultr, Azure and AWS from their public APIs on a schedule.
- [ ] Only Hetzner has one-click deploy. Other providers get the kit and the cloud-init file to paste.
- [ ] Webhook alerts are sent as `{text, content}`, which Slack and Discord accept. Not tried against a real Slack or Discord yet.

## Still missing

- [ ] An end-to-end run of `setup_service.sh` on a fresh Ubuntu VM.
- [ ] An end-to-end deploy on a real Hetzner account.
- [ ] Live price adapters for OVHcloud, Scaleway and the others.
- [ ] A static demo of the Quote page that runs without the backend.
