/**
 * Regression tests for the 2026-08-13 GitOps credential fix.
 *
 * Until this change, GET /api/v1/agent/doctor/config handed every cluster
 * agent a DECRYPTED, write-capable GitHub PAT (plus repo url / branch /
 * folder) once a minute, and the agent cloned + committed + pushed with it.
 * The agent's API key sits in the customer's cluster, so anyone with
 * `get pod`/`get secret` there could replay that endpoint and walk off with
 * a credential to the customer's infrastructure repository.
 *
 * The agent now: applies the LIVE patch, reports the result, and does no git
 * at all. The server makes the matching commit. These tests pin that down:
 *
 *   1. the diagnostics code contains no git/gitops module at all;
 *   2. an execution result carries no `gitops` block written by the agent;
 *   3. rollback reports `resolved_image` so the SERVER can finish the repo
 *      edit it can't derive on its own;
 *   4. a scan asks the server for the desired-state digest instead of
 *      cloning, and pushes no agent-computed `gitops_preview`.
 *
 * Reverting any part of the fix (re-adding diagnostics/gitops.js, or calling
 * it from index.js) turns tests 1/2/4 red.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { DiagnosticsEngine } = require("../diagnostics/index");

const DIAG_DIR = path.join(__dirname, "..", "diagnostics");

function diagnosticsSources() {
  return fs
    .readdirSync(DIAG_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(DIAG_DIR, f), "utf8") }));
}

/** Strip comments so "we deliberately don't do X" prose can't fail the scan. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// 1. No git in the agent at all
// ---------------------------------------------------------------------------

test("diagnostics/gitops.js no longer exists (git moved to the server)", () => {
  assert.strictEqual(
    fs.existsSync(path.join(DIAG_DIR, "gitops.js")),
    false,
    "the agent must not carry a git/GitOps module — the server owns the PAT",
  );
});

test("no diagnostics module requires a gitops/git/child_process helper", () => {
  for (const { file, src } of diagnosticsSources()) {
    const code = stripComments(src);
    assert.doesNotMatch(
      code,
      /require\(["'](\.\/)?gitops["']\)/,
      `${file} must not require the gitops module`,
    );
    assert.doesNotMatch(
      code,
      /require\(["']child_process["']\)/,
      `${file} must not spawn subprocesses (no git)`,
    );
    assert.doesNotMatch(
      code,
      /require\(["']yaml["']\)/,
      `${file} must not parse repo YAML — manifests are the server's business now`,
    );
  }
});

test("no diagnostics module reads a pat / credential field off the config", () => {
  for (const { file, src } of diagnosticsSources()) {
    const code = stripComments(src);
    assert.doesNotMatch(
      code,
      /gitops[^\n]*\.pat\b/,
      `${file} must never read a PAT from the server config`,
    );
    assert.doesNotMatch(
      code,
      /\bpat\s*[:=]/,
      `${file} must never carry a PAT field`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2/3. Execution results: no agent-made commit, but enough for the server
// ---------------------------------------------------------------------------

function makeEngine(overrides = {}) {
  const engine = new DiagnosticsEngine({
    serverUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    k8sCoreApi: overrides.k8sCoreApi || {},
    k8sAppsApi: overrides.k8sAppsApi || {},
    k8sBatchApi: overrides.k8sBatchApi || {},
    k8sStorageApi: overrides.k8sStorageApi || {},
    queryPrometheus: async () => [],
  });
  engine.config = overrides.config ?? {
    enabled: true,
    llm: { provider: "openai", model: "gpt-4o", api_key: "k" },
    // Exactly what the server sends now: metadata, no credential, no location.
    gitops: { configured: true, delivery_mode: "commit", managed_by: "server" },
  };
  return engine;
}

test("scale_deployment applies the live patch and returns NO agent-made gitops block", async () => {
  const patched = [];
  const engine = makeEngine({
    k8sAppsApi: {
      async patchNamespacedDeployment(name, ns, patch) {
        patched.push({ name, ns, patch });
      },
    },
  });

  const result = await engine.executeAction({
    id: "a1",
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  });

  assert.strictEqual(patched.length, 1);
  assert.deepStrictEqual(patched[0].patch, { spec: { replicas: 3 } });
  assert.strictEqual(result.action, "deployment_scaled");
  assert.strictEqual(
    "gitops" in result,
    false,
    "the agent must not write a gitops result — the server owns that field",
  );
});

test("rollback_deployment reports resolved_image so the SERVER can finish the repo edit", async () => {
  const previousRS = {
    metadata: {
      annotations: { "deployment.kubernetes.io/revision": "4" },
      ownerReferences: [{ name: "app-backend" }],
    },
    spec: { template: { spec: { containers: [{ name: "app", image: "repo/app:v1" }] } } },
  };
  const currentRS = {
    metadata: {
      annotations: { "deployment.kubernetes.io/revision": "5" },
      ownerReferences: [{ name: "app-backend" }],
    },
    spec: { template: { spec: { containers: [{ name: "app", image: "repo/app:v2" }] } } },
  };

  const engine = makeEngine({
    k8sAppsApi: {
      async listNamespacedReplicaSet() {
        return { body: { items: [currentRS, previousRS] } };
      },
      async patchNamespacedDeployment() {},
    },
  });

  const result = await engine.executeAction({
    id: "a2",
    action_type: "rollback_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: {},
  });

  assert.strictEqual(result.action, "deployment_rolled_back");
  assert.strictEqual(result.resolved_image, "repo/app:v1");
  assert.strictEqual("gitops" in result, false);
});

test("rollback with multiple containers reports resolved_image:null (never guesses)", async () => {
  const previousRS = {
    metadata: {
      annotations: { "deployment.kubernetes.io/revision": "4" },
      ownerReferences: [{ name: "app-backend" }],
    },
    spec: {
      template: {
        spec: {
          containers: [
            { name: "app", image: "repo/app:v1" },
            { name: "sidecar", image: "repo/sidecar:v1" },
          ],
        },
      },
    },
  };
  const currentRS = {
    metadata: {
      annotations: { "deployment.kubernetes.io/revision": "5" },
      ownerReferences: [{ name: "app-backend" }],
    },
    spec: { template: { spec: { containers: [] } } },
  };

  const engine = makeEngine({
    k8sAppsApi: {
      async listNamespacedReplicaSet() {
        return { body: { items: [currentRS, previousRS] } };
      },
      async patchNamespacedDeployment() {},
    },
  });

  const result = await engine.executeAction({
    id: "a3",
    action_type: "rollback_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: {},
  });

  assert.strictEqual(result.resolved_image, null);
});

// ---------------------------------------------------------------------------
// 4. Scan path: server-provided digest, no agent-computed preview
// ---------------------------------------------------------------------------

test("a scan fetches the digest from the server and pushes no gitops_preview", async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  const engine = makeEngine();
  engine.collector.collect = async () => ({ pods: { summary: {} } });

  const urls = [];
  let pushedBody = null;
  global.fetch = async (url, init) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith("/gitops/desired-state")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            digest: {
              workload_count: 1,
              workloads: [{ kind: "Deployment", name: "app-backend", replicas: 2 }],
            },
          },
        }),
      };
    }
    if (u.includes("/doctor/history")) {
      return { ok: true, json: async () => ({ data: { scans: [] } }) };
    }
    if (u.endsWith("/doctor/reports")) {
      pushedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true, data: {} }) };
    }
    return { ok: false, status: 404 };
  };

  // Stub the LLM: one finding with one repo-shaped action.
  const llmModule = require("../diagnostics/llm-client");
  const realAnalyze = llmModule.LLMClient.prototype.analyze;
  t.after(() => {
    llmModule.LLMClient.prototype.analyze = realAnalyze;
  });
  llmModule.LLMClient.prototype.analyze = async () => ({
    analysis: {
      summary: "s",
      severity: "warning",
      findings: [
        {
          title: "under-provisioned",
          severity: "warning",
          category: "resources",
          remediation_actions: [
            {
              action_type: "scale_deployment",
              target_kind: "Deployment",
              target_name: "app-backend",
              target_namespace: "app-backend",
              description: "scale up",
              risk_level: "low",
              parameters: { replicas: 3 },
            },
          ],
        },
      ],
    },
    tokens_used: 10,
  });

  await engine.runDiagnostic("manual", "11111111-1111-1111-1111-111111111111");

  assert.ok(
    urls.some((u) => u.endsWith("/api/v1/agent/doctor/gitops/desired-state")),
    "the scan must ask the SERVER for the desired state",
  );
  assert.ok(pushedBody, "a report was pushed");
  assert.strictEqual(pushedBody.actions.length, 1);
  assert.strictEqual(
    "gitops_preview" in pushedBody.actions[0],
    false,
    "previews are computed server-side; an agent-supplied one would be attacker-controlled text in front of the approving human",
  );
  assert.strictEqual(
    pushedBody.diagnostic_data.gitops_managed,
    true,
    "the server-provided digest still reaches the LLM context",
  );
});
