#!/usr/bin/env sh
set -eu

if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  NODE_BIN="/Users/lucius/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi

PORT_NUMBER="${PORT:-3000}"

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT_NUMBER" -sTCP:LISTEN >/dev/null 2>&1; then
  printf "Port %s is already in use.\n" "$PORT_NUMBER"
  printf "Stop the old local server and restart with the saved .env? [y/N] "
  IFS= read -r answer
  case "$answer" in
    y|Y|yes|YES)
      lsof -tiTCP:"$PORT_NUMBER" -sTCP:LISTEN | xargs kill
      sleep 1
      ;;
    *)
      printf "Kept the existing server running.\n"
      printf "Open http://127.0.0.1:%s/api/health to check it.\n" "$PORT_NUMBER"
      exit 0
      ;;
  esac
fi

exec "$NODE_BIN" src/server.js
