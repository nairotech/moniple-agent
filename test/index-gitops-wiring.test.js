/**
 * Unit tests for the GitOps wiring added to DiagnosticsEngine in
 * diagnostics/index.js: _applyGitopsEdit (approve path) and
 * _maybeReportGitopsStatus/_gitopsHash (config-refresh path). Uses the same
 * local-bare-repo approach as test/gitops.git.test.js — no network.
 */

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const { DiagnosticsEngine } = require("../diagnostics/index");

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

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

function createBareRepo() {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-seed-"));
  tmpDirs.push(seedDir);
  git(["init", "-q", "-b", "main"], seedDir);
  git(["config", "user.email", "seed@test.local"], seedDir);
  git(["config", "user.name", "Seed"], seedDir);
  fs.mkdirSync(path.join(seedDir, "base"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "base", "app-backend.yaml"), DEPLOYMENT_YAML);
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", "seed"], seedDir);

  const bareDirParent = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-bare-"));
  tmpDirs.push(bareDirParent);
  const bareDir = path.join(bareDirParent, "repo.git");
  git(["clone", "-q", "--bare", seedDir, bareDir]);
  return { bareUrl: `file://${bareDir}`, bareDir };
}

function baseCfg(bareUrl, overrides = {}) {
  return {
    repo_url: bareUrl,
    branch: "main",
    folder: "base",
    pat: "",
    delivery_mode: "commit",
    author_name: "Moniple Doctor",
    author_email: "doctor@moniple.com",
    ...overrides,
  };
}

function makeEngine() {
  // executeAction/_applyGitopsEdit under test never touch k8s — stub args
  // are enough (DiagnosticCollector's constructor does no validation).
  return new DiagnosticsEngine({ serverUrl: "", apiKey: "" });
}

