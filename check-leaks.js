#!/usr/bin/env node
/**
 * check-leaks.js — fail if anything this public repo publishes contains a blocklisted term.
 *
 * The blocklist lives OUTSIDE the repo ($FR_DOCS_DENYLIST, default ~/.config/fieldroutes-docs/denylist),
 * because the list itself would say what's confidential. One rule per line, `#` for comments:
 *   a plain line   matches as a whole word, case-insensitive  (e.g. a company name)
 *   re:<regex>     a case-insensitive regex                   (e.g. an ID in context)
 * A missing or empty list is a failure: the check fails closed.
 *
 * Usage: node check-leaks.js             scan the working tree (tracked + new files)
 *        node check-leaks.js --rev <sha> scan a commit (used by .githooks/pre-push)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const LIST = process.env.FR_DOCS_DENYLIST || path.join(os.homedir(), ".config", "fieldroutes-docs", "denylist");

function parseRules(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) =>
      l.startsWith("re:")
        ? new RegExp(l.slice(3), "i")
        : new RegExp(`(?<![\\w])${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i")
    );
}

// files: [{ name, text }] → [{ name, line, rule, match }]
function findLeaks(rules, files) {
  const hits = [];
  for (const { name, text } of files) {
    text.split("\n").forEach((line, i) => {
      rules.forEach((re, r) => {
        const m = line.match(re);
        if (m) hits.push({ name, line: i + 1, rule: r + 1, match: m[0] });
      });
    });
  }
  return hits;
}

function readFiles(rev) {
  const git = (...args) => execFileSync("git", args, { cwd: __dirname, encoding: "utf8", maxBuffer: 1 << 28 });
  const names = (rev ? git("ls-tree", "-r", "--name-only", rev) : git("ls-files", "-co", "--exclude-standard"))
    .split("\n")
    .filter(Boolean);
  return names
    .map((name) => {
      const text = rev ? git("show", `${rev}:${name}`) : fs.existsSync(path.join(__dirname, name)) && fs.readFileSync(path.join(__dirname, name), "utf8");
      return text === false ? null : { name, text };
    })
    .filter(Boolean);
}

if (require.main === module) {
  const revAt = process.argv.indexOf("--rev");
  const rev = revAt > -1 ? process.argv[revAt + 1] : null;
  if (revAt > -1 && !rev) {
    console.error("❌ check-leaks: --rev needs a commit");
    process.exit(1);
  }
  const rules = fs.existsSync(LIST) ? parseRules(fs.readFileSync(LIST, "utf8")) : [];
  if (!rules.length) {
    console.error(`❌ check-leaks: no blocklist at ${LIST} (or it's empty). Refusing to pass without one.`);
    process.exit(1);
  }
  const hits = findLeaks(rules, readFiles(rev));
  if (hits.length) {
    for (const h of hits) console.error(`❌ ${h.name}:${h.line}  rule ${h.rule}  "${h.match}"`);
    console.error(`check-leaks: ${hits.length} blocklisted term(s). Remove them before this is published.`);
    process.exit(1);
  }
  console.log(`✅ check-leaks: ${rules.length} rules, no hits${rev ? ` in ${rev.slice(0, 7)}` : ""}`);
}

module.exports = { parseRules, findLeaks };
