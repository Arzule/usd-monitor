#!/usr/bin/env bash
# Smoke test de producción. Uso: scripts/smoke.sh <BASE_URL> [RESULTS_FILE]
# Reintenta todos los checks cada 5 s durante ~60 s (SMOKE_TIMEOUT) hasta que
# pasen todos. Escribe una tabla Markdown con el resultado de cada check en
# RESULTS_FILE (para $GITHUB_STEP_SUMMARY). Sale con 0 si todo pasa.
set -uo pipefail

BASE="${1:?uso: smoke.sh <BASE_URL> [RESULTS_FILE]}"
BASE="${BASE%/}"
RESULTS="${2:-/dev/null}"
TIMEOUT="${SMOKE_TIMEOUT:-60}"
TITLE="USD/PEN Monitor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Cada check se implementa en una función check_<nombre>.
# Los endpoints que aún no existen se agregan aquí cuando se implementan.
CHECKS=(health live_latest bcrp_latest home)

# http <método> <ruta> [cuerpo] → deja el cuerpo en $TMP/body y devuelve el código HTTP.
http() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -o "$TMP/body" -w '%{http_code}' --max-time 10 -X "$method"
    -H 'cache-control: no-cache' "${BASE}${path}")
  if [ -n "$data" ]; then
    args+=(-H 'content-type: application/json'
      -H 'accept: application/json, text/event-stream' --data "$data")
  fi
  curl "${args[@]}" 2>/dev/null || true  # -w ya imprime 000 si no hubo respuesta
}

# json_ok '<expresión JS sobre b>' → evalúa la expresión con b = JSON del último cuerpo.
# Usa node (presente en CI y en local) leyendo por stdin, sin depender de jq.
json_ok() {
  node -e 'const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.exit(new Function("b", "return (" + process.argv[1] + ");")(b) ? 0 : 1);' "$1"     < "$TMP/body" 2>/dev/null
}

check_health() {
  local code; code="$(http GET /api/health)"
  [ "$code" = "200" ] || { echo "HTTP $code"; return 1; }
  json_ok 'b.status === "ok" && typeof b.market_open === "boolean"' || { echo "JSON inválido o status != ok"; return 1; }
  echo "200, status ok"
}

# /latest puede venir vacío (data: null): se valida la forma, no que haya datos.
check_live_latest() {
  local code; code="$(http GET /api/live/latest)"
  [ "$code" = "200" ] || { echo "HTTP $code"; return 1; }
  json_ok '"data" in b && (b.data === null || (typeof b.data.price === "number" && typeof b.data.ts === "number"))' \
    || { echo "forma JSON inesperada"; return 1; }
  echo "200, forma ok"
}

check_bcrp_latest() {
  local code; code="$(http GET /api/bcrp/latest)"
  [ "$code" = "200" ] || { echo "HTTP $code"; return 1; }
  json_ok '"data" in b && (b.data === null || /^\d{4}-\d{2}-\d{2}$/.test(b.data.date))' \
    || { echo "forma JSON inesperada"; return 1; }
  echo "200, forma ok"
}

check_home() {
  local code; code="$(http GET /)"
  [ "$code" = "200" ] || { echo "HTTP $code"; return 1; }
  grep -q "<title>${TITLE}</title>" "$TMP/body" || { echo "falta el título del dashboard"; return 1; }
  echo "200, título presente"
}

declare -A STATUS DETAIL
deadline=$(( $(date +%s) + TIMEOUT ))
attempt=0
while :; do
  attempt=$((attempt + 1))
  all_ok=1
  for c in "${CHECKS[@]}"; do
    if out="$("check_$c")"; then STATUS[$c]="✅"; else STATUS[$c]="❌"; all_ok=0; fi
    DETAIL[$c]="$out"
  done
  [ "$all_ok" = 1 ] && break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 5
done

{
  echo "| Check | Resultado | Detalle |"
  echo "|---|---|---|"
  for c in "${CHECKS[@]}"; do echo "| \`$c\` | ${STATUS[$c]} | ${DETAIL[$c]} |"; done
  echo
  echo "Intentos: ${attempt}"
} | tee -a "$RESULTS"

[ "$all_ok" = 1 ]
