/**
 * Tests for the context-aware recommendation inputs added 2026-07-10
 * (docs/superpowers/specs/2026-07-10-doctor-context-aware-recommendations-design.md):
 *  - prompts: conditional GITOPS / SCAN HISTORY sections + resource-accuracy rules
 *  - collector helpers: current requests/limits extraction
 *  - engine: fetchScanHistory / fetchDesiredState never throw, null on failure
 *
 * NOTE (2026-08-13): the desired-state digest is no longer extracted here —
 * the agent holds no repository credential and does no git. The server
 * extracts it (moniple-server src/modules/doctor/gitops.repo.ts,
 * test/gitops-repo.test.js) and the agent fetches the result.
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
  assert.match(p, /APPROVED in 2 or more/);
  assert.match(p, /last 2 diagnostic reports/);
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

// --- engine.fetchScanHistory / fetchDesiredState ---------------------------------

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
    assert.match(String(url), /\/api\/v1\/agent\/doctor\/history\?limit=2$/);
    return { ok: true, json: async () => ({ data: { scans } }) };
  };
  assert.deepStrictEqual(await engine.fetchScanHistory(), scans);
});

test("fetchDesiredState asks the SERVER for the digest (agent never clones)", async (t) => {
  const engine = makeEngine();
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  const digest = {
    workload_count: 1,
    workloads: [{ kind: "Deployment", name: "api", replicas: 3 }],
  };
  let seenUrl = null;
  global.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, json: async () => ({ ok: true, data: { digest } }) };
  };

  assert.deepStrictEqual(await engine.fetchDesiredState(), digest);
  assert.match(seenUrl, /\/api\/v1\/agent\/doctor\/gitops\/desired-state$/);
});

test("fetchDesiredState degrades to null (old server 404, empty digest, network error)", async (t) => {
  const engine = makeEngine();
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  // Older server without the endpoint.
  global.fetch = async () => ({ ok: false, status: 404 });
  assert.strictEqual(await engine.fetchDesiredState(), null);

  // Repo attached but nothing extractable / clone failed server-side.
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { digest: null } }) });
  assert.strictEqual(await engine.fetchDesiredState(), null);

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { digest: { workload_count: 0, workloads: [] } } }),
  });
  assert.strictEqual(await engine.fetchDesiredState(), null);

  // Network error must never escape (a scan can't fail over a digest).
  global.fetch = realFetch;
  assert.strictEqual(await engine.fetchDesiredState(), null); // port 9 → refused
});
