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

// FINDING 5 (2026-07-08 review): a segment starting with '-' could be
// misread as a git option by a downstream invocation (e.g.
// `sparse-checkout set <folder>`) rather than a path.
test("sanitizeFolder: rejects a folder whose first segment starts with '-'", () => {
  assert.throws(() => gitops.sanitizeFolder("-x"));
  assert.throws(() => gitops.sanitizeFolder("--upload-pack=evil"));
});

test("sanitizeFolder: rejects a folder whose non-first segment starts with '-'", () => {
  assert.throws(() => gitops.sanitizeFolder("clusters/-rf"));
});

test("sanitizeFolder: a segment merely containing (not starting with) '-' is fine", () => {
  assert.strictEqual(gitops.sanitizeFolder("clusters/prod-eu-west"), "clusters/prod-eu-west");
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
// resolveTarget + applyEditInPlace — multi-doc docIndex threading
// (FINDING 1 / FINDING 6, 2026-07-08 review): a multi-doc file previously
// had its edit applied to the WRONG document whenever the depth-heuristic in
// applyEditInPlace tied (e.g. two Deployments that both resolve
// spec.replicas) — reviewer reproduced targeting app-backend actually
// scaling app-frontend. resolveTarget now records which document (by
// ordinal index within the file) it matched by kind+name+namespace, and
// applyEdit threads that docIndex into applyEditInPlace so it is used
// directly instead of re-derived by the ambiguous heuristic.
// ---------------------------------------------------------------------------

const FRONTEND_DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-frontend
  namespace: app-frontend
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          image: repo/frontend:v1
`;

const STATEFULSET_SAME_NAME_YAML = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: app-backend
  namespace: app-backend
spec:
  replicas: 2
  serviceName: app-backend
  template:
    spec:
      containers:
        - name: app
          image: repo/statefulset:v1
`;

test("resolveTarget: two Deployments in one file — records the matched doc's ordinal index (docIndex), not just its file", () => {
  const combined = FRONTEND_DEPLOYMENT_YAML + "---\n" + DEPLOYMENT_YAML; // app-frontend is doc 0, app-backend is doc 1
  const repoRoot = makeFixtureRepo({ "base/multi.yaml": combined });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const resolved = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(resolved.status, "ready");
  assert.strictEqual(resolved.file, "base/multi.yaml");
  assert.strictEqual(resolved.docIndex, 1);
});

test("resolveTarget + applyEditInPlace (FINDING 1 regression, case a): two Deployments in one file — scaling app-backend changes ONLY app-backend's doc; app-frontend's doc is byte-identical", () => {
  const combined = FRONTEND_DEPLOYMENT_YAML + "---\n" + DEPLOYMENT_YAML;
  const repoRoot = makeFixtureRepo({ "base/multi.yaml": combined });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 3 },
  };
  const resolved = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(resolved.status, "ready");

  const updated = gitops.applyEditInPlace(combined, resolved.edits, resolved.docIndex);
  const [frontendPart, backendPart] = updated.split("---\n");

  // Proof line 1: the correct doc (app-backend) actually changed.
  assert.ok(backendPart.includes("replicas: 3 # keep this comment"));
  assert.ok(!backendPart.includes("replicas: 2"));
  // Proof line 2: the other doc (app-frontend) is byte-identical to its
  // original text — nothing else was touched.
  assert.strictEqual(frontendPart, FRONTEND_DEPLOYMENT_YAML);
  // Proof line 3: exactly one line differs across the WHOLE file.
  const changedLines = diffLineCount(combined, updated);
  assert.strictEqual(changedLines, 1);
});

