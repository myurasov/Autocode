#!/bin/sh
# Starts an OpenCode "machine": its OpenCode config points at the fake model
# server (FAKE_MODEL_URL), the Autocode plugin is installed, and `opencode
# serve` runs in the foreground.
set -eu

cfgdir="$HOME/.config/opencode"
mkdir -p "$cfgdir/plugins" "$HOME/work"

cat > "$cfgdir/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "fake/main",
  "update": "disable",
  "share": "disabled",
  "providers": {
    "fake": {
      "name": "Fake",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "${FAKE_MODEL_URL:?FAKE_MODEL_URL is required}",
        "apiKey": "fake"
      },
      "models": {
        "main": {
          "name": "Fake main",
          "limit": { "context": 200000, "output": 8192 },
          "cost": {
            "input": 1,
            "output": 2,
            "cache": { "read": 0.1, "write": 1.25 }
          }
        }
      }
    }
  }
}
EOF

if [ "${PROBE:-0}" = "1" ]; then
  mkdir -p "$cfgdir/plugins/probe"
  cp /opt/autocode/probe/index.js "$cfgdir/plugins/probe/index.js"
fi

if [ -n "${AUTOCODE_URL:-}" ]; then
  # The way an owner installs it on a machine (the server is up: Compose starts
  # nodes after it is healthy).
  autocode plugin install --url "$AUTOCODE_URL" \
    --consumer-token "${AUTOCODE_CONSUMER_TOKEN:?}" >/dev/null
fi

# OpenCode's own environment is every shell's base: the AUTOCODE_* values in
# agents' shells must come from the plugin alone (and the consumer token never
# goes into an agent's shell).
unset AUTOCODE_URL AUTOCODE_CONSUMER_TOKEN
exec opencode serve --hostname 0.0.0.0 --port 4096
