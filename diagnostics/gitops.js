/**
 * GitOps-aware remediation.
 *
 * When a cluster has a GitOps repo attached (Pro+ only, configured server-side
 * and delivered to the agent over the existing /agent/doctor/config channel),
 * an eligible Doctor remediation action gets a *minimal* matching edit in the
 * repo in addition to the live patch, so the next sync cycle doesn't revert
 * the fix.
 *
 * Security model (see docs/superpowers/specs/2026-07-07-gitops-remediation-design.md):
 *   - Folder jail: every filesystem read/write is realpath-checked against
 *     <repoRoot>/<folder>. Never touches anything outside it.
 *   - Minimal diff: only the action's own field(s) are changed, using the
 *     `yaml` Document API (comment/order preserving) — never a full
 *     reserialize of unrelated content. Multi-document (`---`-separated)
 *     files are edited by an explicit, resolveTarget-derived document index
 *     (docIndex) — never a field-path-depth guess, which cannot tell two
 *     same-shaped candidate documents apart.
 *   - One action = one file = one commit. Staging is always `git add
 *     <exact file>`, never `git add .`/`-A`.
 *   - The PAT is never embedded in a URL passed to git (argv is visible via
 *     /proc/cmdline and git persists the remote URL into the clone's
 *     `.git/config`). Every network-touching git invocation instead gets the
 *     credential via an ephemeral, per-invocation `-c
 *     http.extraHeader=Authorization: Basic ...` (see gitAuthArgs) against a
 *     CLEAN url.
 *   - The PAT is never logged or returned — every surfaced string (thrown
 *     errors, execution_result.gitops.error, status detail) is passed
 *     through redact() first, which strips the raw PAT and every encoded
 *     form it can appear in (URI-encoded, URL-userinfo-encoded, Basic
 *     base64).
 *   - `git` is invoked exclusively via execFile with argv arrays — never a
 *     string-interpolated shell.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
// Looked up as `cp.execFile` at call time (not destructured here) so tests
// can substitute it — see execGitRaw.
const cp = require("child_process");
const YAML = require("yaml");

const GIT_TIMEOUT_MS = 30000;
const REDACTED = "***REDACTED***";

// ---------------------------------------------------------------------------
// Folder jail
// ---------------------------------------------------------------------------

/**
 * Normalize a repo-relative folder path and reject anything that could
 * escape the repo (absolute paths, `..` segments, empty segments).
 */
function sanitizeFolder(folder) {
  if (typeof folder !== "string" || !folder.trim()) {
    throw new Error("folder is required");
  }
  let f = folder.trim().replace(/\\/g, "/");
  if (f.startsWith("/")) {
    throw new Error("folder must be a repo-relative path (no leading '/')");
  }
  f = f.replace(/\/+$/, ""); // strip trailing slash(es)
  if (!f) {
    throw new Error("folder is required");
  }
  const segments = f.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === ".") {
      throw new Error("folder must not contain empty or '.' segments");
    }
    if (seg === "..") {
      throw new Error("folder must not contain '..' segments");
    }
    if (seg.startsWith("-")) {
      // A segment starting with '-' could be misread as a git option by a
      // downstream invocation (e.g. `sparse-checkout set <folder>`) rather
      // than a path — reject outright rather than relying solely on the
      // `--` separator we also add at the call site (defense in depth).
      throw new Error("folder must not contain a segment starting with '-'");
    }
  }
  return segments.join("/");
}

/**
 * Assert that `absPath` resolves (through symlinks) to somewhere inside
 * <repoRoot>/<folder>. Throws otherwise. Returns the resolved absolute path
 * on success (use this resolved value for the actual read/write).
 */
function assertInsideFolder(repoRoot, folder, absPath) {
  const cleanFolder = sanitizeFolder(folder);
  const base = fs.realpathSync(path.join(repoRoot, cleanFolder));
  // Fully dereference absPath itself (it may be a symlink whose target
  // escapes the folder even though its containing directory doesn't).
  // Fall back to resolving just the parent dir when absPath doesn't exist
  // yet (e.g. a path about to be created).
  let resolved;
  try {
    resolved = fs.realpathSync(absPath);
  } catch {
    const dir = fs.realpathSync(path.dirname(absPath));
    resolved = path.join(dir, path.basename(absPath));
  }
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("target path escapes the configured gitops folder");
  }
  return resolved;
}

