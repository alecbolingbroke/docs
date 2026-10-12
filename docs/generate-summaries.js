// generate-summaries.js
const fs = require("fs");
const yaml = require("js-yaml");

const INPUT = "fieldroutes-swagger-docs.yaml";
const OUTPUT = "fieldroutes-swagger-docs.with-summaries.yaml";

const doc = yaml.load(fs.readFileSync(INPUT, "utf8"));

// Safety check
if (!doc.paths) {
  console.error("No paths found in spec");
  process.exit(1);
}

Object.entries(doc.paths).forEach(([path, methods]) => {
  Object.entries(methods).forEach(([method, op]) => {
    if (typeof op !== "object") return;

    // Prefer operationId if present
    if (op.operationId) {
      // Prettify camelCase: "subscriptionSearch" → "Subscription Search"
      const pretty = op.operationId.replace(/([A-Z])/g, " $1").trim();
      op.summary = pretty.charAt(0).toUpperCase() + pretty.slice(1);
    } else {
      // Fallback: "POST subscription/search" (remove leading slash)
      const cleanPath = path.replace(/^\//, '');
      op.summary = `${method.toUpperCase()} ${cleanPath}`;
    }
  });
});

fs.writeFileSync(
  OUTPUT,
  yaml.dump(doc, { lineWidth: -1 }),
  "utf8"
);

console.log(`✅ Wrote updated spec to ${OUTPUT}`);
