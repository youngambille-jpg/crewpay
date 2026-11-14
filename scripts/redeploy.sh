#!/usr/bin/env bash
#
# Bring the CrewPay demo up on a fresh container: build the web app, start the
# control plane, start the web server, and verify both answer.
#
# The two servers are started with `setsid` so they survive the shell that
# launched them. Without it they are children of the agent's tmux session and
# get reaped when the session ends, which is why the public link goes dead
# between sessions.
#
# Safe to re-run: it kills only the processes it owns (matched by their exact
# command lines) before starting new ones.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-12000}"
API_PORT="${API_PORT:-4000}"
API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:${API_PORT}}"
LOG_DIR="${LOG_DIR:-/tmp}"

echo "repo:       $REPO"
echo "api:        http://127.0.0.1:${API_PORT}"
echo "web:        http://0.0.0.0:${PORT}  (API_ORIGIN=${API_ORIGIN})"

# Stop the servers we started previously. Patterns are plain substrings — no
# regex metacharacters, which silently fail to match and leave a stale server
# holding the port (the health check then passes against the old one).
echo "→ stopping old servers"
pkill -f "next-server" 2>/dev/null || true
pkill -f "next start -p ${PORT}" 2>/dev/null || true
pkill -f "apps/api/src/serve.ts" 2>/dev/null || true

# Wait until both ports are actually free, so a stale process cannot pass the
# checks below and hide a failed start.
for i in $(seq 1 15); do
  if ! (curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null) \
     && ! (curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:${API_PORT}/health" 2>/dev/null); then
    break
  fi
  sleep 1
done
sleep 1

# The web build must exist before `next start`. Rebuild if it is missing.
if [ ! -f "$REPO/apps/web/.next/BUILD_ID" ]; then
  echo "→ building web app"
  (cd "$REPO" && npm run web:build) || { echo "web build failed"; exit 1; }
else
  echo "→ web build present ($(cat "$REPO/apps/web/.next/BUILD_ID"))"
fi

echo "→ starting api"
cd "$REPO"
PORT="$API_PORT" HOST=0.0.0.0 setsid nohup npm run api >"$LOG_DIR/api.log" 2>&1 < /dev/null &

echo "→ starting web"
cd "$REPO/apps/web"
API_ORIGIN="$API_ORIGIN" setsid nohup npx next start -p "$PORT" -H 0.0.0.0 \
  >"$LOG_DIR/web.log" 2>&1 < /dev/null &

# Wait for both to answer rather than sleeping a fixed amount.
echo "→ waiting for api"
for i in $(seq 1 30); do
  if curl -sf --max-time 2 "http://127.0.0.1:${API_PORT}/health" >/dev/null; then
    echo "  api ok"
    break
  fi
  [ "$i" = 30 ] && { echo "  api did not come up"; tail -20 "$LOG_DIR/api.log"; exit 1; }
  sleep 1
done

echo "→ waiting for web"
for i in $(seq 1 30); do
  if curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:${PORT}/app"; then
    echo "  web ok"
    break
  fi
  [ "$i" = 30 ] && { echo "  web did not come up"; tail -20 "$LOG_DIR/web.log"; exit 1; }
  sleep 1
done

echo "→ verifying routes"
fail=0
for p in / /app /app/approvals /app/pay-runs /app/payees /app/worklist \
         /app/invoices /app/agents /app/policy /app/ledger; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}${p}")
  printf "  %-18s %s\n" "$p" "$code"
  [ "$code" = "200" ] || fail=1
done

echo "→ checking api proxy"
curl -sf --max-time 10 "http://127.0.0.1:${PORT}/api/health" || fail=1
echo

if [ "$fail" = "0" ]; then
  echo "done — open http://localhost:${PORT}/app"
else
  echo "done with failures — see $LOG_DIR/api.log and $LOG_DIR/web.log"
  exit 1
fi