/**
 * Recursively collect *.yaml|*.yml files under repoRoot/folder. Every path
 * (including symlink targets) is jail-checked against the resolved folder —
 * anything that would escape it is silently skipped (never followed/read).
 */
function walkYamlFiles(repoRoot, folder) {
  const cleanFolder = sanitizeFolder(folder);
  const base = path.join(repoRoot, cleanFolder);
  const results = [];

  let repoRootReal;
  let baseReal;
  try {
    repoRootReal = fs.realpathSync(repoRoot);
    baseReal = fs.realpathSync(base);
  } catch {
    return results; // repo root or folder doesn't exist (e.g. clone had nothing to check out)
  }
  // The configured folder itself must not be a symlink escaping the repo.
  if (baseReal !== repoRootReal && !baseReal.startsWith(repoRootReal + path.sep)) {
    return results;
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(abs);
        } catch {
          continue; // broken symlink
        }
        if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
          continue; // escapes the jailed folder — never follow
        }
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }

      if (isDir) {
        walk(abs);
      } else if (isFile && /\.ya?ml$/i.test(entry.name)) {
        results.push(abs);
      }
    }
  }

  walk(base);
  return results;
}

// ---------------------------------------------------------------------------
// PAT redaction (never let it leave this module)
// ---------------------------------------------------------------------------

function redact(text, pat) {
  const str = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!pat) return str;
  let result = str.split(pat).join(REDACTED);
  try {
    const encoded = encodeURIComponent(pat);
    if (encoded && encoded !== pat) {
      result = result.split(encoded).join(REDACTED);
    }
  } catch {
    // ignore
  }
  // The WHATWG URL userinfo percent-encoder (what a `https://user:PAT@host`
  // remote URL would use) escapes a DIFFERENT character set than
  // encodeURIComponent — e.g. it leaves '+' unescaped — so a pat containing
  // characters like '+' can appear in a differently-encoded form that the
  // check above misses. Strip that exact form too.
  try {
    const dummy = new URL("https://x@y.invalid");
    dummy.password = pat;
    const urlEncoded = dummy.password;
    if (urlEncoded && urlEncoded !== pat) {
      result = result.split(urlEncoded).join(REDACTED);
    }
  } catch {
    // ignore
  }
  // The Basic-auth header value injected via `-c http.extraHeader=...` for
  // network-touching git invocations (see gitAuthArgs) must never survive
  // into a surfaced error either.
  try {
    const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
    if (basic) {
      result = result.split(basic).join(REDACTED);
    }
  } catch {
    // ignore
  }
  return result;
}

// ---------------------------------------------------------------------------
// Action -> repo target mapping
// ---------------------------------------------------------------------------

/**
 * Describe *what* an eligible action would change in a repo, independent of
 * any specific YAML document. Returns null for runtime-only/unrecognized
 * action types (never touch the repo for those).
 *
 * `opts.resolvedImage` (rollback_deployment only): the previous-revision
 * image, known only at execution time. Absent at preview time.
 */
