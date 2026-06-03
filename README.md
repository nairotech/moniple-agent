# Moniple Agent

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Build and Push](https://github.com/nairotech/moniple-agent/actions/workflows/main.yml/badge.svg)](https://github.com/nairotech/moniple-agent/actions/workflows/main.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/nairotech/moniple-agent)](https://hub.docker.com/r/nairotech/moniple-agent)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)

A lightweight, in-cluster Kubernetes monitoring agent. It collects metrics from
Prometheus or VictoriaMetrics, optionally bootstraps a minimal monitoring stack,
and pushes compact snapshots to a [Moniple](https://moniple.com) server so they
can be viewed in the Moniple mobile/web app. It also includes an optional
AI-assisted diagnostics engine ("Moniple Doctor").

> The agent **pushes outbound** to the Moniple server. The server never connects
> into your cluster — there are no inbound ports to expose.

---

## Features

- **Metrics collection** — queries Prometheus / VictoriaMetrics (PromQL) and the
  Kubernetes API, and normalizes results into compact JSON snapshots (overview,
  nodes, pods, PVCs, namespaces, alerts).
- **Push-based** — periodically pushes snapshots + a heartbeat to a Moniple
  server using an API key. No inbound connectivity required.
- **Auto-install monitoring stack** *(optional)* — if no monitoring is found, the
  agent installs a small stack (VictoriaMetrics single + vmagent,
  kube-state-metrics, node-exporter) into a dedicated namespace.
- **Moniple Doctor** *(optional)* — runs LLM-assisted diagnostics over cluster
  state and produces findings + remediation suggestions. Remediation execution is
  **opt-in, allow-listed, and namespace-guarded** (see [Security](#security)).
- **Local read API** — exposes `/health` and `/metrics/*` JSON endpoints for
  debugging and direct integrations.

---

## Architecture

```
   ┌──────────────────────── your Kubernetes cluster ────────────────────────┐
   │                                                                          │
   │   Prometheus / VictoriaMetrics ──PromQL──┐                               │
   │   Kubernetes API ────────────────────────┤                              │
   │                                          ▼                               │
   │                                  ┌─────────────────┐                     │
   │                                  │  moniple-agent  │── /health, /metrics │
   │                                  └────────┬────────┘   (local read API)  │
   │                                           │                              │
   └───────────────────────────────────────────┼─────────────────────────────┘
                                                │ HTTPS push (API key)
                                                ▼
                                       ┌──────────────────┐
                                       │  Moniple server  │ → mobile / web app
                                       └──────────────────┘
```

---

## Quick start

### On a cluster (recommended)

The easiest path is to create a cluster in the Moniple app and run the install
command it gives you — it renders a manifest (ServiceAccount + RBAC + Deployment)
pre-filled with your `MONIPLE_SERVER_URL` and `MONIPLE_API_KEY`.

The deployment uses the published image:

```
nairotech/moniple-agent:latest
```

RBAC manifests are provided under [`manifests/`](manifests/):

- `moniple-agent-rbac.yaml` — full RBAC (enables the auto-install of the
  monitoring stack and Doctor remediation).
- `moniple-agent-rbac-minimal.yaml` — read-only RBAC for environments where you
  bring your own monitoring and don't want write permissions.

### Standalone (Docker)

Run against an existing Prometheus/VictoriaMetrics endpoint:

```bash
docker run -d \
  -p 3000:3000 \
  -e PROMETHEUS_API_URL=http://prometheus:9090/api/v1 \
  nairotech/moniple-agent:latest
```

### Local (Node.js)

```bash
npm ci
cp .env.template .env   # then edit values
npm start               # listens on :3000
```

---

## Configuration

All configuration is via environment variables. See [`.env.template`](.env.template).

### Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROMETHEUS_API_URL` | When not auto-installing | `http://prometheus:9090/api/v1` | Prometheus / VictoriaMetrics query API base URL. |
| `PROMETHEUS_API_USER` | No | – | Basic auth username for the metrics backend. |
| `PROMETHEUS_API_PASSWORD` | No | – | Basic auth password for the metrics backend. |
| `DEFAULT_THRESHOLD` | No | `80` | Percentage at which a metric is flagged `critical`. |
| `PORT` | No | `3000` | Local HTTP server port. |

### Moniple server push

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONIPLE_SERVER_URL` | For push | – | Moniple server base URL. If unset, push is disabled. |
| `MONIPLE_API_KEY` | For push | – | Cluster API key (created in the Moniple app). |
| `PUSH_INTERVAL_SECONDS` | No | `60` | Snapshot push interval, in seconds. |

### Monitoring auto-install

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTO_INSTALL_MONITORING` | No | `true` | Set `false` to disable installing a monitoring stack. |
| `MONITORING_NAMESPACE` | No | `moniple` | Namespace used for the installed stack. |

### Security hardening (all optional)

| Variable | Default | Description |
|---|---|---|
| `DOCTOR_REMEDIATION_MODE` | `full` | `full` = execute all allow-listed & validated remediation actions; `safe` = block destructive actions (delete/scale/cordon/rollback); `off` = reject all remediation. |
| `DOCTOR_ALLOW_PRIVATE_LLM_ENDPOINT` | `false` | Allow the Doctor LLM `base_url` to target private/cluster-internal addresses. Cloud metadata and loopback are **always** blocked. |
| `ALLOW_UNAUTHENTICATED_METRICS` | `false` | When `MONIPLE_API_KEY` is unset, allow unauthenticated access to `/metrics/*`. Default is fail-closed (401). `/health` is always public. |
| `AGENT_CORS_ORIGIN` | – | Restrict browser CORS to a specific origin. Default: CORS disabled (these are machine endpoints). |

---

## Local read API

Useful for debugging and direct integrations. When `MONIPLE_API_KEY` is set,
`/metrics/*` requires the `X-API-Key` header (fail-closed). `/health` is always open.

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness/readiness probe. `{ "ok": true, "timestamp": <unix> }` |
| `GET /metrics/overview` | Cluster summary: nodes, pods, CPU/memory/disk/pod usage, alerts, health. |
| `GET /metrics/ns` | Namespace list. |
| `GET /metrics/node` | Per-node CPU/memory/disk/pod usage. |
| `GET /metrics/pod` | Pod phases + per-pod CPU/memory. |
| `GET /metrics/pvc` | PVC capacity and usage. |
| `GET /metrics/alerts` | Active alerts grouped by severity. |

All responses use a consistent envelope: `{ "ok": boolean, ... }`, or
`{ "ok": false, "error": "<message>" }` on failure.

---

## Supported metrics backends

PromQL-compatible backends work out of the box:

- Prometheus
- VictoriaMetrics (vmsingle / vmselect)
- Thanos Query
- Cortex / Mimir

---

## Security

- The agent is **push-only**; the Moniple server never initiates connections into
  your cluster.
- `/metrics/*` is **fail-closed**: with an API key configured but missing/invalid,
  it returns `401`. `/health` stays public for probes.
- **Doctor remediation** is opt-in and guarded: actions are allow-listed and
  parameter-validated, namespaces `kube-system` / `kube-public` /
  `kube-node-lease` are always protected, and execution can be downgraded to
  `safe` or disabled entirely via `DOCTOR_REMEDIATION_MODE`.
- The Doctor LLM endpoint is SSRF-guarded: cloud metadata and loopback addresses
  are always blocked.

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not
open public issues for security reports.

---

## Building the image

Multi-arch build. Stamp the build with a unix timestamp so the in-app
"agent update available" feature works (see [CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
TS=$(date +%s)
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg AGENT_BUILD_DATE=$TS \
  -t nairotech/moniple-agent:latest \
  -t nairotech/moniple-agent:v$TS \
  --push .
```

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
