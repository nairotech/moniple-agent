const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Regression guard for the 2026-07-16 fix: the Doctor's events check calls the
// CORE events API (listEventForAllNamespaces = GET /api/v1/events), so the
// agent ClusterRole MUST grant `events` in the "" apiGroup — without it every
// cluster 403s ("Unable to retrieve cluster events"). We also grant the
// events.k8s.io group for modern clusters.
const rbacPath = path.join(__dirname, "..", "manifests", "moniple-agent-rbac.yaml");

function clusterRoleRules() {
  const docs = yaml.loadAll(fs.readFileSync(rbacPath, "utf8"));
  const cr = docs.find((d) => d && d.kind === "ClusterRole");
  assert.ok(cr, "moniple-agent-rbac.yaml has a ClusterRole");
  return cr.rules;
}

test("agent ClusterRole grants core `events` read (Doctor events check)", () => {
  const rules = clusterRoleRules();
  const core = rules.find(
    (r) => Array.isArray(r.apiGroups) && r.apiGroups.includes(""),
  );
  assert.ok(core, "a core (\"\") apiGroup rule exists");
  assert.ok(
    core.resources.includes("events"),
    "core rule includes `events`",
  );
  for (const v of ["get", "list", "watch"]) {
    assert.ok(core.verbs.includes(v), `core rule can ${v}`);
  }
});

test("agent ClusterRole grants events.k8s.io events read", () => {
  const rules = clusterRoleRules();
  const grp = rules.find(
    (r) => Array.isArray(r.apiGroups) && r.apiGroups.includes("events.k8s.io"),
  );
  assert.ok(grp, "an events.k8s.io rule exists");
  assert.ok(grp.resources.includes("events"));
  assert.ok(grp.verbs.includes("list"));
});