function mapActionToTarget(action, opts = {}) {
  const type = action && action.action_type;
  const params = (action && action.parameters) || {};

  switch (type) {
    case "scale_deployment": {
      if (params.replicas === undefined || params.replicas === null) return null;
      const replicas = Number(params.replicas);
      if (!Number.isFinite(replicas)) return null;
      return {
        kind: "Deployment",
        fieldPathDisplay: "spec.replicas",
        leaves: [{ path: ["spec", "replicas"], value: replicas, label: "spec.replicas" }],
      };
    }

    case "adjust_resources": {
      const containerName = params.container;
      const resource = params.resource;
      const fieldPathDisplay = `spec.template.spec.containers[${containerName || "?"}].resources`;
      if (!containerName || !resource) {
        return { kind: "Deployment", fieldPathDisplay, containerName, leaves: [], alwaysCompact: true };
      }
      const leaves = [];
      if (params.request !== undefined && params.request !== null && params.request !== "") {
        leaves.push({
          path: ["spec", "template", "spec", "containers", "$container", "resources", "requests", resource],
          value: String(params.request),
          label: `requests.${resource}`,
        });
      }
      if (params.limit !== undefined && params.limit !== null && params.limit !== "") {
        leaves.push({
          path: ["spec", "template", "spec", "containers", "$container", "resources", "limits", resource],
          value: String(params.limit),
          label: `limits.${resource}`,
        });
      }
      return { kind: "Deployment", fieldPathDisplay, containerName, leaves, alwaysCompact: true };
    }

    case "expand_pvc": {
      if (!params.new_size) return null;
      return {
        kind: "PersistentVolumeClaim",
        fieldPathDisplay: "spec.resources.requests.storage",
        leaves: [
          {
            path: ["spec", "resources", "requests", "storage"],
            value: String(params.new_size),
            label: "spec.resources.requests.storage",
          },
        ],
      };
    }

    case "rollback_deployment": {
      // The previous-revision image is only known at execution time (from
      // the live ReplicaSet history) — absent here means "preview".
      const resolvedImage = opts && opts.resolvedImage ? String(opts.resolvedImage) : null;
      return {
        kind: "Deployment",
        fieldPathDisplay: "spec.template.spec.containers[0].image",
        singleContainerRequired: true,
        leaves: [
          {
            path: ["spec", "template", "spec", "containers", "$container", "image"],
            value: resolvedImage,
            label: "image",
            isPlaceholder: resolvedImage === null,
          },
        ],
      };
    }

    default:
      return null; // restart_pod, restart_deployment, delete_pod, delete_job,
      // cordon_node, uncordon_node, update_agent — runtime-only.
  }
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

function getAtPath(obj, segments) {
  let cur = obj;
  for (const key of segments) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function safeGetNode(doc, segments) {
  try {
    return doc.getIn(segments, true);
  } catch {
    return null;
  }
}

function stringifyLeaf(value) {
  if (value === undefined || value === null) return "(unset)";
  return String(value);
}

function compactLeaves(leaves, which) {
  return leaves.map((l) => `${l.label}=${stringifyLeaf(which === "before" ? l.before : l.after)}`).join(", ");
}

/**
 * kustomize overlay conflict check (spec §10 / plan amendment 5): a
 * `replicas:` transformer entry naming the target (scale_deployment) or any
 * `images:` transformer (rollback_deployment) means the field is actually
 * controlled by an overlay, not the plain manifest we matched — never guess,
 * treat as ambiguous and skip the repo edit.
 */
function checkKustomizeOverlay(files, action, targetName) {
  if (action.action_type !== "scale_deployment" && action.action_type !== "rollback_deployment") {
    return null;
  }
  const kustomFiles = files.filter((f) => {
    const base = path.basename(f);
    return base === "kustomization.yaml" || base === "kustomization.yml";
  });

  for (const file of kustomFiles) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let plain;
    try {
      plain = YAML.parseDocument(text, { logLevel: "silent" }).toJS();
    } catch {
      continue;
    }
    if (!plain || typeof plain !== "object") continue;

    if (action.action_type === "scale_deployment" && Array.isArray(plain.replicas)) {
      const hit = plain.replicas.find((r) => r && r.name === targetName);
      if (hit) {
        return { file };
      }
    }
    if (action.action_type === "rollback_deployment" && Array.isArray(plain.images) && plain.images.length > 0) {
      // Any images: transformer is treated as overlay-controlled for rollback
      // — correlating a transformer entry to the live image repo reliably
      // would require cluster context we don't have here; be conservative.
      return { file };
    }
  }
  return null;
}

/**
 * Resolve an eligible action against an already-checked-out repo. Pure
 * filesystem read — no git/network operations. Returns the frozen
 * `gitops_preview` shape plus an internal `edits` array (concrete, typed
 * values) consumed only by applyEdit.
 */
function resolveTarget(repoRoot, folder, action, opts = {}) {
  const cleanFolder = sanitizeFolder(folder);
  const intent = mapActionToTarget(action, opts);
  if (!intent) {
    return { status: "runtime_only" };
  }
  if (!intent.leaves.length) {
    return {
      status: "no_match",
      field_path: intent.fieldPathDisplay,
      note: "action has no concrete field changes to apply",
    };
  }

  const targetName = action.target_name;
  const targetNs = action.target_namespace;
  const files = walkYamlFiles(repoRoot, cleanFolder);
  const matches = [];

  for (const absFile of files) {
    let text;
    try {
      text = fs.readFileSync(absFile, "utf8");
    } catch {
      continue;
    }
    let docs;
    try {
      docs = YAML.parseAllDocuments(text, { logLevel: "silent" });
    } catch {
      continue;
    }
    // Track each doc's ordinal position within ITS OWN file's parsed
    // document array (`docIndex`) — this is threaded all the way through to
    // applyEdit so it can tell applyEditInPlace exactly which `---`-separated
    // document to edit, instead of applyEditInPlace re-guessing by field-path
    // depth alone (which cannot distinguish two docs that both happen to
    // resolve the same field, e.g. two Deployments both with spec.replicas —
    // see FINDING 1 in the 2026-07-08 review).
    for (let docIndex = 0; docIndex < docs.length; docIndex++) {
      const doc = docs[docIndex];
      let plain;
      try {
        plain = doc.toJS();
      } catch {
        continue;
      }
      if (!plain || typeof plain !== "object") continue;
      const kind = plain.kind;
      const name = plain.metadata && plain.metadata.name;
      const ns = plain.metadata && plain.metadata.namespace;
      if (kind !== intent.kind) continue;
      if (name !== targetName) continue;
      if (ns != null && ns !== targetNs) continue;
      matches.push({
        file: absFile,
        relFile: path.relative(repoRoot, absFile).split(path.sep).join("/"),
        doc,
        plain,
        text,
        docIndex,
      });
    }
  }

  if (matches.length === 0) {
    return {
      status: "no_match",
      field_path: intent.fieldPathDisplay,
      note: `no ${intent.kind} named "${targetName}" found under ${cleanFolder}`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      field_path: intent.fieldPathDisplay,
      note: `multiple files declare ${intent.kind}/${targetName} under ${cleanFolder} — refusing to guess`,
      files: matches.map((m) => m.relFile),
    };
  }

  const match = matches[0];

  // --- resolve the container index, if this action needs one ---
  let containerIndex = null;
  if (intent.containerName || intent.singleContainerRequired) {
    const containers = getAtPath(match.plain, ["spec", "template", "spec", "containers"]) || [];
    if (intent.singleContainerRequired) {
      if (!Array.isArray(containers) || containers.length !== 1) {
        return {
          status: "ambiguous",
          file: match.relFile,
          field_path: intent.fieldPathDisplay,
          note: `${intent.kind}/${targetName} has ${Array.isArray(containers) ? containers.length : 0} containers — cannot determine rollback target`,
        };
      }
      containerIndex = 0;
    } else {
      containerIndex = Array.isArray(containers) ? containers.findIndex((c) => c && c.name === intent.containerName) : -1;
      if (containerIndex === -1) {
        return {
          status: "no_match",
          file: match.relFile,
          field_path: intent.fieldPathDisplay,
          note: `container "${intent.containerName}" not found in ${intent.kind}/${targetName}`,
        };
      }
    }
  }

  // --- kustomize overlay check (never touch overlay-controlled fields) ---
  const overlay = checkKustomizeOverlay(files, action, targetName);
  if (overlay) {
    const overlayRel = path.relative(repoRoot, overlay.file).split(path.sep).join("/");
    return {
      status: "ambiguous",
      file: match.relFile,
      field_path: intent.fieldPathDisplay,
      note: `field is controlled by a kustomize overlay (${overlayRel}) — repo edit skipped, live patch only`,
    };
  }

  // --- concretize leaf paths ($container -> index), read before, check helm templating ---
  const concreteLeaves = [];
  for (const leaf of intent.leaves) {
    const concretePath = leaf.path.map((seg) => (seg === "$container" ? containerIndex : seg));
    const beforeRaw = getAtPath(match.plain, concretePath);
    const node = safeGetNode(match.doc, concretePath);
    if (node && node.range && Number.isInteger(node.range[0])) {
      const end = Number.isInteger(node.range[2]) ? node.range[2] : node.range[1];
      const region = match.text.slice(node.range[0], end);
      if (region.includes("{{")) {
        return {
          status: "helm_templated",
          file: match.relFile,
          field_path: intent.fieldPathDisplay,
          note: "target field is Helm-templated — repo edit skipped, live patch only",
        };
      }
    }
    concreteLeaves.push({ path: concretePath, before: beforeRaw, after: leaf.value, label: leaf.label, isPlaceholder: leaf.isPlaceholder });
  }

  const useCompact = intent.alwaysCompact || concreteLeaves.length > 1;
  const isPlaceholderRollback = concreteLeaves.length === 1 && concreteLeaves[0].isPlaceholder;

  const before = useCompact ? compactLeaves(concreteLeaves, "before") : stringifyLeaf(concreteLeaves[0].before);
  const after = isPlaceholderRollback
    ? "(previous revision image — resolved at execution)"
    : useCompact
      ? compactLeaves(concreteLeaves, "after")
      : stringifyLeaf(concreteLeaves[0].after);

  return {
    status: "ready",
    file: match.relFile,
    field_path: intent.fieldPathDisplay,
    before,
    after,
    edits: concreteLeaves.map((l) => ({ path: l.path, value: l.after })),
    // Internal only (not part of the gitops_preview shape sent to the
    // server/app — buildPreview whitelists its own fields) — consumed only
    // by applyEdit to tell applyEditInPlace exactly which document to edit.
    docIndex: match.docIndex,
  };
}

// ---------------------------------------------------------------------------
// Surgical edit (comment/order preserving)
// ---------------------------------------------------------------------------

function pathDepthResolved(doc, segments) {
  let cur;
  try {
    cur = doc.toJS();
  } catch {
    return 0;
  }
  let depth = 0;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object" || !(seg in cur)) break;
    cur = cur[seg];
    depth++;
  }
  return depth;
}

