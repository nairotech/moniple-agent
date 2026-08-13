/**
 * Least-privilege RBAC (2026-08-13).
 *
 * The agent used to ship a ClusterRole with cluster-wide `secrets` (which is
 * cluster-admin-equivalent — every ServiceAccount token in the cluster is a
 * Secret) plus full management of ClusterRoles/ClusterRoleBindings, and it
 * re-applied that role to ITSELF on every start ("self-heal"), so an image
 * update could widen its own privileges without the operator agreeing.
 *
 * These tests pin the replacement:
 *   - the shipped manifests grant no cluster-wide secrets and no RBAC write;
 *   - Secret access is namespaced to the install namespace via a Role;
 *   - kube-state-metrics is scoped to the objects Moniple actually queries,
 *     and its --resources flag matches its ClusterRole;
 *   - when the API server says the agent may not create ClusterRoles, the
 *     installer skips RBAC objects instead of 403-spamming, and it reports
 *     what is missing.
 *
 * `lib/k8s/client` is replaced in the require cache before `lib/k8s/monitoring`
 * loads. `node --test` gives every file its own process, so this cannot leak.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ---------------------------------------------------------------------------
// k8s client stub
// ---------------------------------------------------------------------------
const clientPath = require.resolve("../lib/k8s/client");

const calls = [];
let ssarAllowed = false;
let ssarThrows = false;

function record(name) {
  return async (...args) => {
    calls.push({ name, args });
    // Every read the installer performs is a "does it exist" probe; answering
    // 404 makes it take the create path, which is what we want to observe.
    if (name.startsWith("read")) {
      const err = new Error("not found");
      err.statusCode = 404;
      throw err;
    }
    return { body: {} };
  };
}

const rbacApi = {
  readClusterRole: record("readClusterRole"),
  replaceClusterRole: record("replaceClusterRole"),
  createClusterRole: record("createClusterRole"),
  readClusterRoleBinding: record("readClusterRoleBinding"),
  replaceClusterRoleBinding: record("replaceClusterRoleBinding"),
  createClusterRoleBinding: record("createClusterRoleBinding"),
};

const coreApi = {
  readNamespace: record("readNamespace"),
  createNamespace: record("createNamespace"),
  readNamespacedServiceAccount: record("readNamespacedServiceAccount"),
  createNamespacedServiceAccount: record("createNamespacedServiceAccount"),
};

const authApi = {
  createSelfSubjectAccessReview: async (body) => {
    calls.push({ name: "selfSubjectAccessReview", args: [body] });
    if (ssarThrows) throw new Error("SSAR unavailable");
    return { body: { status: { allowed: ssarAllowed } } };
  },
};

require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    getCoreApi: () => coreApi,
    getAppsApi: () => ({}),
    getRbacApi: () => rbacApi,
    getBatchApi: () => ({}),
    getStorageApi: () => ({}),
    getAuthApi: () => authApi,
  },
};

const monitoring = require("../lib/k8s/monitoring");

function reset({ allowed = false, throws = false } = {}) {
  calls.length = 0;
  ssarAllowed = allowed;
  ssarThrows = throws;
  monitoring._resetRbacCapabilityCache();
}

// ---------------------------------------------------------------------------
// manifest guards
// ---------------------------------------------------------------------------
const manifestsDir = path.join(__dirname, "..", "manifests");

function docsOf(file) {
  return yaml
    .loadAll(fs.readFileSync(path.join(manifestsDir, file), "utf8"))
    .filter(Boolean);
}

const RBAC_FILES = ["moniple-agent-rbac.yaml", "moniple-agent-rbac-minimal.yaml"];

for (const file of RBAC_FILES) {
  test(`${file}: agent ClusterRole never grants cluster-wide secrets`, () => {
    const cr = docsOf(file).find(
      (d) => d.kind === "ClusterRole" && d.metadata.name === "moniple-agent",
    );
    assert.ok(cr, "ClusterRole moniple-agent exists");
    for (const rule of cr.rules) {
      assert.ok(
        !(rule.resources || []).includes("secrets"),
        "cluster-wide `secrets` is cluster-admin-equivalent — never grant it",
      );
    }
  });

  test(`${file}: agent ClusterRole cannot write RBAC`, () => {
    const cr = docsOf(file).find(
      (d) => d.kind === "ClusterRole" && d.metadata.name === "moniple-agent",
    );
    const writeVerbs = ["create", "update", "patch", "delete", "escalate", "bind", "*"];
    for (const rule of cr.rules) {
      if (!(rule.apiGroups || []).includes("rbac.authorization.k8s.io")) continue;
      for (const v of rule.verbs) {
        assert.ok(
          !writeVerbs.includes(v),
          `RBAC write verb "${v}" would let an image update grant itself anything`,
        );
      }
    }
  });

  test(`${file}: Doctor reads stay intact (events, pod logs, storage classes)`, () => {
    const cr = docsOf(file).find(
      (d) => d.kind === "ClusterRole" && d.metadata.name === "moniple-agent",
    );
    const core = cr.rules.find(
      (r) => (r.apiGroups || []).includes("") && r.verbs.includes("list"),
    );
    // 2026-07-16 regression: without core `events` every cluster 403s on the
    // Doctor's events check.
    assert.ok(core.resources.includes("events"));
    assert.ok(core.resources.includes("pods"));
    assert.ok(core.resources.includes("nodes"));
    assert.ok(core.resources.includes("persistentvolumeclaims"));
    assert.ok(
      cr.rules.some((r) => (r.resources || []).includes("pods/log")),
      "Doctor reads crash logs via pods/log",
    );
    assert.ok(
      cr.rules.some(
        (r) =>
          (r.apiGroups || []).includes("events.k8s.io") &&
          r.resources.includes("events"),
      ),
      "modern events group",
    );
    assert.ok(
      cr.rules.some(
        (r) =>
          (r.apiGroups || []).includes("storage.k8s.io") &&
          r.resources.includes("storageclasses"),
      ),
      "expand_pvc checks allowVolumeExpansion",
    );
  });
}

test("moniple-agent-rbac.yaml: Secret access is namespaced to the install namespace", () => {
  const docs = docsOf("moniple-agent-rbac.yaml");
  const role = docs.find((d) => d.kind === "Role" && d.metadata.name === "moniple-agent");
  assert.ok(role, "namespaced Role exists");
  assert.strictEqual(role.metadata.namespace, "moniple");
  const secretRule = role.rules.find((r) => (r.resources || []).includes("secrets"));
  assert.ok(secretRule, "Role grants secrets in the install namespace");
  assert.deepStrictEqual(
    [...secretRule.verbs].sort(),
    ["create", "get"],
    "only the verbs the installer actually uses",
  );

  const binding = docs.find(
    (d) => d.kind === "RoleBinding" && d.metadata.name === "moniple-agent",
  );
  assert.ok(binding, "RoleBinding exists");
  assert.strictEqual(binding.metadata.namespace, "moniple");
  assert.strictEqual(binding.roleRef.kind, "Role");
  assert.strictEqual(binding.roleRef.name, "moniple-agent");
  assert.deepStrictEqual(binding.subjects, [
    { kind: "ServiceAccount", name: "moniple-agent", namespace: "moniple" },
  ]);
});

test("moniple-agent-rbac.yaml: installer writes are namespaced, remediation writes are explicit", () => {
  const docs = docsOf("moniple-agent-rbac.yaml");
  const cr = docs.find((d) => d.kind === "ClusterRole");
  const role = docs.find((d) => d.kind === "Role");

  // No cluster-wide create/update anywhere.
  for (const rule of cr.rules) {
    for (const v of ["create", "update"]) {
      if (!rule.verbs.includes(v)) continue;
      assert.deepStrictEqual(
        rule.resources,
        ["selfsubjectaccessreviews"],
        `cluster-wide ${v} is only allowed for the self permission check`,
      );
    }
  }

  // The remediation verbs the Doctor executor needs, and nothing more.
  const clusterWrites = cr.rules
    .filter((r) => r.verbs.some((v) => ["delete", "patch"].includes(v)))
    .map((r) => `${(r.apiGroups || [])[0] || "core"}:${r.resources.join(",")}:${r.verbs.join(",")}`)
    .sort();
  assert.deepStrictEqual(clusterWrites, [
    "apps:deployments:patch",
    "batch:jobs:delete",
    "core:nodes:patch",
    "core:persistentvolumeclaims:patch",
    "core:pods:delete",
  ]);

  // The installer can write in its own namespace only.
  const nsResources = role.rules.flatMap((r) => r.resources);
  for (const r of ["serviceaccounts", "configmaps", "services", "deployments", "daemonsets"]) {
    assert.ok(nsResources.includes(r), `Role grants ${r} in the install namespace`);
  }
});

test("kube-state-metrics is scoped to the objects Moniple queries, and its flag matches", () => {
  const docs = docsOf("kube-state-metrics.yaml");
  const cr = docs.find((d) => d.kind === "ClusterRole");
  const core = cr.rules.find((r) => (r.apiGroups || []).includes(""));
  assert.deepStrictEqual([...core.resources].sort(), [
    "namespaces",
    "nodes",
    "persistentvolumeclaims",
    "pods",
  ]);
  assert.deepStrictEqual(core.verbs, ["list", "watch"], "read-only");
  // The stock KSM role includes cluster-wide `secrets: list`.
  const all = cr.rules.flatMap((r) => r.resources || []);
  assert.ok(!all.includes("secrets"), "KSM must not read Secrets");
  assert.ok(!all.includes("configmaps"), "KSM must not read ConfigMaps");

  const dep = docs.find((d) => d.kind === "Deployment");
  const args = dep.spec.template.spec.containers[0].args || [];
  const flag = args.find((a) => a.startsWith("--resources="));
  assert.ok(flag, "KSM is started with an explicit --resources list");
  const flagged = flag.split("=")[1].split(",").sort();
  const granted = cr.rules.flatMap((r) => r.resources).sort();
  assert.deepStrictEqual(
    flagged,
    granted,
    "--resources and the ClusterRole are one contract: a mismatch means either " +
      "silent permission errors or an unused grant",
  );
});

test("vmagent keeps service discovery but not cluster-wide configmap reads", () => {
  const cr = docsOf("victoria-metrics.yaml").find(
    (d) => d.kind === "ClusterRole" && d.metadata.name === "moniple-vmagent",
  );
  const resources = cr.rules.flatMap((r) => r.resources || []);
  for (const r of ["nodes", "nodes/proxy", "nodes/metrics", "services", "endpoints", "pods"]) {
    assert.ok(resources.includes(r), `vmagent still discovers ${r}`);
  }
  assert.ok(!resources.includes("configmaps"), "config comes from a mounted volume");
  assert.ok(!resources.includes("secrets"));
});

// ---------------------------------------------------------------------------
// installer behaviour
// ---------------------------------------------------------------------------
test("without RBAC write the installer skips ClusterRoles instead of 403-spamming", async () => {
  reset({ allowed: false });
  await monitoring.applyManifest(
    path.join(manifestsDir, "kube-state-metrics.yaml"),
    "moniple",
  );
  const names = calls.map((c) => c.name);
  assert.ok(!names.includes("createClusterRole"), "no ClusterRole create attempt");
  assert.ok(!names.includes("replaceClusterRole"), "no ClusterRole replace attempt");
  assert.ok(!names.includes("createClusterRoleBinding"));
  assert.ok(!names.includes("readClusterRole"), "not even a read probe for the write path");
  // The namespaced part of the install still runs.
  assert.ok(names.includes("createNamespacedServiceAccount"));
});

test("with RBAC write (legacy install) the installer still reconciles ClusterRoles", async () => {
  reset({ allowed: true });
  await monitoring.applyManifest(
    path.join(manifestsDir, "kube-state-metrics.yaml"),
    "moniple",
  );
  const names = calls.map((c) => c.name);
  assert.ok(names.includes("createClusterRole"), "legacy behaviour is preserved");
  assert.ok(names.includes("createClusterRoleBinding"));
});

test("ensureRbacFromManifest honours the same gate", async () => {
  reset({ allowed: false });
  await monitoring.ensureRbacFromManifest(
    path.join(manifestsDir, "victoria-metrics.yaml"),
    "moniple",
  );
  const names = calls.map((c) => c.name);
  assert.ok(!names.includes("createClusterRole"));
  assert.ok(!names.includes("replaceClusterRole"));

  reset({ allowed: true });
  await monitoring.ensureRbacFromManifest(
    path.join(manifestsDir, "victoria-metrics.yaml"),
    "moniple",
  );
  assert.ok(calls.map((c) => c.name).includes("createClusterRole"));
});

test("an unanswerable permission check degrades to the previous behaviour", async () => {
  reset({ throws: true });
  assert.strictEqual(
    await monitoring.canWriteClusterRbac(),
    true,
    "unknown must not silently skip an install step",
  );
});

test("the permission check is asked once and memoized", async () => {
  reset({ allowed: false });
  await monitoring.canWriteClusterRbac();
  await monitoring.canWriteClusterRbac();
  await monitoring.canWriteClusterRbac();
  const reviews = calls.filter((c) => c.name === "selfSubjectAccessReview");
  assert.strictEqual(reviews.length, 1);
  assert.deepStrictEqual(reviews[0].args[0].spec.resourceAttributes, {
    group: "rbac.authorization.k8s.io",
    resource: "clusterroles",
    verb: "create",
  });
});

test("missing monitoring ClusterRoles are reported with a concrete instruction", async () => {
  reset({ allowed: false });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const missing = await monitoring.reportMissingClusterRbac();
    assert.deepStrictEqual(missing, [
      "moniple-kube-state-metrics",
      "moniple-vmagent",
    ]);
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Re-apply the Moniple install YAML/);
  assert.match(warnings[0], /moniple-kube-state-metrics/);
});
