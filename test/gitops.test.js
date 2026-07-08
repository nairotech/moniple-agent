const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const gitops = require("../diagnostics/gitops");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeFixtureRepo(files) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-fixture-"));
  tmpDirs.push(repoRoot);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return repoRoot;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture YAML content
// ---------------------------------------------------------------------------

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: app-backend
spec:
  replicas: 2 # keep this comment
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1
`;

const DEPLOYMENT_NO_NS_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1
`;

const HELM_DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: app-backend
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1
`;

const RESOURCE_DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: app-backend
spec:
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1
          resources:
            requests:
              cpu: 100m
            limits:
              cpu: 200m
`;

const MULTI_CONTAINER_DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: app-backend
spec:
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1
        - name: sidecar
          image: repo/sidecar:v1
`;

const PVC_YAML = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
  namespace: app-backend
spec:
  storageClassName: local-path
  resources:
    requests:
      storage: 10Gi
`;

const KUSTOMIZATION_REPLICAS_YAML = `resources:
  - app-backend.yaml
replicas:
  - name: app-backend
    count: 5
`;

const KUSTOMIZATION_IMAGES_YAML = `resources:
  - app-backend.yaml
images:
  - name: repo/app
    newTag: v2
`;

// ---------------------------------------------------------------------------
// sanitizeFolder
// ---------------------------------------------------------------------------

test("sanitizeFolder: rejects '..' traversal", () => {
  assert.throws(() => gitops.sanitizeFolder("a/../b"));
});

test("sanitizeFolder: normalizes a trailing slash", () => {
  assert.strictEqual(gitops.sanitizeFolder("clusters/prod/"), "clusters/prod");
});

test("sanitizeFolder: rejects a leading slash (absolute path)", () => {
  assert.throws(() => gitops.sanitizeFolder("/abs"));
});

test("sanitizeFolder: rejects empty string", () => {
  assert.throws(() => gitops.sanitizeFolder(""));
});

test("sanitizeFolder: rejects non-string input", () => {
  assert.throws(() => gitops.sanitizeFolder(undefined));
  assert.throws(() => gitops.sanitizeFolder(null));
});

test("sanitizeFolder: is idempotent on an already-clean path", () => {
  assert.strictEqual(gitops.sanitizeFolder("clusters/prod"), "clusters/prod");
});

// ---------------------------------------------------------------------------
// assertInsideFolder
// ---------------------------------------------------------------------------

test("assertInsideFolder: allows a path inside the configured folder", () => {
  const repoRoot = makeFixtureRepo({ "base/in.yaml": "a: 1\n" });
  assert.doesNotThrow(() => gitops.assertInsideFolder(repoRoot, "base", path.join(repoRoot, "base", "in.yaml")));
});

test("assertInsideFolder: throws when the path escapes the configured folder", () => {
  const repoRoot = makeFixtureRepo({ "base/in.yaml": "a: 1\n", "other/out.yaml": "a: 1\n" });
  assert.throws(() => gitops.assertInsideFolder(repoRoot, "base", path.join(repoRoot, "other", "out.yaml")));
});

test("assertInsideFolder: throws when a symlink inside the folder escapes the repo", () => {
  const repoRoot = makeFixtureRepo({ "base/placeholder.yaml": "a: 1\n" });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-outside-"));
  tmpDirs.push(outsideDir);
  const outsideFile = path.join(outsideDir, "secret.yaml");
  fs.writeFileSync(outsideFile, "a: 1\n");
  const linkPath = path.join(repoRoot, "base", "escape.yaml");
  fs.symlinkSync(outsideFile, linkPath);
  assert.throws(() => gitops.assertInsideFolder(repoRoot, "base", linkPath));
});

// ---------------------------------------------------------------------------
// mapActionToTarget
// ---------------------------------------------------------------------------

test("mapActionToTarget: returns null for runtime-only action types", () => {
  const runtimeOnly = [
    "restart_pod",
    "restart_deployment",
    "delete_pod",
    "delete_job",
    "cordon_node",
    "uncordon_node",
    "update_agent",
    "something_unknown",
  ];
  for (const action_type of runtimeOnly) {
    assert.strictEqual(gitops.mapActionToTarget({ action_type }), null, `expected null for ${action_type}`);
  }
});