function pickTargetDocIndex(docs, edits) {
  let bestIndex = -1;
  let bestScore = -1;
  docs.forEach((doc, i) => {
    const score = Math.min(...edits.map((e) => pathDepthResolved(doc, e.path)));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}

/**
 * Apply 1-2 field edits to YAML text using the `yaml` Document API
 * (setIn + serialize) so only the target line(s) change — comments, key
 * order and formatting elsewhere are preserved. Handles multi-document
 * (`---`-separated) files by editing only the doc the edits actually belong
 * to; every other document is round-tripped byte-for-byte.
 *
 * `docIndex`, when provided (as it always is from applyEdit — see
 * resolveTarget), identifies the EXACT document (by ordinal position in this
 * same text's `parseAllDocuments` array) that resolveTarget already matched
 * by kind+name+namespace. It is used directly and is NOT re-derived — the
 * path-depth heuristic (`pickTargetDocIndex`) cannot distinguish two
 * candidate docs that both happen to resolve the same field path (e.g. two
 * Deployments both having spec.replicas) and would silently edit the wrong
 * one (see FINDING 1, 2026-07-08 review). The heuristic is kept ONLY as a
 * fallback for callers that don't have a resolveTarget-derived docIndex.
 */
function applyEditInPlace(text, edits, docIndex) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("applyEditInPlace requires at least one edit");
  }
  const docs = YAML.parseAllDocuments(text, { logLevel: "silent" });
  if (docs.length === 0) {
    throw new Error("no YAML documents found in the given text");
  }

  let targetIndex;
  if (docIndex === undefined || docIndex === null) {
    targetIndex = docs.length === 1 ? 0 : pickTargetDocIndex(docs, edits);
    if (targetIndex === -1) {
      throw new Error("could not determine which document to edit");
    }
  } else {
    if (!Number.isInteger(docIndex) || docIndex < 0 || docIndex >= docs.length) {
      throw new Error(`docIndex ${docIndex} is out of range for ${docs.length} document(s) in this file`);
    }
    targetIndex = docIndex;
  }

  const target = docs[targetIndex];
  for (const edit of edits) {
    target.setIn(edit.path, edit.value);
  }
  return docs.map((d) => String(d)).join("");
}

