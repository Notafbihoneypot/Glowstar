#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
podman compose ps
echo
echo "Commerce:"
curl -fsS http://127.0.0.1:8787/health || true
echo
echo "Crosspost:"
curl -fsS http://127.0.0.1:8790/health || true
echo
echo "Monero node:"
curl -fsS -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' http://127.0.0.1:18081/json_rpc || true
echo
