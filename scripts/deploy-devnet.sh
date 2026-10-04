#!/usr/bin/env bash
# Deploy predge_guard to Solana devnet and run the demo there.
# Needs ~2 devnet SOL on the deployer wallet (faucet.solana.com).
set -euo pipefail
cd "$(dirname "$0")/.."
WALLET="${WALLET:-$HOME/.config/solana/predge-devnet.json}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-target/deploy/predge_guard-keypair.json}"
URL="${URL:-https://api.devnet.solana.com}"

echo "deployer: $(solana-keygen pubkey "$WALLET")  balance: $(solana balance --url "$URL" --keypair "$WALLET")"
anchor build
solana program deploy target/deploy/predge_guard.so \
  --program-id "$PROGRAM_KEYPAIR" --keypair "$WALLET" --url "$URL"
solana program show "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" --url "$URL"

ANCHOR_PROVIDER_URL="$URL" ANCHOR_WALLET="$WALLET" npx ts-node scripts/demo.ts | tee demo-devnet.log