// ---------------------------------------------------------------------------
// git plumbing (execFile only — never a string-interpolated shell)
// ---------------------------------------------------------------------------

function execGitRaw(args, cwd) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        // Never let a bad credential hang the agent waiting on a terminal
        // prompt that can never come in a headless container.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * Run git and redact the PAT from any error that escapes — Node's own
 * "Command failed: ..." error message includes the full argv (which may
 * embed the credential in the URL), and some git hosts echo the remote URL
 * verbatim in auth failures. Nothing containing the PAT may leave this
 * function.
 */
async function runGit(args, cwd, pat) {
  try {
    return await execGitRaw(args, cwd);
  } catch (err) {
    const raw = String(err.stderr || err.message || err);
    throw new Error(redact(raw, pat));
  }
}

/**
 * Build an https URL with the PAT embedded as userinfo
 * (`https://x-access-token:<pat>@host/...`).
 *
 * SECURITY: kept exported for backward compatibility / direct unit testing
 * only. NEVER pass the result of this function to a git subprocess (argv or
 * otherwise) — that is exactly what put the PAT in /proc/cmdline and
 * persisted it into the cloned repo's .git/config (FINDING 3, 2026-07-08
 * review). Every git invocation must use the CLEAN cfg.repo_url plus
 * gitAuthArgs(cfg.pat) instead.
 */
