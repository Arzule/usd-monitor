#!/usr/bin/env bash
# Imprime un log de wrangler redactando direcciones de email (los logs de Actions
# del repo son públicos). Uso: scripts/redact-log.sh <archivo>
set -euo pipefail
sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email-redactado>/g' "$1"
