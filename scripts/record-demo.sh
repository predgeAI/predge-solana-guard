#!/usr/bin/env bash
# Recording helper: runs the API demo on devnet without printing the RPC URL.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
set -a; . "$HOME/.predge-solana-devnet.env"; set +a
ANCHOR_PROVIDER_URL="$DEVNET_RPC" ANCHOR_WALLET="$HOME/.config/solana/predge-devnet.json" \
  npx ts-node scripts/api-demo.ts "${1:-1484949}"
