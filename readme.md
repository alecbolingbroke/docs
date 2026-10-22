# FieldRoutes API Docs

A curated, corrected OpenAPI specification for the **FieldRoutes (formerly PestRoutes) API**,
published as an interactive reference.

This is an **unofficial** project, maintained independently of FieldRoutes. FieldRoutes'
full spec is only downloadable with tenant credentials, and in places it's wrong. This one
is public, browsable, and corrected:

- **Complete.** Every endpoint in FieldRoutes' own spec (299 paths as of October 2026),
  tagged by entity and grouped into sections.
- **Corrections.** Known documentation errors are fixed — e.g. FieldRoutes labels
  `/group/search`'s `date` as a service date; it is actually the last-updated date. Every fix
  is recorded in [`corrections.yaml`](corrections.yaml) with the reason.
- **Kept current.** A weekly job re-fetches the vendor spec and merges genuine additions in.

## 📖 Live documentation

- **[Reference](https://alecbolingbroke.github.io/docs/fieldroutes/)** — ReDoc, grouped into six sections by entity. The overview carries a glossary, the limits worth designing around, common workflows, and an FAQ.
- **[Try it](https://alecbolingbroke.github.io/docs/fieldroutes/index.html#swagger)** — run real calls against your own tenant (see below)
- **[YAML](https://alecbolingbroke.github.io/docs/fieldroutes/index.html#yaml)** / **[JSON](https://alecbolingbroke.github.io/docs/fieldroutes/index.html#json)** — the raw spec

## 🔑 Testing against your own tenant

The **Try it** tab executes live calls. Enter your host (`mycompany.fieldroutes.com`), key and
token in the bar at the top and pick an endpoint.

- **Your credentials never leave your browser.** The site is static — no backend, nothing to
  send them to. Requests go directly from your browser to your own FieldRoutes host.
  "Remember on this device" opts into `localStorage`; otherwise they live in `sessionStorage`
  and die with the tab.
- **Writes are blocked by default.** Every mutating operation is flagged `x-fr-write` in the
  spec, and the explorer refuses to send one until you tick *Allow write operations*. The
  check fails closed: anything it can't positively identify as a read is treated as a write.

Two things had to be true for in-browser testing to work at all, both verified against the
live API:

- The API returns `Access-Control-Allow-Origin: *`, but its preflight allows only
  `X-Requested-With` — so any request carrying a `Content-Type` is rejected before it's sent.
  Every FieldRoutes parameter is `in: query`, so requests are URL-only with no body, which
  keeps them CORS-"simple" and preflight-free.
- FieldRoutes' spec declares `produces: text/html`, but the API is content-negotiated and
  answers `Accept: text/html` with a **406** whose error page carries no CORS headers. A
  client that honours the vendor's declared type gets blocked by the browser. The spec here
  corrects `produces` to `application/json`.

## 🐛 Something look off?

**[Open an issue](https://github.com/alecbolingbroke/docs/issues)** — a wrong
description, a stale field, a missing endpoint, an example that no longer works. Include the
endpoint and what you actually observed from the API. Corrections get folded into
`corrections.yaml` so they survive the next upstream sync.

For account, key, permission, or platform problems — anything that needs someone inside
FieldRoutes — contact **apisupport@fieldroutes.com** instead. That's also who to ask about
raising your API rate limits or pulling request logs.

## 🤖 Building on the spec

The spec is deliberately shaped to be consumed by tooling — it's the intended backbone for an
MCP server or a generated SDK:

| Metadata | Use |
| --- | --- |
| `tags` | Every operation is tagged with its entity — natural tool namespaces |
| `x-tagGroups` | Those entities grouped into six sections |
| `x-fr-write` | `true` on every mutating operation — gate writes, or expose a read-only surface by default |
| `produces` | Corrected to `application/json` (the vendor declares `text/html`, which 406s) |

Machine-readable outputs: `fieldroutes/fieldroutes-swagger-docs.json` (canonical) and
`fieldroutes/fieldroutes-swagger-docs.with-summaries.json` (adds prettified operation titles).

## 🔄 How the sync works

`sync-spec.js` runs weekly via [`sync-local.sh`](sync-local.sh) and opens a PR only when
something actually changed upstream. It runs **locally, not in GitHub Actions**: FieldRoutes
serves its spec only to authenticated tenants, and credentials never go into this public repo.

1. **Fetch** the vendor spec from `POST https://<tenant>.fieldroutes.com/api/documentation/swagger`
   (key + token from the environment; the response is generic, not tenant data) → saved raw
   to `fieldroutes/upstream.json`. The script refuses to write a response that echoes a
   credential.
2. **Merge additively** into the canonical spec — new endpoints, parameters and definitions
   are added; nothing is ever removed, so the extra endpoints and richer parameters survive.
   Vendor *changes* to existing fields are deliberately **not** auto-applied; overriding is
   what `corrections.yaml` is for.
3. **Apply `corrections.yaml`** — parameter-description fixes plus a deep-merge overlay (this
   is also where the ReDoc overview / glossary lives, so it's re-embedded every run).
4. **Correct `produces`**, then **tag** every operation by entity, group entities into
   sections, and flag writes — all derived from the path, so new endpoints are categorized
   automatically. A brand-new *entity* is logged loudly rather than silently bucketed.
5. **Regenerate** the four published files the site loads.
6. **Snapshot the vendor's prose pages** — the Knowledge Base
   [API overview](https://knowledgebase.fieldroutes.com/apidocs/fieldroutes-api-overview),
   release notes and Swagger page, as plain text in `fieldroutes/upstream-pages/`. A diff there
   means FieldRoutes changed its stated limits, behavior or release notes — none of which live
   in the OpenAPI spec, so nothing else would catch it.

**Running it.** `sync-local.sh` clones the repo fresh, runs the sync, and opens or updates a PR
on `spec-sync/upstream`. It needs only bash, git, curl and node. It reads `FR_HOST`,
`FR_AUTH_KEY`, `FR_AUTH_TOKEN` and `GITHUB_TOKEN` (a fine-grained PAT for this repo only:
Contents + Pull requests write) from `~/.config/fieldroutes-docs/env` (override with
`FR_DOCS_ENV`). Optionally, `SLACK_CHANNEL` in that file plus `SLACK_ENV` pointing at an env
file with `SLACK_BOT_TOKEN` posts failures to Slack. A launchd job on an always-on host runs an
installed copy weekly, so re-install it after changing the script. For a one-off run in your
working copy: `set -a; . ~/.config/fieldroutes-docs/env; set +a; npm run sync`.

## 🔒 Leak check

Everything here is public, so `check-leaks.js` fails if any file contains a term from a **private
blocklist** kept outside the repo (`~/.config/fieldroutes-docs/denylist`, or `FR_DOCS_DENYLIST`):
plain lines match whole words, `re:` lines are regexes. A missing list fails closed. It runs:

- in every weekly sync, over the whole tree (so anything merged another way is caught too);
- before every push, via `.githooks/pre-push` (enable once per clone:
  `git config core.hooksPath .githooks`);
- by hand: `npm run check`. Tests: `npm test`.

Contributing a finding: change `corrections.yaml` only, keep it true for every FieldRoutes
account (no company-specific IDs or names), and open a PR. The next weekly sync regenerates the
site files from it.

## Local development

Interactive Swagger UI against the spec:

```bash
npx swagger-ui-watcher docs/fieldroutes-swagger-docs.yaml
```

Operation summaries are prettified from `operationId` (e.g. `customerSearch` →
"Customer search") into the `.with-summaries.yaml` variant. `sync-spec.js` regenerates it;
`fieldroutes/generate-summaries.js` does it standalone.

## 🚀 Deployment

`fieldroutes/` deploys to GitHub Pages via GitHub Actions on every push to `main`
([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). Note that the legacy
"deploy from a branch" Pages build is deprecated and silently stopped working — the Pages
source must stay set to **GitHub Actions**.

## 📁 File structure

| Path | What it is |
| --- | --- |
| `fieldroutes/fieldroutes-swagger-docs.yaml` | Canonical spec — the single source of truth |
| `fieldroutes/fieldroutes-swagger-docs.json` | JSON rendering of the same spec |
| `fieldroutes/fieldroutes-swagger-docs.with-summaries.yaml` | Generated; adds prettified operation summaries |
| `fieldroutes/fieldroutes-swagger-docs.with-summaries.json` | JSON twin of the above — what the viewer fetches, and the drop-in input for codegen |
| `fieldroutes/upstream.json` | Raw vendor spec, never hand-edited — reference and change detection |
| `fieldroutes/upstream-pages/*.txt` | Text snapshots of the Knowledge Base API overview, release notes and Swagger page |
| `corrections.yaml` | Fixes + overlay applied on top of the merge; also holds the published overview/glossary |
| `sync-spec.js` | The weekly sync pipeline |
| `sync-local.sh` | Local weekly runner: fresh clone → sync → PR |
| `check-leaks.js` | Private-blocklist scan of everything published (+ `check-leaks.test.js`) |
| `.githooks/pre-push` | Runs the leak check on every pushed commit |
| `fieldroutes/index.html` | Multi-format documentation viewer |
| `fieldroutes/generate-summaries.js` | Standalone summary prettifier |

## License

The specification content describes a third-party API and is provided as-is, with no
affiliation with or endorsement by FieldRoutes.