function authUrl(repoUrl, pat) {
  if (!pat) return repoUrl;
  let u;
  try {
    u = new URL(repoUrl);
  } catch {
    return repoUrl;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return repoUrl; // only http(s) remotes are rewritten; ssh/git are left untouched
  }
  u.username = "x-access-token";
  u.password = pat; // WHATWG URL auto percent-encodes
  return u.toString();
}

/**
 * The HTTP Basic-auth header value for a PAT, in the exact form git needs
 * for `-c http.extraHeader=...`. Returns null when there's no pat (nothing
 * to inject — e.g. local/file:// remotes, or ssh remotes using agent auth).
 */
function gitAuthHeaderValue(pat) {
  if (!pat) return null;
  return `Authorization: Basic ${Buffer.from(`x-access-token:${pat}`).toString("base64")}`;
}

/**
 * The `-c http.extraHeader=...` argv prefix that authenticates a single git
 * invocation without ever putting the credential in a URL. This is
 * per-invocation and ephemeral: it lives only in this process's argv for the
 * duration of the call, and is NEVER written to any `.git/config` (unlike
 * embedding the PAT in the remote URL, which git persists to
 * `.git/config` on clone/remote-add). Use on every network-touching git
 * invocation (clone, ls-remote, push, fetch, and sparse-checkout — the
 * latter can trigger a lazy blob fetch against a `--filter=blob:none`
 * partial clone).
 */
function gitAuthArgs(pat) {
  const header = gitAuthHeaderValue(pat);
  return header ? ["-c", `http.extraHeader=${header}`] : [];
}

async function getCurrentBranch(repoRoot, pat) {
  const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, pat);
  return stdout.trim();
}

/**
 * Shallow sparse clone scoped to cfg.folder into a throwaway temp dir;
 * guarantees cleanup even if `fn` throws. The remote URL passed to git is
 * always the CLEAN cfg.repo_url — the PAT is injected per-invocation via a
 * `-c http.extraHeader=...` Basic-auth header (gitAuthArgs) instead of being
 * embedded in the URL, so it is never written into the clone's .git/config
 * nor visible there after the fact (FINDING 3).
 */
async function withRepo(cfg, fn) {
  const folder = sanitizeFolder(cfg.folder);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moniple-gitops-"));
  try {
    const authArgs = gitAuthArgs(cfg.pat);
    const cloneArgs = [...authArgs, "clone", "--depth", "1", "--filter=blob:none", "--sparse"];
    if (cfg.branch) cloneArgs.push("--branch", cfg.branch);
    cloneArgs.push(cfg.repo_url, tmpDir);
    await runGit(cloneArgs, undefined, cfg.pat);
    // `--` before the folder: sanitizeFolder already rejects a leading '-'
    // segment, but this keeps git from ever treating the argument as an
    // option even under a future relaxation (FINDING 5, defense in depth).
    await runGit([...authArgs, "sparse-checkout", "set", "--", folder], tmpDir, cfg.pat);
    return await fn(tmpDir);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — never let this mask the real result/error
    }
  }
}

// ---------------------------------------------------------------------------
// Preview (scan time — read only, never writes)
// ---------------------------------------------------------------------------

function buildPreview(repoRoot, folder, action) {
  const resolved = resolveTarget(repoRoot, folder, action);
  return {
    status: resolved.status,
    file: resolved.file,
    field_path: resolved.field_path,
    before: resolved.before,
    after: resolved.after,
    note: resolved.note,
  };
}

/**
 * Compute gitops_preview for a batch of actions with a SINGLE clone (plan
 * amendment 1). Runtime-only actions never touch the repo; if the clone
 * fails, every eligible action degrades to not_configured (with a redacted
 * reason) rather than failing the whole scan.
 */
async function computePreviews(cfg, actions) {
  const list = Array.isArray(actions) ? actions : [];
  const previews = new Array(list.length);
  const eligible = [];

  for (let i = 0; i < list.length; i++) {
    const intent = mapActionToTarget(list[i]);
    if (!intent) {
      previews[i] = { status: "runtime_only" };
    } else {
      eligible.push(i);
    }
  }

  if (eligible.length === 0) {
    return previews; // nothing needs the repo — don't clone at all
  }

  if (!cfg || !cfg.repo_url || !cfg.folder) {
    for (const i of eligible) {
      previews[i] = { status: "not_configured", note: "gitops repository is not configured" };
    }
    return previews;
  }

  try {
    await withRepo(cfg, async (repoRoot) => {
      for (const i of eligible) {
        try {
          previews[i] = buildPreview(repoRoot, cfg.folder, list[i]);
        } catch (err) {
          previews[i] = { status: "not_configured", note: redact(err.message || String(err), cfg.pat) };
        }
      }
    });
  } catch (err) {
    const note = redact(err.message || String(err), cfg.pat);
    for (const i of eligible) {
      previews[i] = { status: "not_configured", note };
    }
  }

  return previews;
}

