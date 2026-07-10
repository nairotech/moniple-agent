/**
 * Tests for the context-aware recommendation inputs added 2026-07-10
 * (docs/superpowers/specs/2026-07-10-doctor-context-aware-recommendations-design.md):
 *  - prompts: conditional GITOPS / SCAN HISTORY sections + resource-accuracy rules
 *  - collector helpers: current requests/limits extraction
 *  - gitops: desired-state digest extraction from manifest YAMLs
 *  - engine: fetchScanHistory never throws, null on failure paths
 */

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { getSystemPrompt, getUserPrompt } = require("../diagnostics/prompts");
const {
  currentContainerResources,
  currentPodResources,
} = require("../diagnostics/collector");
const { extractWorkloadDigest } = require("../diagnostics/gitops");
const { DiagnosticsEngine } = require("../diagnostics/index");

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- prompts -----------------------------------------------------------------

test("system prompt always carries the resource-accuracy rules and no literal example values", () => {
  const p = getSystemPrompt("en");
  assert.match(p, /RESOURCE VALUE ACCURACY/);
  assert.match(p, /STRICTLY ABOVE the current limit/);
  assert.match(p, /DO NOT propose adjust_resources/);
  // The old literal example the LLM used to parrot must be gone as a
  // recommendation: adjust_resources parameters are placeholder-marked now.
  assert.match(p, /\{"container": "<container-name>"/);
  assert.doesNotMatch(p, /"request": "256Mi"/);
});

test("gitops section only present with hasGitops", () => {
  assert.doesNotMatch(getSystemPrompt("en"), /GITOPS-MANAGED CLUSTER/);
  assert.doesNotMatch(getSystemPrompt("en", { hasHistory: true }), /GITOPS-MANAGED/);
  const p = getSystemPrompt("en", { hasGitops: true });
  assert.match(p, /GITOPS-MANAGED CLUSTER/);
  assert.match(p, /gitops_desired_state/);
  assert.match(p, /DRIFT/);
});

test("history section only present with hasHistory, carries reject + recurrence rules", () => {
  assert.doesNotMatch(getSystemPrompt("en"), /SCAN HISTORY RULES/);
  const p = getSystemPrompt("en", { hasHistory: true });
  assert.match(p, /SCAN HISTORY RULES/);
  assert.match(p, /REJECTED in a previous scan must NOT be proposed again/);
  assert.match(p, /APPROVED in 3 or more/);
  assert.match(p, /\(recurring\)/);
});

test("locale directive survives the rewrite", () => {
  assert.match(getSystemPrompt("tr", { hasGitops: true }), /Respond entirely in Turkish/);
});

test("user prompt appends history block only when history present", () => {
  const data = { pods: { summary: {} } };
  assert.doesNotMatch(getUserPrompt(data, "warning"), /PREVIOUS SCANS/);
  assert.doesNotMatch(getUserPrompt(data, "warning", []), /PREVIOUS SCANS/);
  const withHistory = getUserPrompt(data, "warning", [{ id: "r1", actions: [] }]);
  assert.match(withHistory, /PREVIOUS SCANS/);
  assert.match(withHistory, /"id":"r1"/);
});

// --- collector helpers ---------------------------------------------------------

const POD_SPEC = {
  containers: [
    {
      name: "app",
      resources: { requests: { memory: "512Mi", cpu: "250m" }, limits: { memory: "1Gi" } },
    },
    { name: "sidecar" }, // no resources block
  ],
  initContainers: [{ name: "init", resources: { limits: { cpu: "100m" } } }],
};

test("currentContainerResources finds app, init, and returns null for unknown", () => {
  assert.deepStrictEqual(currentContainerResources(POD_SPEC, "app"), {
    container: "app",
    requests: { memory: "512Mi", cpu: "250m" },
    limits: { memory: "1Gi" },
  });
  assert.deepStrictEqual(currentContainerResources(POD_SPEC, "sidecar"), {
    container: "sidecar",
    requests: null,
    limits: null,
  });
  assert.strictEqual(currentContainerResources(POD_SPEC, "init").limits.cpu, "100m");
  assert.strictEqual(currentContainerResources(POD_SPEC, "nope"), null);
  assert.strictEqual(currentContainerResources(undefined, "app"), null);
});

test("currentPodResources lists non-init containers", () => {
  const out = currentPodResources(POD_SPEC);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].container, "app");
  assert.strictEqual(out[0].limits.memory, "1Gi");
  assert.deepStrictEqual(currentPodResources(undefined), []);
});