test("mapActionToTarget: maps the four eligible action types to a kind + field", () => {
  assert.strictEqual(gitops.mapActionToTarget({ action_type: "scale_deployment", parameters: { replicas: 3 } }).kind, "Deployment");
  assert.strictEqual(
    gitops.mapActionToTarget({ action_type: "adjust_resources", parameters: { container: "app", resource: "cpu", request: "1" } }).kind,
    "Deployment",
  );
  assert.strictEqual(gitops.mapActionToTarget({ action_type: "expand_pvc", parameters: { new_size: "1Gi" } }).kind, "PersistentVolumeClaim");
  assert.strictEqual(gitops.mapActionToTarget({ action_type: "rollback_deployment", parameters: {} }).kind, "Deployment");
});

// ---------------------------------------------------------------------------
// resolveTarget — scale_deployment
// ---------------------------------------------------------------------------

test("resolveTarget: scale_deployment ready", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.file, "base/app-backend.yaml");
  assert.strictEqual(result.field_path, "spec.replicas");
  assert.strictEqual(result.before, "2");
  assert.strictEqual(result.after, "3");
});

test("resolveTarget: ambiguous when two files declare the same Deployment", () => {
  const repoRoot = makeFixtureRepo({ "base/a.yaml": DEPLOYMENT_YAML, "base/b.yaml": DEPLOYMENT_YAML });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ambiguous");
});

test("resolveTarget: helm_templated when the target field's source region contains {{", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": HELM_DEPLOYMENT_YAML });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "helm_templated");
});

test("resolveTarget: no_match when the named resource isn't found", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "does-not-exist",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "no_match");
});

test("resolveTarget: matches when the doc's namespace is unspecified", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_NO_NS_YAML });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
});

test("resolveTarget: no_match when the doc's namespace mismatches the action's namespace", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML }); // namespace: app-backend
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "some-other-namespace",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "no_match");
});

test("resolveTarget: runtime_only for a non-eligible action type", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML });
  const result = gitops.resolveTarget(repoRoot, "base", {
    action_type: "restart_pod",
    target_name: "app-backend",
    target_namespace: "app-backend",
  });
  assert.strictEqual(result.status, "runtime_only");
});

// ---------------------------------------------------------------------------
// resolveTarget — adjust_resources (dual leaves, amendment 3)
// ---------------------------------------------------------------------------

test("resolveTarget: adjust_resources ready with dual leaves (requests + limits)", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": RESOURCE_DEPLOYMENT_YAML });
  const action = {
    action_type: "adjust_resources",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { container: "app", resource: "cpu", request: "150m", limit: "300m" },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.field_path, "spec.template.spec.containers[app].resources");
  assert.strictEqual(result.before, "requests.cpu=100m, limits.cpu=200m");
  assert.strictEqual(result.after, "requests.cpu=150m, limits.cpu=300m");
  assert.strictEqual(result.edits.length, 2);
});

test("resolveTarget: adjust_resources ready with a single leaf still uses the compact display", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": RESOURCE_DEPLOYMENT_YAML });
  const action = {
    action_type: "adjust_resources",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { container: "app", resource: "cpu", request: "150m" },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.before, "requests.cpu=100m");
  assert.strictEqual(result.after, "requests.cpu=150m");
  assert.strictEqual(result.edits.length, 1);
});

test("resolveTarget: adjust_resources no_match when the container isn't in the deployment", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": RESOURCE_DEPLOYMENT_YAML });
  const action = {
    action_type: "adjust_resources",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { container: "sidecar", resource: "cpu", request: "150m" },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "no_match");
});

test("resolveTarget: adjust_resources can add a leaf that doesn't exist yet", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML }); // no resources block at all
  const action = {
    action_type: "adjust_resources",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { container: "app", resource: "memory", limit: "512Mi" },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.before, "limits.memory=(unset)");
  assert.strictEqual(result.after, "limits.memory=512Mi");
});

// ---------------------------------------------------------------------------
// resolveTarget — expand_pvc
// ---------------------------------------------------------------------------

test("resolveTarget: expand_pvc ready", () => {
  const repoRoot = makeFixtureRepo({ "base/data-pvc.yaml": PVC_YAML });
  const action = {
    action_type: "expand_pvc",
    target_kind: "PersistentVolumeClaim",
    target_name: "data-pvc",
    target_namespace: "app-backend",
    parameters: { new_size: "20Gi" },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.field_path, "spec.resources.requests.storage");
  assert.strictEqual(result.before, "10Gi");
  assert.strictEqual(result.after, "20Gi");
});

// ---------------------------------------------------------------------------
// resolveTarget — rollback_deployment (amendment 4)
// ---------------------------------------------------------------------------

test("resolveTarget: rollback_deployment ready with a preview placeholder (no resolvedImage yet)", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML });
  const action = {
    action_type: "rollback_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: {},
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.before, "repo/app:v1");
  assert.strictEqual(result.after, "(previous revision image — resolved at execution)");
});

