const test = require("node:test");
const assert = require("node:assert");
const { parseRules, findLeaks } = require("./check-leaks");

const rules = parseRules("# comment\n\nAcme\nre:contactType\\D{0,20}\\b77\\b\n");
const scan = (text) => findLeaks(rules, [{ name: "f", text }]).map((h) => h.match);

test("plain terms match whole words, any case", () => {
  assert.deepStrictEqual(scan("Built for ACME."), ["ACME"]);
  assert.deepStrictEqual(scan("acmefoo and fooacme"), []);
});

test("regex rules match in context only", () => {
  assert.deepStrictEqual(scan("set contactType to 77"), ["contactType to 77"]);
  assert.deepStrictEqual(scan("page 77 of the docs"), []);
});

test("comments and blank lines are not rules", () => {
  assert.strictEqual(rules.length, 2);
});
