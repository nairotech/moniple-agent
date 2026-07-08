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
const cp = require("child_process");
const { execFileSync } = cp;

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

// FINDING 4 (2026-07-08 review): the WHATWG URL userinfo percent-encoder
// (what a `https://x-access-token:<pat>@host` remote URL uses) escapes a
// DIFFERENT character set than encodeURIComponent — e.g. it leaves '+'
// unescaped while encodeURIComponent escapes it to %2B. A pat containing
// '@' and '+' therefore used to appear in a form the old redact() missed
// entirely (neither the raw pat nor its encodeURIComponent form is a
// substring of the URL-embedded text — '@' breaks the raw-pat match and '+'
// breaks the encodeURIComponent-form match).
test("redact: strips a PAT containing '@' and '+' in its URL-userinfo-encoded form (encodeURIComponent form differs)", () => {
  const pat = "ab@cd+ef";
  const url = gitops.authUrl("https://github.com/org/repo.git", pat);
  assert.ok(url.includes("ab%40cd+ef"), "sanity: the auth URL embeds the userinfo-encoded (not encodeURIComponent-encoded) form");
  const text = `fatal: Authentication failed for '${url}/'`;
  const redacted = gitops.redact(text, pat);
  assert.ok(!redacted.includes(pat), "raw pat must not leak");
  assert.ok(!redacted.includes("ab%40cd+ef"), "the URL-userinfo-encoded form must not leak");
  assert.ok(redacted.includes("***REDACTED***"));
});

test("redact: strips the base64 Basic-auth header form (the credential form used by gitAuthArgs)", () => {
  const pat = "ab@cd+ef";
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  const text = `Command failed: git -c http.extraHeader=Authorization: Basic ${basic} clone https://github.com/org/repo.git`;
  const redacted = gitops.redact(text, pat);
  assert.ok(!redacted.includes(basic), "the base64 Basic-auth form must not leak");
  assert.ok(redacted.includes("***REDACTED***"));
});

// ---------------------------------------------------------------------------
// authUrl / gitAuthHeaderValue / gitAuthArgs / detectGitHost
// ---------------------------------------------------------------------------

test("authUrl: injects x-access-token credentials into an https URL", () => {
  const url = gitops.authUrl("https://github.com/org/repo.git", "abc123");
  assert.ok(url.startsWith("https://x-access-token:abc123@github.com/"));
});

test("authUrl: leaves the URL untouched without a pat", () => {
  assert.strictEqual(gitops.authUrl("https://github.com/org/repo.git", ""), "https://github.com/org/repo.git");
});

// FINDING 3 (2026-07-08 review): git invocations must authenticate via a
// per-invocation Basic-auth header, never a credential embedded in the URL
// argv (which git also persists into the clone's .git/config).
test("gitAuthHeaderValue: builds a Basic auth header value from the PAT", () => {
  const pat = "abc123";
  assert.strictEqual(gitops.gitAuthHeaderValue(pat), `Authorization: Basic ${Buffer.from("x-access-token:abc123").toString("base64")}`);
});

test("gitAuthHeaderValue: null without a pat (nothing to inject)", () => {
  assert.strictEqual(gitops.gitAuthHeaderValue(""), null);
  assert.strictEqual(gitops.gitAuthHeaderValue(undefined), null);
});