// --- gitops digest -------------------------------------------------------------

const DIGEST_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: repo/api:v2
          resources:
            requests: { memory: 512Mi }
            limits: { memory: 1Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: api
`;

const DIGEST_CRONJOB = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
  namespace: prod
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: job
              image: repo/job:v1
`;

test("extractWorkloadDigest extracts workloads, skips non-workloads and broken yaml", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"));
  tmpDirs.push(repoRoot);
  const folder = "apps";
  fs.mkdirSync(path.join(repoRoot, folder, "nested"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, folder, "api.yaml"), DIGEST_DEPLOYMENT);
  fs.writeFileSync(path.join(repoRoot, folder, "nested", "cron.yml"), DIGEST_CRONJOB);
  fs.writeFileSync(path.join(repoRoot, folder, "broken.yaml"), "{ not: [valid");
  fs.writeFileSync(path.join(repoRoot, folder, "notes.txt"), "kind: Deployment");

  const digest = extractWorkloadDigest(repoRoot, folder);
  assert.strictEqual(digest.workload_count, 2);

  const dep = digest.workloads.find((w) => w.kind === "Deployment");
  assert.strictEqual(dep.name, "api");
  assert.strictEqual(dep.namespace, "prod");
  assert.strictEqual(dep.replicas, 3);
  assert.strictEqual(dep.file, path.join("apps", "api.yaml"));
  assert.deepStrictEqual(dep.containers, [
    {
      container: "api",
      image: "repo/api:v2",
      requests: { memory: "512Mi" },
      limits: { memory: "1Gi" },
    },
  ]);

  // CronJob pod spec lives under jobTemplate
  const cron = digest.workloads.find((w) => w.kind === "CronJob");
  assert.strictEqual(cron.containers[0].image, "repo/job:v1");
  // Service and the txt/broken files contribute nothing
  assert.ok(digest.workloads.every((w) => w.kind !== "Service"));
});

// --- engine.fetchScanHistory -----------------------------------------------------

function makeEngine() {
  // Constructor shape mirrors app.js wiring; only serverUrl/apiKey matter here.
  return new DiagnosticsEngine({
    serverUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    k8sCoreApi: null,
    k8sAppsApi: null,
    k8sBatchApi: null,
    queryPrometheus: async () => [],
  });
}

test("fetchScanHistory returns null on network failure (never throws)", async () => {
  const engine = makeEngine();
  const result = await engine.fetchScanHistory(); // port 9 → connection refused
  assert.strictEqual(result, null);
});

test("fetchScanHistory returns null on non-ok / empty and scans on success", async (t) => {
  const engine = makeEngine();
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({ ok: false, status: 404 });
  assert.strictEqual(await engine.fetchScanHistory(), null);

  global.fetch = async () => ({ ok: true, json: async () => ({ data: { scans: [] } }) });
  assert.strictEqual(await engine.fetchScanHistory(), null);

  const scans = [{ id: "r1", actions: [{ action_type: "restart_pod", status: "rejected" }] }];
  global.fetch = async (url) => {
    assert.match(String(url), /\/api\/v1\/agent\/doctor\/history\?limit=5$/);
    return { ok: true, json: async () => ({ data: { scans } }) };
  };
  assert.deepStrictEqual(await engine.fetchScanHistory(), scans);
});