test("resolveTarget + applyEditInPlace (FINDING 1 regression, case b): a same-named StatefulSet BEFORE the target Deployment in one file — the Deployment (not the StatefulSet) is edited", () => {
  // Both docs are named "app-backend" (a StatefulSet and headless-service
  // style co-located Deployment sharing a name is a common real-world
  // pattern) and BOTH have a top-level spec.replicas — so the OLD
  // depth-heuristic (which ignores kind/name entirely) would score them
  // identically and silently edit the first (StatefulSet) doc instead.
  const combined = STATEFULSET_SAME_NAME_YAML + "---\n" + DEPLOYMENT_YAML;
  const repoRoot = makeFixtureRepo({ "base/multi.yaml": combined });
  const action = {
    action_type: "scale_deployment",
    target_kind: "Deployment",
    target_name: "app-backend",
    target_namespace: "app-backend",
    parameters: { replicas: 4 },
  };
  const resolved = gitops.resolveTarget(repoRoot, "base", action);
  assert.strictEqual(resolved.status, "ready");
  assert.strictEqual(resolved.docIndex, 1); // the Deployment is the 2nd doc

  const updated = gitops.applyEditInPlace(combined, resolved.edits, resolved.docIndex);
  const [statefulSetPart, deploymentPart] = updated.split("---\n");

  assert.strictEqual(statefulSetPart, STATEFULSET_SAME_NAME_YAML, "the StatefulSet doc must be untouched");
  assert.ok(deploymentPart.includes("replicas: 4 # keep this comment"));
  assert.ok(!deploymentPart.includes("replicas: 2"));
});

test("applyEditInPlace: an explicit docIndex is used directly even when the depth heuristic would tie on the wrong (first) doc", () => {
  // Both docs are structurally identical (Deployment + spec.replicas) so
  // pickTargetDocIndex's depth score ties and — pre-fix — always resolved to
  // doc 0. Passing docIndex=1 explicitly must still edit doc 1.
  const combined = FRONTEND_DEPLOYMENT_YAML + "---\n" + DEPLOYMENT_YAML;
  const updated = gitops.applyEditInPlace(combined, [{ path: ["spec", "replicas"], value: 9 }], 1);
  const [frontendPart, backendPart] = updated.split("---\n");
  assert.strictEqual(frontendPart, FRONTEND_DEPLOYMENT_YAML);
  assert.ok(backendPart.includes("replicas: 9 # keep this comment"));
});

test("applyEditInPlace: an out-of-range docIndex throws rather than silently falling back to the heuristic", () => {
  assert.throws(() => gitops.applyEditInPlace(DEPLOYMENT_YAML, [{ path: ["spec", "replicas"], value: 3 }], 5), /out of range/);
  assert.throws(() => gitops.applyEditInPlace(DEPLOYMENT_YAML, [{ path: ["spec", "replicas"], value: 3 }], -1), /out of range/);
});

test("applyEditInPlace: omitting docIndex still falls back to the depth heuristic (backward compat for direct callers)", () => {
  // Single-doc file: heuristic and explicit docIndex=0 must agree.
  const withIndex = gitops.applyEditInPlace(DEPLOYMENT_YAML, [{ path: ["spec", "replicas"], value: 7 }], 0);
  const withoutIndex = gitops.applyEditInPlace(DEPLOYMENT_YAML, [{ path: ["spec", "replicas"], value: 7 }]);
  assert.strictEqual(withIndex, withoutIndex);
});

// FINDING 6: the `yaml` lib normalizes the whitespace run before an inline
// comment down to a single space on serialization — even mutating the
// existing scalar node's `.value` in place (not just via a fresh setIn)
// exhibits this, so it isn't something applyEditInPlace's own code
// introduces or can cheaply prevent. Accept it (per the finding), but lock
// in the behavior and prove NOTHING else on the line (or file) changes.
test("applyEditInPlace: a multi-space inline comment gap collapses to a single space (known yaml-lib limitation) — only the edited line changes, comment text is preserved", () => {
  const text = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
spec:
  replicas: 5   # x
  template:
    spec:
      containers:
        - name: app
          image: repo/app:v1
`;
  const result = gitops.applyEditInPlace(text, [{ path: ["spec", "replicas"], value: 3 }]);

  const originalLines = text.split("\n");
  const resultLines = result.split("\n");
  const changedIdx = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i] !== resultLines[i]) changedIdx.push(i);
  }
  assert.deepStrictEqual(changedIdx, [originalLines.indexOf("  replicas: 5   # x")], "exactly one line must change");
  assert.strictEqual(resultLines[changedIdx[0]], "  replicas: 3 # x", "value updates, comment TEXT is preserved (spacing collapses — accepted)");
});

function diffLineCount(a, b) {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const max = Math.max(linesA.length, linesB.length);
  let count = 0;
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) count++;
  }
  return count;
}

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
