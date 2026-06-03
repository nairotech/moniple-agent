---
name: Bug report
about: Report a problem with the Moniple Agent
title: "[bug] "
labels: bug
---

## Description

A clear description of what the bug is.

## Steps to reproduce

1. ...
2. ...
3. ...

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened (include logs / error messages).

## Environment

- Agent version (from boot log `build:` line, or image tag):
- Kubernetes flavor & version (GKE / EKS / AKS / k3s / on-prem, `kubectl version`):
- Metrics backend (Prometheus / VictoriaMetrics / Thanos / Mimir):
- Auto-install monitoring enabled? (`AUTO_INSTALL_MONITORING`):

## Logs

```
<relevant agent pod logs — kubectl logs deploy/moniple-agent -n moniple>
```

> For security vulnerabilities, do NOT open a public issue — see [SECURITY.md](../../SECURITY.md).