const scaleAction = (overrides = {}) => ({
  id: "wiring-action-1",
  action_type: "scale_deployment",
  target_kind: "Deployment",
  target_name: "app-backend",
  target_namespace: "app-backend",
  parameters: { replicas: 3 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// _applyGitopsEdit
// ---------------------------------------------------------------------------

test("_applyGitopsEdit: no-op (result.gitops left unset) when gitops isn't configured", async () => {
  const engine = makeEngine();
  engine.config = {}; // no gitops block at all
  const result = { action: "deployment_scaled" };
  await engine._applyGitopsEdit(result, scaleAction());
  assert.strictEqual("gitops" in result, false);
});

test("_applyGitopsEdit: attaches the applyEdit result on success (live patch already applied)", async () => {
  const { bareUrl } = createBareRepo();
  const engine = makeEngine();
  engine.config = { gitops: baseCfg(bareUrl) };
  const result = { action: "deployment_scaled", deployment: "app-backend" };
  await engine._applyGitopsEdit(result, scaleAction());

  assert.ok(result.gitops, "result.gitops should be set");
  assert.strictEqual(result.gitops.file, "base/app-backend.yaml");
  assert.strictEqual(result.gitops.field, "spec.replicas");
  assert.strictEqual(result.gitops.before, "2");
  assert.strictEqual(result.gitops.after, "3");
  assert.ok(/^[0-9a-f]{40}$/.test(result.gitops.commit_sha));
});

test("_applyGitopsEdit: a git failure never throws — it's recorded as result.gitops.error, live result untouched", async () => {
  const { bareUrl } = createBareRepo();
  const engine = makeEngine();
  engine.config = { gitops: baseCfg(bareUrl) };
  const result = { action: "deployment_scaled", deployment: "app-backend" };
  // Target doesn't exist under the configured folder -> no_match -> applyEdit throws.
  await engine._applyGitopsEdit(result, scaleAction({ target_name: "does-not-exist" }));

  assert.strictEqual(result.action, "deployment_scaled"); // live result field untouched
  assert.ok(result.gitops && typeof result.gitops.error === "string");
  assert.match(result.gitops.error, /no_match/);
});

test("_applyGitopsEdit: redacts the PAT from the surfaced error (unreachable host)", async () => {
  const fakePat = "FAKEPAT_SECRET_INDEX_WIRING";
  const engine = makeEngine();
  engine.config = { gitops: baseCfg("https://invalid.invalid/org/repo.git", { pat: fakePat }) };
  const result = {};
  await engine._applyGitopsEdit(result, scaleAction());
  assert.ok(result.gitops && typeof result.gitops.error === "string");
  assert.ok(!result.gitops.error.includes(fakePat), "the PAT must never appear in execution_result.gitops.error");
});

// ---------------------------------------------------------------------------
// _gitopsHash / _maybeReportGitopsStatus (config-refresh sig guard)
// ---------------------------------------------------------------------------

test("_gitopsHash: null for an absent config, stable/deterministic for the same config, differs when the config changes", () => {
  const engine = makeEngine();
  assert.strictEqual(engine._gitopsHash(null), null);
  const cfgA = baseCfg("https://example.com/org/repo.git");
  const cfgB = baseCfg("https://example.com/org/repo.git");
  const cfgC = baseCfg("https://example.com/org/other-repo.git");
  assert.strictEqual(engine._gitopsHash(cfgA), engine._gitopsHash(cfgB));
  assert.notStrictEqual(engine._gitopsHash(cfgA), engine._gitopsHash(cfgC));
});

test("_maybeReportGitopsStatus: no-op when gitops has never been configured", async () => {
  const engine = makeEngine();
  engine.config = {};
  await engine._maybeReportGitopsStatus();
  assert.strictEqual(engine._gitopsSig, null);
});

test("_maybeReportGitopsStatus: checks status on first appearance, then skips on an unchanged config (sig guard)", async () => {
  const { bareUrl } = createBareRepo();
  const engine = makeEngine();
  engine.config = { gitops: baseCfg(bareUrl) };

  const t0 = Date.now();
  await engine._maybeReportGitopsStatus(); // first time — gitops just appeared, real ls-remote+clone
  const firstElapsed = Date.now() - t0;
  assert.ok(engine._gitopsSig, "sig should be recorded after the first check");

  const t1 = Date.now();
  await engine._maybeReportGitopsStatus(); // same config again — must be a no-op (sig unchanged)
  const secondElapsed = Date.now() - t1;
  assert.ok(secondElapsed < firstElapsed, "an unchanged config must short-circuit without re-checking status");
  assert.ok(secondElapsed < 20, `expected a near-instant no-op, took ${secondElapsed}ms`);
});

test("_maybeReportGitopsStatus: gitops being removed is handled without throwing", async () => {
  const { bareUrl } = createBareRepo();
  const engine = makeEngine();
  engine.config = { gitops: baseCfg(bareUrl) };
  await engine._maybeReportGitopsStatus();
  assert.ok(engine._gitopsSig);

  engine.config = {}; // gitops removed/disabled
  await assert.doesNotReject(engine._maybeReportGitopsStatus());
  assert.strictEqual(engine._gitopsSig, null);
});

// ---------------------------------------------------------------------------
// fetchConfig: fire-and-forget GitOps status check (FINDING 7, 2026-07-08
// review) — _maybeReportGitopsStatus does a real ls-remote + sparse clone
// (up to ~30-60s against a slow/unreachable host) and must never block
// fetchConfig, which is on the hot path of the 60s poll loop.
// ---------------------------------------------------------------------------

test("fetchConfig: resolves without waiting for _maybeReportGitopsStatus to finish (fire-and-forget)", async () => {
  const engine = makeEngine();
  engine.serverUrl = "http://fake-server.test";
  engine.apiKey = "fake-key";

  let statusCheckStarted = false;
  let statusCheckFinished = false;
  // Stub out the (normally git-touching) status check with a slow promise —
  // deterministic and fast to run, but still long enough that "fetchConfig
  // returned before this resolved" is an unambiguous, non-flaky assertion.
  engine._maybeReportGitopsStatus = () =>
    new Promise((resolve) => {
      statusCheckStarted = true;
      setTimeout(() => {
        statusCheckFinished = true;
        resolve();
      }, 300);
    });

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      data: { enabled: true, gitops: { repo_url: "https://example.com/org/repo.git", folder: "base" } },
    }),
  });

  try {
    const t0 = Date.now();
    const config = await engine.fetchConfig();
    const elapsed = Date.now() - t0;

    assert.ok(config, "fetchConfig should resolve with the config");
    assert.ok(statusCheckStarted, "the gitops status check should have been kicked off");
    assert.strictEqual(statusCheckFinished, false, "fetchConfig must not wait for the slow status check to finish");
    assert.ok(elapsed < 100, `fetchConfig should return almost immediately, took ${elapsed}ms`);
  } finally {
    global.fetch = originalFetch;
  }

  // Let the background check actually finish before the file exits, so it
  // doesn't leak a dangling timer / produce a late unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(statusCheckFinished, "the background status check should eventually complete on its own");
});

test("fetchConfig: a synchronous throw inside _maybeReportGitopsStatus never becomes an unhandled rejection", async () => {
  const engine = makeEngine();
  engine.serverUrl = "http://fake-server.test";
  engine.apiKey = "fake-key";

  // Simulate _gitopsHash (or anything else in the synchronous prefix of
  // _maybeReportGitopsStatus) throwing — fetchConfig's `void ...catch(...)`
  // wiring must still swallow it rather than crashing the process.
  engine._maybeReportGitopsStatus = async () => {
    throw new Error("boom from status check");
  };

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, data: { enabled: true, gitops: { repo_url: "https://example.com/org/repo.git", folder: "base" } } }),
  });

  let unhandled = null;
  const onUnhandledRejection = (err) => {
    unhandled = err;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const config = await engine.fetchConfig();
    assert.ok(config, "fetchConfig should still resolve with the config despite the background failure");
    // Give the fire-and-forget rejection a tick to surface if it were going
    // to become unhandled.
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(unhandled, null, "the background failure must never become an unhandled rejection");
  } finally {
    global.fetch = originalFetch;
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});