// ---------------------------------------------------------------------------
// Connectivity status
// ---------------------------------------------------------------------------

async function checkStatus(cfg) {
  if (!cfg || !cfg.repo_url || !cfg.folder) {
    return { status: "clone_failed", detail: "gitops repository is not configured" };
  }
  let folder;
  try {
    folder = sanitizeFolder(cfg.folder);
  } catch (err) {
    return { status: "clone_failed", detail: redact(err.message, cfg.pat) };
  }

  try {
    // Clean URL + header (FINDING 3) — never authUrl(): ls-remote's argv is
    // process-visible, and an auth-embedded URL here would be pure argv
    // exposure with no offsetting benefit (no repo is cloned/persisted).
    await runGit([...gitAuthArgs(cfg.pat), "ls-remote", cfg.repo_url], undefined, cfg.pat);
  } catch (err) {
    return { status: "auth_failed", detail: redact(err.message, cfg.pat) };
  }

  try {
    let exists = false;
    await withRepo(cfg, async (repoRoot) => {
      exists = fs.existsSync(path.join(repoRoot, folder));
    });
    if (!exists) {
      return { status: "folder_missing", detail: `folder "${folder}" was not found in the repository` };
    }
    return { status: "ok" };
  } catch (err) {
    return { status: "clone_failed", detail: redact(err.message, cfg.pat) };
  }
}

// ---------------------------------------------------------------------------
// Commit message + PR/MR helpers
// ---------------------------------------------------------------------------

function shortHash(input) {
  return crypto
    .createHash("sha256")
    .update(String(input == null ? "" : input))
    .digest("hex")
    .slice(0, 8);
}

function buildCommitMessage(action) {
  const name = action.target_name || "resource";
  const params = action.parameters || {};
  switch (action.action_type) {
    case "scale_deployment":
      return `moniple: scale ${name} to ${params.replicas} replicas`;
    case "adjust_resources":
      return `moniple: adjust ${params.resource || "resources"} for ${name}/${params.container || "?"}`;
    case "expand_pvc":
      return `moniple: expand PVC ${name} to ${params.new_size}`;
    case "rollback_deployment":
      return `moniple: rollback ${name} to previous revision`;
    default:
      return `moniple: update ${name}`;
  }
}

function detectGitHost(repoUrl) {
  try {
    const u = new URL(repoUrl);
    if (u.hostname === "github.com") return "github";
    if (u.hostname === "gitlab.com") return "gitlab";
    return null;
  } catch {
    return null;
  }
}

function parseRepoPath(repoUrl) {
  const u = new URL(repoUrl);
  return u.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
}

async function openPullRequest(host, cfg, branchName, baseBranch, action) {
  const repoPath = parseRepoPath(cfg.repo_url);
  const title = buildCommitMessage(action);

  if (host === "github") {
    const [owner, repo] = repoPath.split("/");
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `token ${cfg.pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "moniple-agent",
      },
      body: JSON.stringify({ title, head: branchName, base: baseBranch, body: "Opened automatically by Moniple Doctor." }),
    });
    if (!res.ok) throw new Error(`GitHub PR creation failed (HTTP ${res.status})`);
    const json = await res.json();
    return json.html_url;
  }

  if (host === "gitlab") {
    const projectId = encodeURIComponent(repoPath);
    const res = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/merge_requests`, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": cfg.pat, "Content-Type": "application/json" },
      body: JSON.stringify({ source_branch: branchName, target_branch: baseBranch, title, description: "Opened automatically by Moniple Doctor." }),
    });
    if (!res.ok) throw new Error(`GitLab MR creation failed (HTTP ${res.status})`);
    const json = await res.json();
    return json.web_url;
  }

  throw new Error("unsupported git host");
}

// ---------------------------------------------------------------------------
// Approve path: fresh clone, re-resolve, surgical write, commit | PR
// ---------------------------------------------------------------------------

/**
 * Best-effort repo edit for an approved action. The live patch has already
 * been applied by the caller — a failure here never rolls it back, it is
 * only ever surfaced under execution_result.gitops.
 */
