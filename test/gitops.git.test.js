/**
 * Integration tests for the git-touching parts of diagnostics/gitops.js
 * (withRepo, applyEdit, checkStatus). Uses a LOCAL bare repo created via
 * `git init --bare` in a tmp dir — no network access required or attempted
 * for the core assertions. Two tests intentionally target a DNS-reserved
 * (.invalid, RFC 2606) hostname to exercise the credential-redaction path
 * on a realistic https remote — this fails via local resolver error, not a
 * real network round-trip.
 */

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const gitops = require("../diagnostics/gitops");

const tmpDirs = [];
function track(dir) {
  tmpDirs.push(dir);
  return dir;
}
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

/**
 * Build seed + bare repos:
 *   seed/base/app-backend.yaml   (in the gitops-configured folder)
 *   seed/other/unrelated.yaml    (OUTSIDE the folder — used for the
 *                                 out-of-folder / sparse-checkout jail test)
 * Returns { bareUrl, bareDir, seedDir }.
 */
function createBareRepo() {
  const seedDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "gitops-seed-")));
  git(["init", "-q", "-b", "main"], seedDir);
  git(["config", "user.email", "seed@test.local"], seedDir);
  git(["config", "user.name", "Seed"], seedDir);
  fs.mkdirSync(path.join(seedDir, "base"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "base", "app-backend.yaml"), DEPLOYMENT_YAML);
  fs.mkdirSync(path.join(seedDir, "other"), { recursive: true });
  fs.writeFileSync(
    path.join(seedDir, "other", "unrelated.yaml"),
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: outside-app
  namespace: app-backend
spec:
  replicas: 1
`,
  );
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", "seed"], seedDir);

  const bareDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "gitops-bare-")));
  const bareRepoPath = path.join(bareDir, "repo.git");
  git(["clone", "-q", "--bare", seedDir, bareRepoPath]);

  return { bareUrl: `file://${bareRepoPath}`, bareDir: bareRepoPath, seedDir };
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

const scaleAction = (overrides = {}) => ({
  id: "action-1",
  action_type: "scale_deployment",
  target_kind: "Deployment",
  target_name: "app-backend",
  target_namespace: "app-backend",
  parameters: { replicas: 3 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

test("redact: strips the PAT wherever it appears in a string", () => {
  const pat = "ghp_FAKESECRET12345";
  const text = `fatal: Authentication failed for 'https://x-access-token:${pat}@github.com/org/repo.git/'`;
  const redacted = gitops.redact(text, pat);
  assert.ok(!redacted.includes(pat));
  assert.ok(redacted.includes("***REDACTED***"));
});

test("redact: is a no-op without a pat", () => {
  assert.strictEqual(gitops.redact("hello world", undefined), "hello world");
  assert.strictEqual(gitops.redact("hello world", ""), "hello world");
});

test("redact: coerces non-string input safely", () => {
  assert.strictEqual(gitops.redact(null, "x"), "");
  assert.strictEqual(gitops.redact(undefined, "x"), "");
});

// ---------------------------------------------------------------------------
// authUrl / detectGitHost
// ---------------------------------------------------------------------------

test("authUrl: injects x-access-token credentials into an https URL", () => {
  const url = gitops.authUrl("https://github.com/org/repo.git", "abc123");
  assert.ok(url.startsWith("https://x-access-token:abc123@github.com/"));
});

test("authUrl: leaves the URL untouched without a pat", () => {
  assert.strictEqual(gitops.authUrl("https://github.com/org/repo.git", ""), "https://github.com/org/repo.git");
});

test("detectGitHost: recognizes github.com and gitlab.com, else null", () => {
  assert.strictEqual(gitops.detectGitHost("https://github.com/org/repo.git"), "github");
  assert.strictEqual(gitops.detectGitHost("https://gitlab.com/group/proj.git"), "gitlab");
  assert.strictEqual(gitops.detectGitHost("https://bitbucket.org/org/repo.git"), null);
  assert.strictEqual(gitops.detectGitHost("not a url"), null);
});

// ---------------------------------------------------------------------------
// withRepo
// ---------------------------------------------------------------------------

test("withRepo: clones scoped to the folder and always cleans up the tmp dir", async () => {
  const { bareUrl } = createBareRepo();
  let capturedTmpDir;
  let sawOnlyBaseFile = false;

  await gitops.withRepo(baseCfg(bareUrl), async (repoRoot) => {
    capturedTmpDir = repoRoot;
    const files = gitops.walkYamlFiles(repoRoot, "base");
    sawOnlyBaseFile = files.length === 1 && files[0].endsWith(path.join("base", "app-backend.yaml"));
    // "other/" must not even be materialized on disk (sparse-checkout).
    assert.strictEqual(fs.existsSync(path.join(repoRoot, "other")), false);
  });

  assert.ok(sawOnlyBaseFile);
  assert.strictEqual(fs.existsSync(capturedTmpDir), false, "tmp clone dir must be removed after withRepo returns");
});

test("withRepo: cleans up the tmp dir even when fn throws", async () => {
  const { bareUrl } = createBareRepo();
  let capturedTmpDir;
  await assert.rejects(
    gitops.withRepo(baseCfg(bareUrl), async (repoRoot) => {
      capturedTmpDir = repoRoot;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.strictEqual(fs.existsSync(capturedTmpDir), false, "tmp clone dir must be removed even on failure");
});

// ---------------------------------------------------------------------------
// applyEdit — commit mode
// ---------------------------------------------------------------------------

test("applyEdit (commit mode): pushes a commit that touches exactly one file and only the target line", async () => {
  const { bareUrl, bareDir } = createBareRepo();
  const result = await gitops.applyEdit(baseCfg(bareUrl), scaleAction());

  assert.strictEqual(result.file, "base/app-backend.yaml");
  assert.strictEqual(result.field, "spec.replicas");
  assert.strictEqual(result.before, "2");
  assert.strictEqual(result.after, "3");
  assert.ok(result.commit_sha && /^[0-9a-f]{40}$/.test(result.commit_sha));

  // Verify directly against the bare repo: exactly one file touched.
  const files = execFileSync("git", ["--git-dir", bareDir, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit_sha], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepStrictEqual(files, ["base/app-backend.yaml"]);

  // Verify the commit author.
  const authorLine = execFileSync("git", ["--git-dir", bareDir, "show", "-s", "--format=%an <%ae>", result.commit_sha], {
    encoding: "utf8",
  }).trim();
  assert.strictEqual(authorLine, "Moniple Doctor <doctor@moniple.com>");

  // Verify the diff touches ONLY the replicas line (byte-exact expectation).
  const showOutput = execFileSync("git", ["--git-dir", bareDir, "show", result.commit_sha], { encoding: "utf8" });
  const addedLines = showOutput.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const removedLines = showOutput.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  assert.deepStrictEqual(addedLines, ["+  replicas: 3 # keep this comment"]);
  assert.deepStrictEqual(removedLines, ["-  replicas: 2 # keep this comment"]);
});

test("applyEdit: an out-of-folder target is refused (sparse-checkout never materializes it)", async () => {
  const { bareUrl } = createBareRepo();
  const action = scaleAction({ target_name: "outside-app" }); // only exists under other/, not base/
  await assert.rejects(gitops.applyEdit(baseCfg(bareUrl), action), /no_match/);
});

test("applyEdit: adjust_resources dual-leaf edit commits both leaves in one file", async () => {
  const { bareUrl, seedDir, bareDir } = createBareRepo();
  const resourceYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: res-app
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
  fs.writeFileSync(path.join(seedDir, "base", "res-app.yaml"), resourceYaml);
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", "add res-app"], seedDir);
  git(["push", "-q", bareUrl.replace("file://", ""), "main"], seedDir);

  const action = {
    id: "action-2",
    action_type: "adjust_resources",
    target_kind: "Deployment",
    target_name: "res-app",
    target_namespace: "app-backend",
    parameters: { container: "app", resource: "cpu", request: "150m", limit: "300m" },
  };
  const result = await gitops.applyEdit(baseCfg(bareUrl), action);
  assert.strictEqual(result.file, "base/res-app.yaml");
  assert.strictEqual(result.before, "requests.cpu=100m, limits.cpu=200m");
  assert.strictEqual(result.after, "requests.cpu=150m, limits.cpu=300m");

  const files = execFileSync("git", ["--git-dir", bareDir, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit_sha], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepStrictEqual(files, ["base/res-app.yaml"]);
});

// ---------------------------------------------------------------------------
// computePreviews — single clone per batch (amendment 1)
// ---------------------------------------------------------------------------

test("computePreviews: runtime-only actions never touch the repo (no clone attempted)", async () => {
  // .invalid is IANA-reserved (RFC 2606) — a real clone attempt fails via
  // local DNS resolution in ~300ms+ (see the checkStatus auth_failed test).
  // A fast return here is evidence no clone was attempted at all.
  const cfg = baseCfg("https://invalid.invalid/org/repo.git");
  const actions = [{ action_type: "restart_pod" }, { action_type: "delete_job" }];
  const start = Date.now();
  const previews = await gitops.computePreviews(cfg, actions);
  const elapsed = Date.now() - start;
  assert.deepStrictEqual(previews, [{ status: "runtime_only" }, { status: "runtime_only" }]);
  assert.ok(elapsed < 100, `expected no clone attempt (fast return), took ${elapsed}ms`);
});

test("computePreviews: a single clone is reused across the whole batch", async () => {
  const { bareUrl } = createBareRepo();
  const actions = [scaleAction({ target_name: "app-backend" }), { action_type: "restart_pod" }, scaleAction({ target_name: "does-not-exist" })];
  const previews = await gitops.computePreviews(baseCfg(bareUrl), actions);
  assert.strictEqual(previews.length, 3);
  assert.strictEqual(previews[0].status, "ready");
  assert.strictEqual(previews[0].after, "3");
  assert.strictEqual(previews[1].status, "runtime_only");
  assert.strictEqual(previews[2].status, "no_match");
});

test("computePreviews: clone failure degrades every eligible action to not_configured (redacted)", async () => {
  const fakePat = "FAKEPAT_SECRET_PREVIEWS";
  const cfg = baseCfg("https://invalid.invalid/org/repo.git", { pat: fakePat });
  const actions = [scaleAction(), { action_type: "restart_pod" }];
  const previews = await gitops.computePreviews(cfg, actions);
  assert.strictEqual(previews[0].status, "not_configured");
  assert.ok(!previews[0].note.includes(fakePat));
  assert.strictEqual(previews[1].status, "runtime_only");
});

// ---------------------------------------------------------------------------
// applyEdit — pr mode
// ---------------------------------------------------------------------------

test("applyEdit (pr mode): pushes a moniple/doctor-<sha8> branch, leaves main untouched, unknown host -> manual PR note", async () => {
  const { bareUrl, bareDir } = createBareRepo();
  const cfg = baseCfg(bareUrl, { delivery_mode: "pr" });
  const action = scaleAction({ id: "action-pr-1" });

  const beforeMainSha = execFileSync("git", ["--git-dir", bareDir, "rev-parse", "main"], { encoding: "utf8" }).trim();

  const result = await gitops.applyEdit(cfg, action);

  assert.strictEqual(result.pr_url, null);
  assert.match(result.note, /branch pushed/i);
  assert.ok(result.commit_sha === undefined, "pr mode must not report commit_sha (would imply direct push)");

  const afterMainSha = execFileSync("git", ["--git-dir", bareDir, "rev-parse", "main"], { encoding: "utf8" }).trim();
  assert.strictEqual(afterMainSha, beforeMainSha, "main must be untouched in pr mode");

  const expectedBranch = `moniple/doctor-${gitops.shortHash("action-pr-1")}`;
  const branches = execFileSync("git", ["--git-dir", bareDir, "branch", "--list", expectedBranch], { encoding: "utf8" });
  assert.ok(branches.includes(expectedBranch), `expected branch ${expectedBranch} to exist on the bare repo`);
});

// ---------------------------------------------------------------------------
// checkStatus
// ---------------------------------------------------------------------------

test("checkStatus: ok for a reachable repo with an existing folder", async () => {
  const { bareUrl } = createBareRepo();
  const result = await gitops.checkStatus(baseCfg(bareUrl));
  assert.strictEqual(result.status, "ok");
});

test("checkStatus: folder_missing for a folder that doesn't exist in the repo", async () => {
  const { bareUrl } = createBareRepo();
  const result = await gitops.checkStatus(baseCfg(bareUrl, { folder: "does/not/exist" }));
  assert.strictEqual(result.status, "folder_missing");
});

test("checkStatus: auth_failed (unreachable host) redacts the PAT from the detail", async () => {
  const fakePat = "FAKEPAT_SECRET_SHOULD_NEVER_LEAK";
  // .invalid is IANA-reserved (RFC 2606) — guaranteed to fail DNS resolution
  // locally, no real network round-trip is attempted.
  const result = await gitops.checkStatus(baseCfg("https://invalid.invalid/org/repo.git", { pat: fakePat }));
  assert.strictEqual(result.status, "auth_failed");
  assert.ok(!result.detail.includes(fakePat), "the PAT must never appear in the surfaced detail");
});

test("applyEdit: clone failure against an unreachable host redacts the PAT", async () => {
  const fakePat = "FAKEPAT_SECRET_SHOULD_NEVER_LEAK_2";
  await assert.rejects(
    gitops.applyEdit(baseCfg("https://invalid.invalid/org/repo.git", { pat: fakePat }), scaleAction()),
    (err) => {
      assert.ok(!err.message.includes(fakePat), "the PAT must never appear in the thrown error");
      return true;
    },
  );
});
