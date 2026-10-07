#!/usr/bin/env bash
# Deploy predge_guard (and, if funds allow, the example_consumer vault) to
# Solana devnet, then run both demos there.
#
# SOL needed: predge_guard.so is ~247 KB. A deploy first writes a buffer
# (~1.25 SOL) and then the program data (~1.25 SOL), so the peak is ~2.6 SOL;
# the buffer rent comes back afterwards. example_consumer.so (~196 KB) peaks
# at ~2.0 SOL on top of the ~1.26 SOL left locked by predge_guard.
# If a deploy fails mid-way, `solana program close --buffers` returns the SOL.
set -euo pipefail
cd "$(dirname "$0")/.."
WALLET="${WALLET:-$HOME/.config/solana/predge-devnet.json}"
URL="${URL:-https://api.devnet.solana.com}"
SKIP_BUILD="${SKIP_BUILD:-0}"

balance() { solana balance --url "$URL" --keypair "$WALLET" | awk '{print $1}'; }
deployed() { solana program show "$1" --url "$URL" >/dev/null 2>&1; }

deploy() { # program name
  local so="target/deploy/$1.so" kp="target/deploy/$1-keypair.json"
  local id; id=$(solana-keygen pubkey "$kp")
  echo "== $1 ($id), balance $(balance) SOL"
  if ! solana program deploy "$so" --program-id "$kp" --keypair "$WALLET" --url "$URL" \
      --max-sign-attempts 50 --use-rpc; then
    echo "deploy of $1 failed; recovering buffer rent"
    solana program close --buffers --keypair "$WALLET" --url "$URL" --bypass-warning || true
    return 1
  fi
  solana program show "$id" --url "$URL"
}

echo "deployer: $(solana-keygen pubkey "$WALLET")  balance: $(balance) SOL"
[ "$SKIP_BUILD" = 1 ] || anchor build

deployed "$(solana-keygen pubkey target/deploy/predge_guard-keypair.json)" || deploy predge_guard
deployed "$(solana-keygen pubkey target/deploy/example_consumer-keypair.json)" || deploy example_consumer \
  || echo "example_consumer not deployed; api-demo falls back to calling check_settlement directly"

export ANCHOR_PROVIDER_URL="$URL" ANCHOR_WALLET="$WALLET"
npx ts-node scripts/api-demo.ts "${MARKET_ID:-2169995}" | tee demo-api-devnet.log
npx ts-node scripts/demo.ts | tee demo-devnet.log
