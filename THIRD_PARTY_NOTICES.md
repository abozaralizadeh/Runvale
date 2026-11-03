# Third-party notices

Airchitect's own code is under the PolyForm Noncommercial License 1.0.0 (see [LICENSE](LICENSE)). The pieces below belong to others and keep their own licenses.

## Bundled into the built app

`npm run build` bundles these into the frontend:

| Package | License |
|---|---|
| React, React DOM | MIT |
| fflate | MIT |
| IBM Plex Sans and IBM Plex Mono (via `@fontsource`) | SIL Open Font License 1.1 |

## Fonts on the project site

`site/fonts/` holds latin subsets of Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono, taken from Google Fonts. All three are under the SIL Open Font License 1.1.

## Dependencies installed by npm

None of these are copied into this repo. npm downloads them, and their license files ship inside `node_modules`. A check of both lockfiles on 3 Nov 2026 found only these licenses:

- backend: MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0
- frontend: MIT, Apache-2.0, ISC, BSD-3-Clause, OFL-1.1, and MPL-2.0 for `lightningcss` (a build tool that isn't shipped)

## Data

`backend/data/providers.json` lists plans and prices that cloud providers publish. It was compiled with help from getdeploying.com. Prices are facts and change often, so check them with the provider before you rely on them. Hetzner prices and stock are read live from Hetzner's own API.

## Container images used by generated deploy kits

Generated kits pull these images at deploy time. They aren't part of this repo: `node`, `python`, `nginxinc/nginx-unprivileged`, `caddy` and `postgres` from Docker Hub, each under its own license.

## Names

Provider and product names (Hetzner, OVHcloud, Scaleway, AWS, GitHub, Supabase and others) are trademarks of their owners. They're used only to say what the tool works with.