async function applyEdit(cfg, action, opts = {}) {
  if (!cfg || !cfg.repo_url || !cfg.folder) {
    throw new Error("gitops is not configured for this cluster");
  }
  const folder = sanitizeFolder(cfg.folder);

  const intent = mapActionToTarget(action, opts);
  if (!intent) {
    throw new Error("action is not eligible for gitops (runtime-only)");
  }
  // Rollback with an ambiguous live source (multiple containers): the
  // executor could not determine which container's image to persist. Skip
  // without even cloning — the live rollback already happened.
  if (action.action_type === "rollback_deployment" && !opts.resolvedImage) {
    throw new Error(
      "rollback source has multiple containers — cannot determine target container for the repo edit (live rollback already applied)",
    );
  }

  return withRepo(cfg, async (repoRoot) => {
    const resolved = resolveTarget(repoRoot, folder, action, opts);
    if (resolved.status !== "ready") {
      throw new Error(`repo target ${resolved.status}${resolved.note ? ": " + resolved.note : ""}`);
    }

    const absFile = path.join(repoRoot, resolved.file);
    assertInsideFolder(repoRoot, folder, absFile);

    // resolved.docIndex pins the EXACT document (within this file) that
    // resolveTarget matched by kind+name+namespace — applyEditInPlace uses
    // it directly instead of re-guessing by field-path depth, which cannot
    // tell apart two candidate docs that resolve the same field (FINDING 1).
    const original = fs.readFileSync(absFile, "utf8");
    const updated = applyEditInPlace(original, resolved.edits, resolved.docIndex);

    const base = { file: resolved.file, field: resolved.field_path, before: resolved.before, after: resolved.after };

    // No-op guard: the live patch may have already converged the cluster
    // (and thus the desired repo value) to what's already committed — e.g.
    // re-approving an action, or the action's target value happens to match
    // the repo already. `git commit` would fail with "nothing to commit"
    // and surface as a spurious error; treat an identical serialization as
    // success instead, before touching the working tree/branch/git at all.
    if (updated === original) {
      return { ...base, commit_sha: null, note: "repo already at desired value — no commit needed" };
    }

    const originalBranch = await getCurrentBranch(repoRoot, cfg.pat);
    let pushBranch = originalBranch;
    if (cfg.delivery_mode === "pr") {
      pushBranch = `moniple/doctor-${shortHash(action.id)}`;
      await runGit(["checkout", "-q", "-b", pushBranch], repoRoot, cfg.pat);
    }

    fs.writeFileSync(absFile, updated, "utf8");

    // Stage EXACTLY the one edited file — never `git add .`/`-A`.
    await runGit(["add", "--", resolved.file], repoRoot, cfg.pat);

    const authorName = cfg.author_name || "Moniple Doctor";
    const authorEmail = cfg.author_email || "doctor@moniple.com";
    await runGit(
      ["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", buildCommitMessage(action)],
      repoRoot,
      cfg.pat,
    );

    const { stdout: shaOut } = await runGit(["rev-parse", "HEAD"], repoRoot, cfg.pat);
    const commitSha = shaOut.trim();

    // Clean `origin` (no embedded credential, per FINDING 3) needs the auth
    // header on this invocation too — it isn't picked up from .git/config.
    await runGit([...gitAuthArgs(cfg.pat), "push", "origin", `HEAD:${pushBranch}`], repoRoot, cfg.pat);

    if (cfg.delivery_mode !== "pr") {
      return { ...base, commit_sha: commitSha };
    }

    const host = detectGitHost(cfg.repo_url);
    if (!host) {
      return { ...base, pr_url: null, note: "branch pushed; open PR manually" };
    }
    try {
      const prUrl = await openPullRequest(host, cfg, pushBranch, originalBranch, action);
      return { ...base, pr_url: prUrl };
    } catch (err) {
      return { ...base, pr_url: null, note: redact(`branch pushed; PR creation failed: ${err.message}`, cfg.pat) };
    }
  });
}

module.exports = {
  sanitizeFolder,
  assertInsideFolder,
  walkYamlFiles,
  redact,
  mapActionToTarget,
  resolveTarget,
  applyEditInPlace,
  authUrl,
  gitAuthHeaderValue,
  gitAuthArgs,
  withRepo,
  computePreviews,
  checkStatus,
  applyEdit,
  detectGitHost,
  buildCommitMessage,
  shortHash,
};
