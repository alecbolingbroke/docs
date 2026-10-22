#!/usr/bin/env node
/**
 * sync-spec.js — self-sustaining FieldRoutes spec pipeline.
 *
 * Fetch the vendor spec (POST {FR_HOST}/api/documentation/swagger, authenticated —
 *    credentials come from the environment and are never written anywhere)
 *  → ADDITIVELY merge it into the canonical spec: add new endpoints / params /
 *    definitions FR documents, but NEVER remove anything already documented here.
 *    (FR *changes* to existing fields are NOT auto-applied — only additions;
 *    corrections.yaml is where we override.)
 *  → apply corrections.yaml (fix known FR doc errors)
 *  → regenerate the published files the site loads:
 *       fieldroutes-swagger-docs.yaml              (canonical — single source of truth)
 *       fieldroutes-swagger-docs.json
 *       fieldroutes-swagger-docs.with-summaries.yaml
 * Also keeps fieldroutes/upstream.json (raw vendor) for reference / change detection.
 *
 * Note: the FIRST run normalizes the canonical YAML to js-yaml formatting (one big,
 * one-time diff). After that, js-yaml output is deterministic, so weekly PRs are
 * surgical — they show only real FR additions. Requires Node 18+ (global fetch) + js-yaml.
 *
 * Needs FR_HOST (https://<tenant>.fieldroutes.com), FR_AUTH_KEY and FR_AUTH_TOKEN, so it
 * runs locally (sync-local.sh), never in CI on this public repo.
 */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// FieldRoutes' prose docs moved to their Knowledge Base (Document360) in 10.6 Amethyst;
// fieldroutes.dev is frozen (swagger.js last modified 2022). See snapshotPages().
const KB_URL = "https://knowledgebase.fieldroutes.com/apidocs/";
const WATCHED_PAGES = ["fieldroutes-api-overview", "api-release-notes", "documentation-swagger"];
const DOCS = path.join(__dirname, "fieldroutes");
const PAGES_DIR = path.join(DOCS, "upstream-pages");
const CANONICAL_YAML = path.join(DOCS, "fieldroutes-swagger-docs.yaml");
const CANONICAL_JSON = path.join(DOCS, "fieldroutes-swagger-docs.json");
const SUMMARIES_YAML = path.join(DOCS, "fieldroutes-swagger-docs.with-summaries.yaml");
const SUMMARIES_JSON = path.join(DOCS, "fieldroutes-swagger-docs.with-summaries.json");
const UPSTREAM_JSON = path.join(DOCS, "upstream.json");
const CORRECTIONS = path.join(__dirname, "corrections.yaml");

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

// Entity → section. The API is a flat list of /{entity}/{action} paths with no tags
// at all, so every renderer dumps them into one giant "default" bucket. Grouping by
// entity, and entities into sections, is what makes hundreds of endpoints navigable — and it
// doubles as the namespace an MCP server can generate tools from.
const SECTIONS = [
  ["Customers & Accounts", ["customer", "customerFlag", "customerSource", "additionalContact", "welcomeChecklist", "compassCustomer", "unit", "location", "door", "knock"]],
  ["Subscriptions & Services", ["subscription", "bundleSubscription", "servicePlan", "servicePlanRound", "serviceType", "contract", "product", "applicationMethod"]],
  ["Scheduling", ["appointment", "appointmentReminder", "appointmentCancellationReason", "appointmentRescheduleReason", "cancellationReason", "reserviceReason", "route", "routeTemplate", "spot", "group", "onMyWayNotification"]],
  ["Billing & Payments", ["ticket", "ticketItem", "payment", "appliedPayment", "paymentProfile", "paymentPriority", "chargeback", "disbursement", "disbursementItem", "glAccount", "collectionStage"]],
  ["Field Operations", ["chemical", "chemicalUse", "insect", "employee", "employeeLocation", "team", "skill", "timeClock", "timeClockCategory", "license", "task", "condition", "form", "diagram", "review"]],
  ["Org & Configuration", ["office", "region", "accessControl", "contactType", "genericFlag", "genericFlagAssignment", "note", "document", "dataLink", "changelog"]],
];

