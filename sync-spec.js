#!/usr/bin/env node
/**
 * sync-spec.js — self-sustaining FieldRoutes spec pipeline.
 *
 * Fetch the vendor spec (window.swagger from fieldroutes.dev/resources/swagger.js)
 *  → ADDITIVELY merge it into the canonical spec: add new endpoints / params /
 *    definitions FR documents, but NEVER remove our 94 extra endpoints or richer
 *    params. (FR *changes* to existing fields are NOT auto-applied — only additions;
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
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const yaml = require("js-yaml");

const SPEC_URL = "https://fieldroutes.dev/resources/swagger.js";
// The fieldroutes.dev site is a jQuery SPA: every page body lives as a compiled
// template function inside this one bundle. Rendering them gives us a diffable
// snapshot of the vendor's prose (limits, FAQ, examples) — see snapshotPages().
const TEMPLATES_URL = "https://fieldroutes.dev/templates/HEAD";
const WATCHED_PAGES = ["home", "examples", "faq"];
const DOCS = path.join(__dirname, "fieldroutes");
const PAGES_DIR = path.join(DOCS, "upstream-pages");
const CANONICAL_YAML = path.join(DOCS, "fieldroutes-swagger-docs.yaml");
const CANONICAL_JSON = path.join(DOCS, "fieldroutes-swagger-docs.json");
const SUMMARIES_YAML = path.join(DOCS, "fieldroutes-swagger-docs.with-summaries.yaml");
const SUMMARIES_JSON = path.join(DOCS, "fieldroutes-swagger-docs.with-summaries.json");
const UPSTREAM_JSON = path.join(DOCS, "upstream.json");
const CORRECTIONS = path.join(__dirname, "corrections.yaml");

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

// Entity → section. The API is a flat list of 276 /{entity}/{action} paths with no tags
// at all, so every renderer dumps them into one giant "default" bucket. Grouping by
// entity, and entities into sections, is what makes 276 endpoints navigable — and it
// doubles as the namespace an MCP server can generate tools from.
const SECTIONS = [
  ["Customers & Accounts", ["customer", "customerFlag", "customerSource", "additionalContact", "compassCustomer", "unit", "location", "door", "knock"]],
  ["Subscriptions & Services", ["subscription", "servicePlan", "servicePlanRound", "serviceType", "contract", "product", "applicationMethod"]],
  ["Scheduling", ["appointment", "appointmentReminder", "appointmentCancellationReason", "appointmentRescheduleReason", "cancellationReason", "reserviceReason", "route", "routeTemplate", "spot", "group", "onMyWayNotification"]],
  ["Billing & Payments", ["ticket", "ticketItem", "payment", "appliedPayment", "paymentProfile", "paymentPriority", "chargeback", "disbursement", "disbursementItem", "glAccount", "collectionStage"]],
  ["Field Operations", ["chemical", "chemicalUse", "insect", "employee", "employeeLocation", "team", "skill", "timeClock", "timeClockCategory", "license", "task", "form", "diagram", "review"]],
  ["Org & Configuration", ["office", "region", "accessControl", "contactType", "genericFlag", "genericFlagAssignment", "note", "document", "dataLink", "changelog"]],
];

// Read-only actions. Everything else mutates real data — the site's tester gates them.
const READ_ACTIONS = new Set(["search", "get", "getSimple", "summary", "getAddOns", "getInitialAddOns"]);

async function fetchUpstream() {
  console.log(`⬇️  Fetching ${SPEC_URL}`);
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const js = await res.text();
  const sandbox = { window: {} };
  vm.runInNewContext(js, sandbox, { timeout: 10000 });
  const spec = sandbox.window.swagger;
  if (!spec || !spec.paths) throw new Error("Fetched bundle had no window.swagger.paths");
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
 * Snapshot the vendor's narrative pages (/home, /examples, /faq) as plain text so
 * the weekly run PRs when FieldRoutes changes its prose — rate limits, FAQ answers,
 * example workflows. Those live in the SPA's template bundle, not in the OpenAPI
 * spec, so nothing else in this pipeline would notice them drifting.
 *
 * Rendering approach: run the bundle in a vm with a stub jQuery (the templates only
 * touch $ inside their teardown <script> drivers, which we strip anyway), call
 * Template.build('page_x'), then reduce the HTML to text. Failures here are
 * non-fatal — a spec sync shouldn't break because the site's markup moved.
 */
async function snapshotPages() {
  const res = await fetch(TEMPLATES_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const $ = function () {
    const chain = { on() {}, off() {}, remove() {}, prev: () => chain, attr() {}, length: 0 };
    return chain;
  };
  $.getScript = () => ({ always() {} });
  $.cleanData = () => {};
  const sandbox = { console, $, jQuery: $, setTimeout, localStorage: {}, location: { pathname: "/" } };
  sandbox.window = sandbox;
  sandbox.document = {};
  vm.runInNewContext(await res.text(), sandbox, { timeout: 20000 });

  const Template = sandbox.Template;
  if (!Template || !Template.templates) throw new Error("Template bundle had no templates");

  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const changed = [];
  for (const page of WATCHED_PAGES) {
    const name = `page_${page}`;
    if (!Template.templates[name]) {
      console.warn(`   ⚠️  ${name} no longer exists upstream`);
      continue;
    }
    const text = htmlToText(Template.build(name, {}) || "");
    const file = path.join(PAGES_DIR, `${page}.txt`);
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (prev !== text) changed.push(page);
    fs.writeFileSync(file, text);
  }
  return changed;
}

// HTML → readable text. Drops the teardown <script> drivers (they carry volatile
// template ids that would otherwise churn the diff every run) and collapses blank runs.
function htmlToText(html) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|section|li|tr|h[1-6]|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => entities[e])
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

  console.log("📰 Snapshotting fieldroutes.dev pages (home / examples / faq)");
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
