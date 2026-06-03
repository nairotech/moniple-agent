## What & why

Describe what this PR changes and the motivation.

Closes #<issue> <!-- if applicable -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] CI / build

## Checklist

- [ ] Code/comments/identifiers are in English (project convention).
- [ ] The agent still boots cleanly (`npm start` → `/health` returns 200), and the affected path was smoke-tested.
- [ ] `npm test` passes.
- [ ] No secrets committed (`.env` is git-ignored).
- [ ] Security-sensitive changes (remediation, RBAC, auth, CORS, LLM client) preserve the fail-closed / guardrail behavior described in [SECURITY.md](../SECURITY.md).
- [ ] Image builds remain stamped (`AGENT_BUILD_DATE` + `v<ts>` tag) — see [CONTRIBUTING.md](../CONTRIBUTING.md).

## How was this tested?

Describe the tests / manual verification you ran.