// Read-only actions. Everything else mutates real data — the site's tester gates them.
const READ_ACTIONS = new Set(["search", "get", "getSimple", "summary", "getAddOns", "getInitialAddOns"]);

async function fetchUpstream() {
  const { FR_HOST, FR_AUTH_KEY, FR_AUTH_TOKEN } = process.env;
  if (!FR_HOST || !FR_AUTH_KEY || !FR_AUTH_TOKEN) throw new Error("FR_HOST, FR_AUTH_KEY and FR_AUTH_TOKEN must be set");
  const url = `${FR_HOST.replace(/\/+$/, "")}/api/documentation/swagger`;
  console.log("⬇️  Fetching the spec from /api/documentation/swagger");
  const res = await fetch(url, { method: "POST", headers: { authenticationKey: FR_AUTH_KEY, authenticationToken: FR_AUTH_TOKEN } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  // Served as text/html, but the body is JSON.
  const body = await res.text();
  // upstream.json is committed to a public repo — refuse anything that echoes a credential
  // or names the tenant (the endpoint returns a generic host today).
  const tenant = new URL(FR_HOST).hostname.split(".")[0];
  if (body.includes(FR_AUTH_KEY) || body.includes(FR_AUTH_TOKEN)) throw new Error("Spec response contains a credential; refusing to write it");
  if (new RegExp(`\\b${tenant}\\.(field|pest)routes\\.com`, "i").test(body)) throw new Error("Spec response names the tenant host; refusing to write it");
  const spec = JSON.parse(body);
  if (!spec.paths) throw new Error("Spec response had no paths");
  console.log(`   ${Object.keys(spec.paths).length} upstream paths`);
  return spec;
}

/**
 * Correct `produces`. FieldRoutes declares `text/html` on all 276 operations, but the
 * API is content-negotiated (Apache MultiViews → apiHandler.php) and answers a request
 * for text/html with **406 Not Acceptable**. The 406 error page carries no CORS headers,
 * so a browser client that honours the declared type gets its request blocked outright —
 * which is exactly what happens in Swagger UI's "Try it out" until this is fixed.
 * The endpoints return JSON (the `Content-Type: text/html` on success is a server bug,
 * but the body is JSON), so `application/json` is both accurate and what actually works.
 */
function correctProduces(spec) {
  let fixed = 0;
  for (const methods of Object.values(spec.paths || {})) {
    for (const [m, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(m) || typeof op !== "object") continue;
      if (JSON.stringify(op.produces) !== JSON.stringify(["application/json"])) {
        op.produces = ["application/json"];
        fixed++;
      }
    }
  }
  return fixed;
}

/**
 * Tag every operation with its entity, group entities into sections, and mark writes.
 *
 * Derived from the path (`/customer/search` → entity `customer`, action `search`), so a
 * new endpoint FieldRoutes adds upstream is categorized automatically — only a brand-new
 * *entity* needs a line in SECTIONS, and we log those loudly rather than silently
 * dropping them into a catch-all.
 *
 * `x-fr-write: true` marks mutating operations so the docs site can require an explicit
 * opt-in before firing one at a live tenant.
 */
function applyTaxonomy(spec) {
  const sectionOf = new Map();
  for (const [section, entities] of SECTIONS) for (const e of entities) sectionOf.set(e, section);

  const seen = new Map();
  const unmapped = new Set();
  for (const [p, methods] of Object.entries(spec.paths || {})) {
    const [, entity, action] = p.split("/");
    if (!entity) continue;
    if (!sectionOf.has(entity)) unmapped.add(entity);
    for (const [m, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(m) || typeof op !== "object") continue;
      op.tags = [entity];
      // Path-parameter segments are the by-id fetch, not an action — FieldRoutes writes
      // these as `/subscription/[id]`, so match brackets and braces both.
      const isPathParam = action && /^[[{].*[\]}]$/.test(action);
      // Recompute from scratch — the canonical is read back from disk each run, so a
      // flag left over from a previous run's rules would otherwise stick forever.
      delete op["x-fr-write"];
      if (action && !isPathParam && !READ_ACTIONS.has(action)) op["x-fr-write"] = true;
    }
    seen.set(entity, (seen.get(entity) || 0) + Object.keys(methods).filter((m) => HTTP_METHODS.includes(m)).length);
  }

  // Name only — a description that just restates the tag renders as noise on every row.
  spec.tags = [...seen.keys()].sort().map((name) => ({ name }));
  spec["x-tagGroups"] = SECTIONS
    .map(([name, entities]) => ({ name, tags: entities.filter((e) => seen.has(e)).sort() }))
    .filter((g) => g.tags.length);

  const grouped = new Set(spec["x-tagGroups"].flatMap((g) => g.tags));
  const leftovers = [...seen.keys()].filter((e) => !grouped.has(e)).sort();
  if (leftovers.length) {
    spec["x-tagGroups"].push({ name: "Uncategorized", tags: leftovers });
    console.warn(`   ⚠️  new entities not in SECTIONS: ${leftovers.join(", ")} — add them to sync-spec.js`);
  }
  return { entities: seen.size, sections: spec["x-tagGroups"].length, unmapped: unmapped.size };
}

/**
 * Snapshot the vendor's API prose pages (overview, release notes, the Swagger download
 * page) as plain text so the weekly run PRs when FieldRoutes changes them — rate limits,
 * release notes, behavior changes. None of that lives in the OpenAPI spec, so nothing
 * else in this pipeline would notice it drifting.
 *
 * The Knowledge Base is server-rendered; each page's content is its single <article>.
 * Failures here are non-fatal — a spec sync shouldn't break because the site's markup moved.
 */
async function snapshotPages() {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const changed = [];
  for (const page of WATCHED_PAGES) {
    const res = await fetch(KB_URL + page);
    const article = res.ok && (await res.text()).match(/<article[\s\S]*?<\/article>/);
    if (!article) {
      console.warn(`   ⚠️  ${page}: ${res.ok ? "no <article> found" : res.status} — skipped`);
      continue;
    }
    const text = htmlToText(article[0]);
    const file = path.join(PAGES_DIR, `${page}.txt`);
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (prev !== text) changed.push(page);
    fs.writeFileSync(file, text);
  }
  return changed;
}

// HTML → readable text. Drops <script>/<style> (volatile ids would churn the diff) and
// collapses blank runs.
function htmlToText(html) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " };
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|section|li|tr|h[1-6]|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // One pass, so "&amp;#39;" stays "&#39;" instead of being decoded twice.
    .replace(/&(amp|lt|gt|quot|nbsp|#x[0-9a-f]+|#\d+);/gi, (_, e) => {
      if (e[0] !== "#") return entities[e.toLowerCase()];
      const hex = /^#x/i.test(e);
      const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "&" + e + ";";
    })
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

// Additively merge upstream into canonical; return a list of additions for logging.
function mergeAdditive(canonical, upstream) {
  const added = [];
  canonical.paths = canonical.paths || {};
  for (const p of Object.keys(upstream.paths || {})) {
    if (!canonical.paths[p]) {
      canonical.paths[p] = upstream.paths[p];
      added.push(`+ endpoint   ${p}`);
      continue;
    }
    for (const m of Object.keys(upstream.paths[p])) {
      if (!HTTP_METHODS.includes(m)) continue;
      if (!canonical.paths[p][m]) {
        canonical.paths[p][m] = upstream.paths[p][m];
        added.push(`+ method     ${m.toUpperCase()} ${p}`);
        continue;
      }
      const cur = canonical.paths[p][m].parameters || [];
      const have = new Set(cur.map((x) => x.name));
      const fresh = (upstream.paths[p][m].parameters || []).filter((x) => !have.has(x.name));
      if (fresh.length) {
        canonical.paths[p][m].parameters = cur.concat(fresh);
        added.push(`+ params     ${m.toUpperCase()} ${p}  [${fresh.map((x) => x.name).join(", ")}]`);
      }
    }
  }
  if (upstream.definitions) {
    canonical.definitions = canonical.definitions || {};
    for (const d of Object.keys(upstream.definitions)) {
      if (!(d in canonical.definitions)) {
        canonical.definitions[d] = upstream.definitions[d];
        added.push(`+ definition ${d}`);
      }
    }
  }
  return added;
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === "object") {
    const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return patch;
}

function applyCorrections(spec) {
  if (!fs.existsSync(CORRECTIONS)) return;
  const corr = yaml.load(fs.readFileSync(CORRECTIONS, "utf8")) || {};
  if (corr.deepMerge) {
    const merged = deepMerge(spec, corr.deepMerge);
    for (const k of Object.keys(spec)) delete spec[k];
    Object.assign(spec, merged);
  }
  for (const c of corr.paramDescriptions || []) {
    const param = spec.paths?.[c.path]?.[c.method]?.parameters?.find((x) => x.name === c.name);
    if (param) param.description = c.description;
    else console.warn(`   ⚠️  correction target not found: ${c.method?.toUpperCase()} ${c.path} (${c.name})`);
  }
}

/**
 * camelCase operationId → readable title, keeping acronyms intact.
 *
 * Splitting on every capital turns `subscriptionGetID` into "Subscription Get I D".
 * Break only where a lowercase/digit meets a capital, and where a run of capitals is
 * followed by a new capitalised word (`getIDList` → "Get ID List").
 */
function prettifyOperationId(id) {
  const s = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Prettify operationId → summary for the with-summaries variant.
function withSummaries(spec) {
  const copy = JSON.parse(JSON.stringify(spec));
  for (const [p, methods] of Object.entries(copy.paths || {})) {
    for (const [m, op] of Object.entries(methods)) {
      if (typeof op !== "object" || !HTTP_METHODS.includes(m)) continue;
      op.summary = op.operationId ? prettifyOperationId(op.operationId) : `${m.toUpperCase()} ${p.replace(/^\//, "")}`;
    }
  }
  return copy;
}

(async () => {
  const upstream = await fetchUpstream();
  fs.writeFileSync(UPSTREAM_JSON, JSON.stringify(upstream, null, 2) + "\n");

  const canonical = yaml.load(fs.readFileSync(CANONICAL_YAML, "utf8"));
  const before = Object.keys(canonical.paths || {}).length;

  console.log("🔀 Merging upstream additions into canonical (additive-only)");
  const added = mergeAdditive(canonical, upstream);
  added.forEach((a) => console.log("   " + a));
  console.log(`   ${added.length} additions; paths ${before} → ${Object.keys(canonical.paths).length}`);

  console.log("🩹 Applying corrections.yaml");
  applyCorrections(canonical);

  const producesFixed = correctProduces(canonical);
  if (producesFixed) console.log(`🩹 produces → application/json on ${producesFixed} operations (FR declares text/html; the API 406s on it)`);

  console.log("🏷️  Tagging operations by entity + section");
  const tax = applyTaxonomy(canonical);
  console.log(`   ${tax.entities} entities across ${tax.sections} sections`);

  fs.writeFileSync(CANONICAL_YAML, yaml.dump(canonical, { lineWidth: -1 }));
  fs.writeFileSync(CANONICAL_JSON, JSON.stringify(canonical, null, 2) + "\n");
  const display = withSummaries(canonical);
  fs.writeFileSync(SUMMARIES_YAML, yaml.dump(display, { lineWidth: -1 }));
  // JSON twin of the display spec: the site fetches it once and hands the same object to
  // both viewers (no in-browser YAML parser), and it's the drop-in input for codegen /
  // an MCP server.
  fs.writeFileSync(SUMMARIES_JSON, JSON.stringify(display, null, 2) + "\n");
  console.log("✅ Regenerated canonical .yaml + .json and the .with-summaries .yaml + .json");

  console.log(`📰 Snapshotting Knowledge Base pages (${WATCHED_PAGES.join(" / ")})`);
  try {
    const changed = await snapshotPages();
    console.log(
      changed.length
        ? `   ⚠️  CHANGED UPSTREAM: ${changed.join(", ")} — review and fold into corrections.yaml`
        : "   no prose changes"
    );
  } catch (err) {
    console.warn(`   ⚠️  page snapshot skipped: ${err.message}`);
  }
})().catch((err) => { console.error("❌ sync-spec failed:", err.message); process.exit(1); });
