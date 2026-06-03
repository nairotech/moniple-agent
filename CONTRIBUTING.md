# Contributing to Moniple Agent

Thanks for your interest in contributing! This document covers how to set up the
project, the conventions we follow, and how to submit changes.

## Code of conduct

Be respectful and constructive. Assume good intent. Harassment of any kind is not
tolerated.

## Getting started

Requirements: **Node.js ≥ 20** and Docker (for image builds).

```bash
git clone https://github.com/nairotech/moniple-agent.git
cd moniple-agent
npm ci
cp .env.template .env   # fill in values for local runs
npm start               # http://localhost:3000/health
```

To exercise the in-cluster paths (auto-install, RBAC, Doctor remediation) you
need a Kubernetes cluster and the appropriate RBAC from [`manifests/`](manifests/).

## Project layout

```
app.js                 # entry point: HTTP server, metrics collection, server push
diagnostics/           # Moniple Doctor (optional AI diagnostics)
  index.js             #   orchestration, remediation execution + guardrails
  collector.js         #   cluster state collection
  llm-client.js        #   multi-provider LLM client (SSRF-guarded)
  prompts.js           #   prompt templates (multi-locale)
manifests/             # Kubernetes RBAC + monitoring stack manifests
Dockerfile             # multi-stage, node:22-alpine
.env.template          # all supported environment variables
```

## Conventions

- **Language:** code, comments, identifiers, and user-facing strings in English.
- **Style:** match the surrounding code. Keep changes focused; avoid unrelated
  reformatting in the same PR.
- **No secrets:** never commit credentials. `.env` is git-ignored.
- **Backwards compatibility:** the agent runs across many clusters and the Moniple
  server depends on its push contract — avoid breaking the snapshot/heartbeat
  payloads or endpoint shapes without coordination.
- **Security first:** changes to remediation, RBAC, auth, CORS, or the LLM client
  must preserve the fail-closed and guardrail behavior described in
  [SECURITY.md](SECURITY.md).

## Build & version stamping (important)

Images **must** be stamped with a build timestamp. The Moniple app's
"agent update available" feature compares the agent's reported version against
the latest known build, and the self-update pulls `nairotech/moniple-agent:v<ts>`.
An unstamped build reports version `0`, which breaks version comparison and leaves
no matching image tag to update to.

Always pass `AGENT_BUILD_DATE` (a unix timestamp) and tag the image `v<ts>` with
the same value:

```bash
TS=$(date +%s)
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg AGENT_BUILD_DATE=$TS \
  -t nairotech/moniple-agent:latest \
  -t nairotech/moniple-agent:v$TS \
  --push .

# Tag the source commit with the SAME version, so the image is traceable to its
# exact code (git checkout v$TS) and the git tag matches what agents report.
git tag "v$TS" && git push origin "v$TS"
```

CI (`.github/workflows/main.yml`) does both — the image tag **and** the matching
`v<ts>` git tag — automatically on every push to `main`. Keep it that way.
(Human-facing GitHub Releases are cut separately at semver milestones, e.g.
`v1.0.0`.)

## Submitting changes

1. Fork the repo and create a feature branch off `main`.
2. Make your change with clear, descriptive commits.
3. Verify the agent still boots cleanly (`npm start`, hit `/health`) and, where
   relevant, smoke-test the affected path.
4. Open a pull request describing **what** changed and **why**. Link any related
   issue.
5. For security-sensitive issues, follow [SECURITY.md](SECURITY.md) instead of
   opening a public issue/PR.

## Reporting bugs & requesting features

Use [GitHub Issues](https://github.com/nairotech/moniple-agent/issues). Include
your environment (Kubernetes flavor/version, metrics backend), agent version, and
clear reproduction steps. For security reports, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
