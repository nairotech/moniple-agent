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
 *     reserialize of unrelated content.
 *   - One action = one file = one commit. Staging is always `git add
 *     <exact file>`, never `git add .`/`-A`.
 *
 * This first slice covers target resolution and the surgical edit only (pure
 * filesystem, no git/network yet) — see the git plumbing (clone/commit/PR)
 * added on top of this in the following commit.
 */

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

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
    for (const doc of docs) {
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
 */
function applyEditInPlace(text, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("applyEditInPlace requires at least one edit");
  }
  const docs = YAML.parseAllDocuments(text, { logLevel: "silent" });
  if (docs.length === 0) {
    throw new Error("no YAML documents found in the given text");
  }
  const targetIndex = docs.length === 1 ? 0 : pickTargetDocIndex(docs, edits);
  if (targetIndex === -1) {
    throw new Error("could not determine which document to edit");
  }
  const target = docs[targetIndex];
  for (const edit of edits) {
    target.setIn(edit.path, edit.value);
  }
  return docs.map((d) => String(d)).join("");
}

module.exports = {
  sanitizeFolder,
  assertInsideFolder,
  walkYamlFiles,
  mapActionToTarget,
  resolveTarget,
  applyEditInPlace,
};
