const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Regression guard for the 2026-07-28 change: the agent-installed
// VictoriaMetrics single instance must carry the STANDARD
// `app.kubernetes.io/name: victoria-metrics-single` label on the
// Deployment, its pod template and the Service, so conventional
// selectors/scrape-configs targeting that label match agent installs.
// The pre-existing `app: moniple-vmsingle` selector contract must stay
// untouched — Deployment selectors are immutable and the bundled Service
// selects on it.
const manifestPath = path.join(
  __dirname,
  "..",
  "manifests",
  "victoria-metrics.yaml",
);

const STD_LABEL = "app.kubernetes.io/name";
const STD_VALUE = "victoria-metrics-single";

function docs() {
  return yaml.loadAll(fs.readFileSync(manifestPath, "utf8")).filter(Boolean);
}

function vmsingleDeployment() {
  const d = docs().find(
    (x) => x.kind === "Deployment" && x.metadata?.name === "moniple-vmsingle",
  );
  assert.ok(d, "moniple-vmsingle Deployment exists in manifest");
  return d;
}

test("vmsingle Deployment carries the standard VM label (metadata + pod template)", () => {
  const d = vmsingleDeployment();
  assert.strictEqual(d.metadata.labels[STD_LABEL], STD_VALUE);
  assert.strictEqual(
    d.spec.template.metadata.labels[STD_LABEL],
    STD_VALUE,
    "pod template label is what Services select — must be present",
  );
});

test("vmsingle Deployment selector is untouched (immutable contract)", () => {
  const d = vmsingleDeployment();
  // Selector must remain EXACTLY the legacy app label: adding the new
  // label here would make the manifest un-applyable over live installs.
  assert.deepStrictEqual(d.spec.selector.matchLabels, {
    app: "moniple-vmsingle",
  });
});

test("vmsingle Service carries the standard label but still selects on the legacy app label", () => {
  const s = docs().find(
    (x) => x.kind === "Service" && x.metadata?.name === "moniple-vmsingle",
  );
  assert.ok(s, "moniple-vmsingle Service exists in manifest");
  assert.strictEqual(s.metadata.labels[STD_LABEL], STD_VALUE);
  assert.deepStrictEqual(s.spec.selector, { app: "moniple-vmsingle" });
});