test("resolveTarget: rollback_deployment resolves the real image once resolvedImage is known", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": DEPLOYMENT_YAML });
  const action = {
    action_type: "rollback_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: {},
  };
  const result = gitops.resolveTarget(repoRoot, "base", action, { resolvedImage: "repo/app:v0" });
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(result.after, "repo/app:v0");
  assert.strictEqual(result.edits[0].value, "repo/app:v0");
});

test("resolveTarget: rollback_deployment ambiguous when the deployment has multiple containers", () => {
  const repoRoot = makeFixtureRepo({ "base/app-backend.yaml": MULTI_CONTAINER_DEPLOYMENT_YAML });
  const action = {
    action_type: "rollback_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: {},
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ambiguous");
});

// ---------------------------------------------------------------------------
// resolveTarget — kustomize overlay detection (amendment 5)
// ---------------------------------------------------------------------------

test("resolveTarget: kustomize replicas transformer makes scale_deployment ambiguous", () => {
  const repoRoot = makeFixtureRepo({
    "base/app-backend.yaml": DEPLOYMENT_YAML,
    "base/kustomization.yaml": KUSTOMIZATION_REPLICAS_YAML,
  });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ambiguous");
  assert.match(result.note, /kustomize/);
});

test("resolveTarget: kustomize images transformer makes rollback_deployment ambiguous", () => {
  const repoRoot = makeFixtureRepo({
    "base/app-backend.yaml": DEPLOYMENT_YAML,
    "base/kustomization.yaml": KUSTOMIZATION_IMAGES_YAML,
  });
  const action = {
    action_type: "rollback_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: {},
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ambiguous");
  assert.match(result.note, /kustomize/);
});

test("resolveTarget: a kustomization.yaml with no relevant transformer does not block scale_deployment", () => {
  const repoRoot = makeFixtureRepo({
    "base/app-backend.yaml": DEPLOYMENT_YAML,
    "base/kustomization.yaml": "resources:\n  - app-backend.yaml\n",
  });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const result = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(result.status, "ready");
});

// ---------------------------------------------------------------------------
// applyEditInPlace — surgical, comment/order preserving
// ---------------------------------------------------------------------------

test("applyEditInPlace: single edit changes only the target line, preserving an unrelated comment", () => {
  const text = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1 # do not touch this image
`;
  const result = gitops.applyEditInPlace(text, [{ path: ["spec", "replicas"], value: 3 }]);
  const expected = text.replace("replicas: 2", "replicas: 3");
  assert.strictEqual(result, expected);
});

test("applyEditInPlace: dual edits (adjust_resources) touch only the two target leaves", () => {
  const result = gitops.applyEditInPlace(RESOURCE_DEPLOYMENT_YAML, [
    { path: ["spec", "template", "spec", "containers", 0, "resources", "requests", "cpu"], value: "150m" },
    { path: ["spec", "template", "spec", "containers", 0, "resources", "limits", "cpu"], value: "300m" },
  ]);
  const expected = RESOURCE_DEPLOYMENT_YAML.replace("cpu: 100m", "cpu: 150m").replace("cpu: 200m", "cpu: 300m");
  assert.strictEqual(result, expected);
});

test("applyEditInPlace: multi-doc file edits only the matching document, byte-for-byte elsewhere", () => {
  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: unrelated
data:
  foo: bar
`;
  const combined = configMap + "---\n" + DEPLOYMENT_YAML;
  const result = gitops.applyEditInPlace(combined, [{ path: ["spec", "replicas"], value: 5 }]);
  const expected = combined.replace("replicas: 2 # keep this comment", "replicas: 5 # keep this comment");
  assert.strictEqual(result, expected);
  // The ConfigMap portion is untouched byte-for-byte.
  assert.ok(result.startsWith(configMap));
});

test("applyEditInPlace: unmodified round-trip through a multi-doc file is byte-identical when re-serialized", () => {
  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: unrelated
data:
  foo: bar
`;
  const combined = configMap + "---\n" + DEPLOYMENT_YAML;
  // Editing a field that has nothing to do with the ConfigMap must leave it
  // byte-identical, proving no full-file reserialize happens.
  const result = gitops.applyEditInPlace(combined, [{ path: ["spec", "replicas"], value: 2 }]);
  assert.strictEqual(result, combined);
});

test("applyEditInPlace: throws with no edits", () => {
  assert.throws(() => gitops.applyEditInPlace("a: 1\n", []));
});
