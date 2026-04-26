#!/usr/bin/env bash
#
# Resend inbound webhook smoke test.
#
# Signs a real svix payload with HMAC-SHA256 and POSTs it to either:
#   --echo (default): /webhooks/resend-inbound/echo  (read-only, requires debug token)
#   --full          : /webhooks/resend-inbound       (mutates thread state)
#
# Inputs (flags or env):
#   --url <base>          | BONSAI_BASE_URL          (default http://localhost:3333)
#   --secret <whsec_...>  | RESEND_WEBHOOK_SECRET    (required)
#   --debug-token <tok>   | BONSAI_WEBHOOK_DEBUG_TOKEN (required for --echo)
#   --thread-id <id>      | thread_id to correlate against (required for remote --full)
#
# Examples:
#   # Verify a deployed instance accepts signed payloads (safe: no mutation)
#   bash scripts/resend-inbound-smoke.sh \
#     --url https://bonsai.firebaystudios.com \
#     --secret whsec_xxx --debug-token devtoken --echo
#
#   # End-to-end smoke against local bun run serve (auto-seeds a thread)
#   bash scripts/resend-inbound-smoke.sh \
#     --url http://localhost:3333 --secret whsec_xxx --full
#
set -euo pipefail

MODE="echo"
BASE_URL="${BONSAI_BASE_URL:-http://localhost:3333}"
SECRET="${RESEND_WEBHOOK_SECRET:-}"
DEBUG_TOKEN="${BONSAI_WEBHOOK_DEBUG_TOKEN:-}"
THREAD_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --echo) MODE="echo"; shift ;;
    --full) MODE="full"; shift ;;
    --url) BASE_URL="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --debug-token) DEBUG_TOKEN="$2"; shift 2 ;;
    --thread-id) THREAD_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SECRET" ]]; then
  echo "error: --secret or RESEND_WEBHOOK_SECRET is required" >&2
  exit 2
fi

if [[ "$MODE" == "echo" && -z "$DEBUG_TOKEN" ]]; then
  echo "error: --debug-token or BONSAI_WEBHOOK_DEBUG_TOKEN is required for --echo mode" >&2
  exit 2
fi

# Decode the secret. Resend ships it as `whsec_<base64>`; the HMAC key is
# the base64-decoded bytes. Convert to hex so we can pass it to openssl
# without binary-arg shenanigans.
if [[ "$SECRET" == whsec_* ]]; then
  SECRET_HEX="$(printf '%s' "${SECRET#whsec_}" | base64 --decode | od -An -vtx1 | tr -d ' \n')"
else
  # Plain string secret (used by tests + dev).
  SECRET_HEX="$(printf '%s' "$SECRET" | od -An -vtx1 | tr -d ' \n')"
fi

# Build a deterministic-ish payload for either mode.
SVIX_ID="msg_smoke_$(date +%s)_$$"
SVIX_TS="$(date +%s)"

if [[ "$MODE" == "echo" ]]; then
  PAYLOAD='{"type":"email.received","data":{"from":"smoke@bonsai.test","subject":"Smoke","text":"smoke test","headers":[{"name":"X-Bonsai-Thread-Id","value":"thread_smoke_echo"}]}}'
else
  if [[ -z "$THREAD_ID" ]]; then
    # Local path: seed a thread file under ./out/threads/ so the handler
    # can correlate. We assume CWD is the repo root.
    THREAD_ID="thread_smoke_$(date +%s)_$$"
    THREAD_DIR="${BONSAI_DATA_DIR:-./out}/threads"
    mkdir -p "$THREAD_DIR"
    cat > "$THREAD_DIR/${THREAD_ID}.json" <<JSON
{ "thread_id": "${THREAD_ID}", "outbound": [], "inbound": [] }
JSON
    SEEDED_LOCAL=1
  else
    SEEDED_LOCAL=0
  fi
  PAYLOAD=$(cat <<JSON
{"type":"email.received","data":{"from":{"email":"rep@hospital.example"},"to":[{"email":"appeals@bonsai.test"}],"subject":"Re: Smoke","text":"smoke reply","message_id":"smoke-${SVIX_ID}","headers":[{"name":"X-Bonsai-Thread-Id","value":"${THREAD_ID}"}]}}
JSON
)
fi

TO_SIGN="${SVIX_ID}.${SVIX_TS}.${PAYLOAD}"
SIG_B64="$(printf '%s' "$TO_SIGN" \
  | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${SECRET_HEX}" -binary \
  | base64 \
  | tr -d '\n')"
SVIX_SIG="v1,${SIG_B64}"

if [[ "$MODE" == "echo" ]]; then
  TARGET="${BASE_URL%/}/webhooks/resend-inbound/echo?debug_token=${DEBUG_TOKEN}"
else
  TARGET="${BASE_URL%/}/webhooks/resend-inbound"
fi

echo "→ POST ${TARGET}"
RESP=$(mktemp)
HTTP_CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST "$TARGET" \
  -H "Content-Type: application/json" \
  -H "svix-id: ${SVIX_ID}" \
  -H "svix-timestamp: ${SVIX_TS}" \
  -H "svix-signature: ${SVIX_SIG}" \
  --data-raw "$PAYLOAD")

echo "← HTTP ${HTTP_CODE}"
cat "$RESP"
echo

if [[ "$MODE" == "echo" ]]; then
  if [[ "$HTTP_CODE" != "200" ]]; then
    echo "FAIL: echo expected HTTP 200, got ${HTTP_CODE}" >&2
    rm -f "$RESP"
    exit 1
  fi
  if ! grep -q '"signature_valid":true' "$RESP"; then
    echo "FAIL: echo response did not report signature_valid:true" >&2
    rm -f "$RESP"
    exit 1
  fi
  echo "PASS: signature_valid:true"
else
  if [[ "$HTTP_CODE" != "200" ]]; then
    echo "FAIL: full expected HTTP 200, got ${HTTP_CODE}" >&2
    rm -f "$RESP"
    exit 1
  fi
  if ! grep -q '"correlated":true' "$RESP"; then
    echo "FAIL: full response did not report correlated:true (thread missing on target?)" >&2
    rm -f "$RESP"
    exit 1
  fi
  if ! grep -q '"inserted":true' "$RESP"; then
    echo "FAIL: full response did not report inserted:true" >&2
    rm -f "$RESP"
    exit 1
  fi
  if [[ "${SEEDED_LOCAL:-0}" == "1" ]]; then
    THREAD_FILE="${BONSAI_DATA_DIR:-./out}/threads/${THREAD_ID}.json"
    if ! grep -q '"inbound"' "$THREAD_FILE" || ! grep -q "smoke-${SVIX_ID}" "$THREAD_FILE"; then
      echo "FAIL: thread file ${THREAD_FILE} did not gain the expected inbound row" >&2
      rm -f "$RESP"
      exit 1
    fi
    echo "PASS: HTTP 200, correlated+inserted, thread file advanced (${THREAD_FILE})"
  else
    echo "PASS: HTTP 200, correlated+inserted on remote thread ${THREAD_ID}"
  fi
fi

rm -f "$RESP"
