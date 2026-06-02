# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately:

- Email **security@nairotech.com**, or
- Use GitHub's **[Private vulnerability reporting](https://github.com/nairotech/moniple-agent/security/advisories/new)**
  (Security → Report a vulnerability).

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce (proof-of-concept, affected version/commit, configuration).
- Any suggested remediation, if you have one.

We aim to acknowledge reports within **3 business days** and to provide a
remediation plan or timeline within **10 business days**. We will keep you
informed of progress and credit you in the advisory unless you prefer to remain
anonymous.

## Supported versions

This project is released as a rolling latest. Security fixes are applied to the
`main` branch and published as new `nairotech/moniple-agent` images. Please run a
recent build.

## Security model & hardening

The agent runs **inside** your Kubernetes cluster and **pushes outbound** to a
Moniple server. The server never connects into the cluster, so there are no
inbound ports to expose.

Relevant controls (all configurable via environment variables — see the README):

- **`/metrics/*` is fail-closed.** With an API key configured but
  missing/invalid, requests return `401`. `/health` is intentionally public for
  Kubernetes probes. Set `ALLOW_UNAUTHENTICATED_METRICS=true` only if you
  deliberately want the read API open when no API key is set.
- **CORS is disabled by default.** These are machine endpoints, not a browser
  app. Use `AGENT_CORS_ORIGIN` to allow a specific origin if needed.
- **Doctor remediation is guarded.** Approved actions are allow-listed and
  parameter-validated; the namespaces `kube-system`, `kube-public`, and
  `kube-node-lease` are always protected. Use `DOCTOR_REMEDIATION_MODE`
  (`full` / `safe` / `off`) to control execution. Destructive actions
  (delete/scale/cordon/rollback) are blocked in `safe` mode.
- **LLM endpoint SSRF guard.** The Doctor LLM `base_url` is validated: cloud
  metadata endpoints and loopback addresses are always blocked. Private /
  cluster-internal targets are blocked unless
  `DOCTOR_ALLOW_PRIVATE_LLM_ENDPOINT=true`.

## RBAC

The agent ships two RBAC profiles under [`manifests/`](manifests/):

- `moniple-agent-rbac.yaml` — full profile (required to auto-install the
  monitoring stack and to execute Doctor remediation).
- `moniple-agent-rbac-minimal.yaml` — read-only profile for environments that
  bring their own monitoring and do not want the agent to hold write
  permissions.

Grant the **least** profile that fits your use case.

## Secrets

Never commit secrets. `MONIPLE_API_KEY`, metrics backend credentials, and LLM API
keys must be provided via environment variables or Kubernetes Secrets at runtime.
`.env` is git-ignored.
