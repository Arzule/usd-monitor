#!/usr/bin/env bash
# Protege la rama main de Arzule/usd-monitor (idempotente).
# - Exige que el check "ci" (workflow ci.yml) pase y que la rama esté al día.
# - Prohíbe force-push y borrado, también para administradores (enforce_admins).
# - NO exige aprobaciones: autor y dueño son la misma cuenta; la revisión la hace
#   un subagente que comenta en el PR (ver README > CI/CD).
set -euo pipefail
REPO="${1:-Arzule/usd-monitor}"

gh api -X PUT "repos/${REPO}/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "ci" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": false
}
JSON

gh api "repos/${REPO}/branches/main/protection" \
  --jq '{checks: [.required_status_checks.checks[].context], strict: .required_status_checks.strict, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
