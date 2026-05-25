#!/usr/bin/env sh
set -eu

printf "Paste your Gemini API key. It will not be shown: "
stty -echo
IFS= read -r GEMINI_API_KEY
stty echo
printf "\n"

if [ -z "$GEMINI_API_KEY" ]; then
  printf "No key entered. Nothing changed.\n"
  exit 1
fi

cat > .env <<EOF
PORT=3000
HOST=127.0.0.1
AI_PROVIDER=gemini
GEMINI_API_KEY=$GEMINI_API_KEY
GEMINI_MODEL=gemini-2.5-flash
EOF

printf "Gemini key saved to .env. Restart the local server to use it.\n"