test("gitAuthArgs: returns a '-c http.extraHeader=...' pair for a pat, [] otherwise", () => {
  const pat = "abc123";
  const args = gitops.gitAuthArgs(pat);
  assert.deepStrictEqual(args, ["-c", `http.extraHeader=${gitops.gitAuthHeaderValue(pat)}`]);
  assert.deepStrictEqual(gitops.gitAuthArgs(""), []);
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

// FINDING 3 / FINDING 5 (2026-07-08 review): spy on the actual argv passed
// to child_process.execFile (patched at call time — gitops.js looks up
// `cp.execFile` fresh on every invocation rather than destructuring it at
// require time, precisely so this is possible) to prove: (1) the raw PAT
// never appears in ANY git argv, (2) a Basic-auth header carries it instead,
// and (3) the sparse-checkout invocation separates the folder with `--`.
test("withRepo: clone/sparse-checkout argv never carry the raw PAT — a Basic auth header is used instead, folder is passed after '--'", async () => {
  const { bareUrl } = createBareRepo();
  const fakePat = "SPY_PAT_withRepo_abc123";
  const seenArgvs = [];
  const originalExecFile = cp.execFile;
  cp.execFile = function (cmd, args, options, callback) {
    seenArgvs.push(args.slice());
    return originalExecFile.call(this, cmd, args, options, callback);
  };

  try {
    await gitops.withRepo(baseCfg(bareUrl, { pat: fakePat }), async () => {});
  } finally {
    cp.execFile = originalExecFile;
  }

  for (const argv of seenArgvs) {
    assert.ok(
      !argv.some((a) => a.includes(fakePat)),
      `argv must never contain the raw pat: ${JSON.stringify(argv)}`,
    );
  }

  const expectedHeaderArg = `http.extraHeader=${gitops.gitAuthHeaderValue(fakePat)}`;
  const cloneInvocation = seenArgvs.find((argv) => argv.includes("clone"));
  assert.ok(cloneInvocation, "expected a clone invocation");
  assert.ok(cloneInvocation.includes(expectedHeaderArg), "clone must carry the Basic auth header instead of an embedded credential");
  assert.ok(cloneInvocation.includes(bareUrl), "clone must use the CLEAN repo_url, not an authUrl()-style embedded one");

  const sparseCheckoutInvocation = seenArgvs.find((argv) => argv.includes("sparse-checkout"));
  assert.ok(sparseCheckoutInvocation, "expected a sparse-checkout invocation");
  assert.ok(sparseCheckoutInvocation.includes(expectedHeaderArg), "sparse-checkout must also carry the auth header (partial-clone lazy fetch)");
  const dashDashIdx = sparseCheckoutInvocation.indexOf("--");
  const folderIdx = sparseCheckoutInvocation.indexOf("base");
  assert.ok(dashDashIdx !== -1 && dashDashIdx < folderIdx, "the folder must be passed after a '--' separator");
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

// FINDING 1 regression, case (c): full applyEdit — clone, resolve, edit,
// commit, push — through a REAL local bare repo on a multi-doc file. Proves
// the fix end-to-end, not just at the pure-function level (see
// test/gitops.test.js for the resolveTarget/applyEditInPlace-level cases).
function createMultiDocBareRepo() {
  const seedDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "gitops-multidoc-seed-")));
  git(["init", "-q", "-b", "main"], seedDir);
  git(["config", "user.email", "seed@test.local"], seedDir);
  git(["config", "user.name", "Seed"], seedDir);
  fs.mkdirSync(path.join(seedDir, "base"), { recursive: true });
  const frontendYaml = `apiVersion: apps/v1
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
  // app-frontend is doc 0, app-backend (the actual target) is doc 1.
  fs.writeFileSync(path.join(seedDir, "base", "multi.yaml"), frontendYaml + "---\n" + DEPLOYMENT_YAML);
  git(["add", "-A"], seedDir);
  git(["commit", "-q", "-m", "seed multi-doc"], seedDir);

  const bareDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "gitops-multidoc-bare-")));
  const bareRepoPath = path.join(bareDir, "repo.git");
  git(["clone", "-q", "--bare", seedDir, bareRepoPath]);

  return { bareUrl: `file://${bareRepoPath}`, bareDir: bareRepoPath, seedDir };
}

test("applyEdit (FINDING 1 regression, case c): full applyEdit on a multi-doc file — git show diff touches ONLY the targeted doc's line, the other doc is unaffected", async () => {
  const { bareUrl, bareDir } = createMultiDocBareRepo();
  const action = scaleAction({ id: "action-multidoc-1" }); // targets app-backend (doc 1) by default

  const result = await gitops.applyEdit(baseCfg(bareUrl), action);

  assert.strictEqual(result.file, "base/multi.yaml");
  assert.strictEqual(result.field, "spec.replicas");
  assert.strictEqual(result.before, "2");
  assert.strictEqual(result.after, "3");
  assert.ok(result.commit_sha && /^[0-9a-f]{40}$/.test(result.commit_sha));

  // Exactly one file touched by the commit.
  const files = execFileSync("git", ["--git-dir", bareDir, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit_sha], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepStrictEqual(files, ["base/multi.yaml"]);

  // The diff touches ONLY app-backend's (commented) replicas line.
  const showOutput = execFileSync("git", ["--git-dir", bareDir, "show", result.commit_sha], { encoding: "utf8" });
  const addedLines = showOutput.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const removedLines = showOutput.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  assert.deepStrictEqual(addedLines, ["+  replicas: 3 # keep this comment"]);
  assert.deepStrictEqual(removedLines, ["-  replicas: 2 # keep this comment"]);
  // Proof the other doc (app-frontend) was never touched: its plain,
  // uncommented "replicas: 2" line never appears as a removal in the diff.
  assert.ok(
    !showOutput.split("\n").some((l) => l === "-  replicas: 2"),
    "app-frontend's replicas line must never appear in the diff",
  );
});

test("applyEdit: no-op when the repo is already at the desired value — commit_sha:null, no commit/push attempted", async () => {
  const { bareUrl, bareDir } = createBareRepo();
  const beforeMainSha = execFileSync("git", ["--git-dir", bareDir, "rev-parse", "main"], { encoding: "utf8" }).trim();

  // Fixture's current replicas is 2 — request 2 again (a no-op edit).
  const action = scaleAction({ id: "action-noop-1", parameters: { replicas: 2 } });
  const result = await gitops.applyEdit(baseCfg(bareUrl), action);

  assert.strictEqual(result.file, "base/app-backend.yaml");
  assert.strictEqual(result.before, "2");
  assert.strictEqual(result.after, "2");
  assert.strictEqual(result.commit_sha, null);
  assert.match(result.note, /no commit needed/);

  const afterMainSha = execFileSync("git", ["--git-dir", bareDir, "rev-parse", "main"], { encoding: "utf8" }).trim();
  assert.strictEqual(afterMainSha, beforeMainSha, "no new commit should have been made/pushed for a no-op edit");
});

// FINDING 3 (2026-07-08 review): the push runs against a freshly-cloned
// `origin` whose URL is now CLEAN (no embedded credential) — it must carry
// the auth header on this invocation too, since the header is per-process-
// argv only and is never persisted into .git/config for a later invocation
// to pick up implicitly.
test("applyEdit (commit mode): push argv never carries the raw PAT — a Basic auth header is used instead", async () => {
  const { bareUrl } = createBareRepo();
  const fakePat = "SPY_PAT_push_xyz789";
  const seenArgvs = [];
  const originalExecFile = cp.execFile;
  cp.execFile = function (cmd, args, options, callback) {
    seenArgvs.push(args.slice());
    return originalExecFile.call(this, cmd, args, options, callback);
  };

  let result;
  try {
    result = await gitops.applyEdit(baseCfg(bareUrl, { pat: fakePat }), scaleAction({ id: "action-spy-push" }));
  } finally {
    cp.execFile = originalExecFile;
  }

  assert.ok(result.commit_sha);
  for (const argv of seenArgvs) {
    assert.ok(!argv.some((a) => a.includes(fakePat)), `argv must never contain the raw pat: ${JSON.stringify(argv)}`);
  }

  const pushInvocation = seenArgvs.find((argv) => argv.includes("push"));
  assert.ok(pushInvocation, "expected a push invocation");
  assert.ok(
    pushInvocation.includes(`http.extraHeader=${gitops.gitAuthHeaderValue(fakePat)}`),
    "push must carry the Basic auth header instead of relying on an embedded credential",
  );
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

// FINDING 3 (2026-07-08 review): ls-remote must never receive the PAT
// embedded in the URL argv — a Basic auth header carries it instead.
test("checkStatus: ls-remote argv never carries the raw PAT — a Basic auth header is used instead", async () => {
  const { bareUrl } = createBareRepo();
  const fakePat = "SPY_PAT_lsremote_xyz789";
  const seenArgvs = [];
  const originalExecFile = cp.execFile;
  cp.execFile = function (cmd, args, options, callback) {
    seenArgvs.push(args.slice());
    return originalExecFile.call(this, cmd, args, options, callback);
  };

  let result;
  try {
    result = await gitops.checkStatus(baseCfg(bareUrl, { pat: fakePat }));
  } finally {
    cp.execFile = originalExecFile;
  }

  assert.strictEqual(result.status, "ok");
  for (const argv of seenArgvs) {
    assert.ok(!argv.some((a) => a.includes(fakePat)), `argv must never contain the raw pat: ${JSON.stringify(argv)}`);
  }

  const lsRemoteInvocation = seenArgvs.find((argv) => argv.includes("ls-remote"));
  assert.ok(lsRemoteInvocation, "expected an ls-remote invocation");
  assert.ok(lsRemoteInvocation.includes(bareUrl), "ls-remote must use the CLEAN repo_url");
  assert.ok(
    lsRemoteInvocation.includes(`http.extraHeader=${gitops.gitAuthHeaderValue(fakePat)}`),
    "ls-remote must carry the Basic auth header instead of an embedded credential",
  );
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
