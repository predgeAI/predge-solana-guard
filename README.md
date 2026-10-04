# Predge Settlement Guard (Solana)

Signed settlement-risk attestations for prediction markets, verified on Solana, plus a settlement gate any Solana market, perps venue or escrow can call before it settles on an outcome.

Prediction-market outcomes are not final the moment someone proposes them. Predge reads the UMA dispute path of every Polymarket market from Polygon. From 1 Jan to 2 Oct 2026 that scan found **3,005 disputes on 2,666 Polymarket markets**. **323** of them were disputed twice or more, which sends the outcome to a UMA vote. Of the **2,543** that have settled, **853 (33.5%) settled differently from the disputed proposal.**

A Solana app that settles on the same events (a mirrored market, an event perp, a parlay, an escrow, an agent payment) needs to know when the reference outcome is still at risk and when it is final. This program puts that signal on-chain in a form other programs can trust and compose with.

## What it does

```
Polygon (UMA / Polymarket)         Predge                         Solana
------------------------------     ---------------------------    -----------------------------------------
ProposePrice / DisputePrice   -->  scanner + evidence pack   -->  tx: [Ed25519 verify ix, post_attestation]
QuestionResolved                   97-byte ed25519 attestation      -> MarketRisk PDA per market
                                                                   any program: check_settlement (CPI)
                                                                   demo consumer: escrow release gate
```

- **`post_attestation`** (permissionless relay). The transaction carries a native Ed25519 signature-verification instruction. The program reads the instructions sysvar and checks that the signature is from the configured Predge attestor key, over exactly the bytes of this attestation. A relayer cannot alter a field. Older observations cannot overwrite newer ones, and a settled market cannot be moved back to disputed.
- **`MarketRisk` PDA** (`["risk", market_key]`): status (`PROPOSED`, `DISPUTED`, `ESCALATED` to a UMA vote, `SETTLED`), dispute count, whether the final outcome differed from the last disputed proposal, a risk score in basis points, settlement time, observation time and the sha256 of the full off-chain evidence pack.
- **`check_settlement`**: the gate. It succeeds only if the reference market is settled and past a configurable cooling window. It fails with `SettlementNotFinal`, `MarketDisputed`, `MarketEscalated` or `CoolingPeriod`. Call it through CPI or read the account directly.
- **`open_escrow` / `release_escrow`**: a minimal consumer. Funds stay locked while the reference market is proposed, disputed or escalated, and go to the beneficiary once it is final.

### Attestation layout (signed bytes, 97)

| Offset | Size | Field |
|---|---|---|
| 0 | 12 | `PREDGE-SR-v1` domain separator |
| 12 | 32 | `market_key` = sha256("polymarket:" + UMA questionID) |
| 44 | 1 | status (1 proposed, 2 disputed, 3 escalated, 4 settled) |
| 45 | 1 | dispute count |
| 46 | 1 | settled differently from the last disputed proposal (0/1) |
| 47 | 2 | risk_bps (u16 LE) |
| 49 | 8 | settled_at (i64 LE, unix) |
| 57 | 8 | observed_at (i64 LE, unix) |
| 65 | 32 | evidence_hash = sha256 of the signed evidence pack's canonical bytes |

### Risk score (v0, deliberately simple)

- Settled on Polygon: `0`.
- Open dispute (disputed once, or escalated to a vote): `3354` bps, the 2026 base rate (853 of 2,543 settled disputed markets settled differently from the disputed proposal).
- Proposed, not disputed: not scored in v0 (`0`); the gate still blocks because the market is not settled.

The score is advisory. The gate itself only trusts status and time.

## Data

`data/polymarket-disputes-2026.json` holds the 2,666 disputed markets from Predge's on-chain scan (market-level fields and Polygon tx hashes only, no wallet addresses). `npx ts-node scripts/stats.ts` recomputes the numbers above, and a test asserts them.

`examples/pm-2169995-microstrategy-may31.pack.json` is a full signed evidence pack for "MicroStrategy sells any Bitcoin by May 31, 2026?": every proposal, dispute, bulletin-board update, the UMA vote on Ethereum and the final resolution, each with a tx hash. It is signed with a throwaway prototype key (stated inside the pack). Verify it with `npx ts-node scripts/verify-pack.ts examples/pm-2169995-microstrategy-may31.pack.json`. Its `content_hash` is the `evidence_hash` used in the demo replay.

## Run it

Requirements: Rust, [Agave/Solana CLI](https://docs.anza.xyz/cli/install) 2.x or newer, Anchor CLI 0.32, Node 20.

```bash
npm install
anchor build
anchor test                 # local validator: 19 tests (program + off-chain)
cargo test -p predge_guard  # Rust unit tests
```

Local end-to-end demo:

```bash
solana-test-validator --reset --bpf-program B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush target/deploy/predge_guard.so
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json npx ts-node scripts/demo.ts
```

Devnet:

```bash
./scripts/deploy-devnet.sh   # deploys, then runs the same demo with explorer links
```

Demo output (localnet):

```
Replay: "MicroStrategy sells any Bitcoin by May 31, 2026?" (Polymarket 2169995)
open_escrow 0.01 SOL
2026-06-01T04:00:05Z  PROPOSED              risk    0 bps
    release_escrow -> blocked: SettlementNotFinal
2026-06-01T04:12:20Z  DISPUTED              risk 3354 bps
    release_escrow -> blocked: MarketDisputed
2026-06-01T04:53:01Z  ESCALATED (UMA vote)  risk 3354 bps
    release_escrow -> blocked: MarketEscalated
2026-06-04T00:34:19Z  SETTLED               risk    0 bps
    release_escrow -> RELEASED
```

The demo then posts attestations for markets that were still open at the end of the scan and reads the on-chain board back.

## Program

- Program ID: `B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush`
- Source: `programs/predge_guard/src/lib.rs`
- IDL: `target/idl/predge_guard.json`

## Trust model and limits

- The attestor key is the trust anchor. The demo uses a locally generated devnet key. A production deployment would use Predge's published attestation key and rotate it through `update_config`.
- v0 covers Polymarket markets resolved through UMA on Polygon. The market key is venue-namespaced so other venues can be added.
- One attestor, no slashing on Solana yet. Predge's verdict-arbiter contracts with bonds already run on Arc, Arbitrum and Robinhood Chain; porting the bond to Solana is next.
- The escrow is a reference consumer, not an audited product.

## Related Predge work

- `api.predge.io`: paid x402 API. Every paid route already accepts USDC on Solana mainnet next to Base.
- Signed ed25519 envelopes for outcome and track-record data, verifiable offline against a published key.

MIT licensed.
