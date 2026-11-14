#!/usr/bin/env bash
#
# Bring the CrewPay console up on a fresh container: build the web app, start the
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

# The API requires a bearer token and the web app must present the same one, so
# both get it from this variable. Generated once here if absent. The token lives
# in the environment of the two processes and in this file's memory only — never
# in a page, a log line, or the repo.
export CREWPAY_API_TOKEN="${CREWPAY_API_TOKEN:-$(openssl rand -hex 32)}"

echo "repo:       $REPO"
echo "api:        http://127.0.0.1:${API_PORT}"
echo "web:        http://0.0.0.0:${PORT}  (API_ORIGIN=${API_ORIGIN})"

# Stop the servers we started previously. Patterns are plain substrings — no
# regex metacharacters, which silently fail to match and leave a stale server
# holding the port (the health check then passes against the old one). The web
# pattern matches both forms: the full path this script uses and the bare
# `node server.mjs` someone gets when starting it by hand from apps/web.
echo "→ stopping old servers"
pkill -f "apps/web/server.mjs" 2>/dev/null || true
pkill -f "node server.mjs" 2>/dev/null || true
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

# The built server must exist before `node server.mjs`. Rebuild if it is missing.
if [ ! -f "$REPO/apps/web/dist/server/server.js" ]; then
  echo "→ building web app"
  (cd "$REPO" && npm run web:build) || { echo "web build failed"; exit 1; }
else
  echo "→ web build present"
fi

echo "→ starting api"
cd "$REPO"
PORT="$API_PORT" HOST=0.0.0.0 setsid nohup npm run api >"$LOG_DIR/api.log" 2>&1 < /dev/null &

echo "→ starting web"
PORT="$PORT" HOST=0.0.0.0 API_ORIGIN="$API_ORIGIN" \
  setsid nohup node "$REPO/apps/web/server.mjs" >"$LOG_DIR/web.log" 2>&1 < /dev/null &

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

# Only the routes that exist in the TanStack console. The screens not yet wired
# are deliberately absent rather than returning a 200 that renders nothing.
echo "→ verifying routes"
fail=0
for p in / /app /app/approvals /app/pay-runs /app/payees /app/worklist /app/invoices; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}${p}")
  printf "  %-18s %s\n" "$p" "$code"
  [ "$code" = "200" ] || fail=1
done

# A page can return 200 while every stylesheet it references 404s — which is
# what happens when the app is rebuilt underneath a running server: the HTML
# names old asset hashes that the rebuild deleted. The routes above all pass in
# that state, and the page renders unstyled. So fetch each CSS asset the page
# actually asks for and require a 200.
echo "→ checking stylesheets"
app_html=$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/app")
css_refs=$(printf '%s' "$app_html" | grep -oE '/assets/[^"]+\.css' | sort -u)
if [ -z "$css_refs" ]; then
  echo "  no stylesheet referenced by /app — expected at least one"
  fail=1
else
  for ref in $css_refs; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}${ref}")
    printf "  %-45s %s\n" "$ref" "$code"
    [ "$code" = "200" ] || fail=1
  done
fi

if [ "$fail" = "0" ]; then
  echo "done — open http://localhost:${PORT}/app"
else
  echo "done with failures — see $LOG_DIR/api.log and $LOG_DIR/web.log"
  exit 1
fi
