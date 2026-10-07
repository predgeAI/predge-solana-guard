# Predge Settlement Guard (Solana)

Know when a prediction-market outcome is final before you settle on it.

Predge Settlement Guard puts signed settlement-risk attestations for prediction markets on Solana, and gives every Solana program a one-call gate, `check_settlement`, that refuses to settle while the reference market is disputed, escalated to a vote, or freshly resolved.

| | Address |
|---|---|
| Guard program | `B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush` |
| Example consumer (vault) | `6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg` |

Devnet status and transaction links: [Devnet](#devnet).

## The problem

A prediction-market outcome is not final the moment someone proposes it. On Polymarket, an outcome is proposed to UMA's optimistic oracle on Polygon. Anyone can dispute it, and a second dispute sends it to a UMA token-holder vote.

Predge reads that whole path from Polygon logs. For 1 Jan to 2 Oct 2026:

- **3,005 disputes on 2,666 Polymarket markets**;
- **323** markets disputed twice or more;
- of the **2,543** disputed markets that have settled, **853 (33.5%) settled differently from the disputed proposal**;
- median time to on-chain resolution: **3.3 h** after a first dispute, **88.5 h** after a second.

The dataset ships in this repo and a test recomputes every number (`tests/attestation.spec.ts`).

Anything that settles on the same event before that path is finished (a mirrored market, an event perp, a parlay, an escrow, a vault, an agent payment) can release funds on an outcome that later changes, or sit frozen for days without knowing why.

## Why Solana

Polymarket outcomes already decide money on Solana.

- **Jupiter brought Polymarket to Solana in February 2026.** The Block, 1 Feb 2026: "Jupiter users can access Polymarket contracts without leaving the app" ([source](https://www.theblock.co/post/387945/jupiter-polymarket-solana)). CoinDesk, 2 Feb 2026, quoting Jupiter: "For the first time, Polymarket is coming to Solana. On Jupiter" ([source](https://www.coindesk.com/markets/2026/02/02/jupiter-brings-polymarket-to-solana-and-lands-usd35-million-investment-deal)).
- **Polymarket is the default provider of Jupiter's Prediction API.** The API reference describes `provider` as "Data provider for events (defaults to polymarket)" ([get-events](https://developers.jup.ag/docs/api-reference/prediction/get-events), [search-events](https://developers.jup.ag/docs/api-reference/prediction/search-events)); the build guide says "Polymarket (default) has more markets" ([guide](https://developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana)). Checked live on 7 Oct 2026: `GET https://api.jup.ag/prediction/v1/events` with no provider returns `POLY-*` events.
- **Jupiter's result follows the source market.** Jupiter's user docs: "The market's source or integration determines the result from the published rules" ([source](https://docs.jup.ag/user-docs/trade/predict)). Jupiter's docs do not name UMA. For Polymarket markets the source result is UMA's resolution on Polygon, and the data matches it:

| Polymarket market | Disputes (Polygon) | Resolved on Polygon | Jupiter Predict |
|---|---|---|---|
| [1484949](https://api.predge.io/v1/settlement-risk/1484949) "Netanyahu out by March 31?" | 2, on 1 Apr 2026 (txs `0x9d8446ba...`, `0xfffd18d2...`) | 5 Apr 2026 06:13:09 UTC, No | `POLY-1484949`: closed, result `no`, resolveAt 06:14:32 UTC; result account [`BzM3HV...hYhe`](https://explorer.solana.com/address/BzM3HVUvVByzG3Jb6neiTVzpAxZcJxkXGLLASKWEbYhe) on Solana mainnet |
| [2169995](https://api.predge.io/v1/settlement-risk/2169995) "MicroStrategy sells any Bitcoin by May 31, 2026?" | 2, on 1 Jun 2026 (txs `0xc5e63a78...`, `0xbcbd0d85...`) | 4 Jun 2026 00:34:19 UTC, No | `POLY-2169995`: closed, result `no`, resolveAt 00:35:23 UTC |

In both cases Jupiter marked the market resolved about a minute after UMA's resolution on Polygon, days after the disputes. A Solana user holding these positions waited on a Polygon dispute, and a Solana program had no way to read that state. This repo gives it one.

## Architecture

```
Polygon (UMA / Polymarket)        Predge                              Solana
-----------------------------     ------------------------------      -------------------------------------------
ProposePrice / DisputePrice  -->  scanner + api.predge.io        -->  tx: [Ed25519 verify ix, post_attestation]
QuestionResolved                  signed record (ed25519, JSON)        -> MarketRisk PDA per market
UMA vote (Ethereum)               97-byte attestation                  any program: check_settlement (one CPI)
                                                                       example: vault.release -> CPI -> gate
```

- **`post_attestation`** (permissionless relay). The transaction carries a native Ed25519 signature-verification instruction. The program reads the instructions sysvar and checks that the signature is from the configured attestor key, over exactly the bytes of this attestation. A relayer cannot alter a field. Older observations cannot overwrite newer ones, and a settled market cannot be moved back to disputed.
- **`MarketRisk` PDA** (`["risk", market_key]`): status (`PROPOSED`, `DISPUTED`, `ESCALATED` to a UMA vote, `SETTLED`), dispute count, whether the final outcome differed from the last disputed proposal, a risk score in basis points, settlement time, observation time and the sha256 of the signed off-chain evidence.
- **`check_settlement`**: the gate. Succeeds only if the reference market is settled and past a configurable cooling window. Otherwise it fails with `SettlementNotFinal`, `MarketDisputed`, `MarketEscalated` or `CoolingPeriod`.
- **`open_escrow` / `release_escrow`**: a reference consumer built into the guard program.
- **`programs/example-consumer`**: a separate settlement-vault program that integrates the gate the way a third-party protocol would, through one CPI.

### One-call integration

Add the guard with the `cpi` feature:

```toml
[dependencies]
predge_guard = { git = "https://github.com/predgeAI/predge-solana-guard", features = ["cpi"] }
```

Before your program moves funds on an outcome:

```rust
predge_guard::cpi::check_settlement(CpiContext::new(
    ctx.accounts.predge_guard.to_account_info(),
    predge_guard::cpi::accounts::CheckSettlement {
        config: ctx.accounts.guard_config.to_account_info(),
        market_risk: ctx.accounts.market_risk.to_account_info(),
    },
))?; // reverts with MarketDisputed / MarketEscalated / SettlementNotFinal / CoolingPeriod
```

You add three accounts: the guard's config PDA, the market's `MarketRisk` PDA and the guard program. Bind the risk account to your own market, as the example does with `market_risk.market_key == vault.market_key`. Full example: [`programs/example-consumer/src/lib.rs`](programs/example-consumer/src/lib.rs); tests: [`tests/vault_cpi.ts`](tests/vault_cpi.ts). Off-chain readers can skip CPI and read the `MarketRisk` account directly.

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
| 65 | 32 | evidence_hash = sha256 of the signed off-chain record |

### Risk score (v0, deliberately simple)

- Settled on Polygon: `0`.
- Open dispute (disputed once, or escalated to a vote): `3354` bps, the 2026 base rate (853 of 2,543).
- Proposed, not disputed: `0` in v0; the gate still blocks because the market is not settled.

The score is advisory. The gate itself trusts only status and time.

## From the live API to the gate

`api.predge.io/v1/settlement-risk/<polymarket market id>` returns a settlement-risk record signed with Predge's attestation key (published at [`/.well-known/predge-keys.json`](https://api.predge.io/.well-known/predge-keys.json), pinned in [`scripts/api-record.ts`](scripts/api-record.ts)). [`scripts/api-demo.ts`](scripts/api-demo.ts):

1. fetches the record and verifies the ed25519 signature byte for byte (the re-canonicalised payload must equal the signed `canonical`);
2. replays the resolution path inside the signed record (each dispute, then the current state) as on-chain attestations, with `evidence_hash = sha256(signed record)`;
3. after every step, tries to release a vault that settles on this market (CPI into `check_settlement`). Blocked attempts are sent with preflight off, so each one is a failed transaction on-chain carrying the guard's error code;
4. posts the current signed state under the market's canonical key;
5. prints the same market as Jupiter Predict lists it.

Key note, stated plainly: today the API signs JSON with Predge's API key, while the program verifies the compact 97-byte message against the attestor key in its config. In the demo the relayer checks the API signature off-chain and the configured devnet attestor key signs the compact message; `evidence_hash` ties each on-chain record to exactly one API-signed record. Next step: the API returns the 97-byte message signed directly, so nobody re-signs.

Output for Polymarket 1484949 on a local validator (transaction links omitted):

```
Market    "Netanyahu out by March 31?" (Polymarket 1484949)
signature ed25519 OK, signer 13fa3d18a369e6c7... (pinned Predge attestation key)
state     settled, disputes 2, open_dispute false, resolved true
vault deposit 0.01 SOL (example_consumer 6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg)
2026-04-01T04:06:47Z  DISPUTED              disputes 1  risk 3354 bps
    vault.release (CPI)     BLOCKED MarketDisputed
2026-04-01T04:11:07Z  ESCALATED (UMA vote)  disputes 2  risk 3354 bps
    vault.release (CPI)     BLOCKED MarketEscalated
2026-10-07T11:34:12Z  SETTLED               disputes 2  risk    0 bps
    vault.release (CPI)     ALLOWED
Jupiter Predict: POLY-1484949 (provider polymarket), status closed, result no, resolveAt 2026-04-05T06:14:32.577Z
  Polygon on-chain outcome (signed by Predge): No
```

## Devnet

Status on 7 Oct 2026: **deployment pending, program IDs reserved.** The public devnet faucet rate-limited the deployer (`DiuuxHaMcezcWLUkmnTYUQPwi7tV46aZWHCZabTy9Rhg`), so neither program is on devnet yet. Everything above runs end to end on a local validator today.

| | Program ID | Explorer (devnet) |
|---|---|---|
| Guard | `B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush` | [link](https://explorer.solana.com/address/B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush?cluster=devnet) |
| Example consumer | `6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg` | [link](https://explorer.solana.com/address/6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg?cluster=devnet) |

Once funded (about 2.6 SOL peak for the guard, about 3.3 SOL to deploy both), `./scripts/deploy-devnet.sh` deploys and writes `demo-api-devnet.log` and `demo-devnet.log` with explorer links for every transaction; those links will be listed here.

## Run it

Requirements: Rust, [Agave/Solana CLI](https://docs.anza.xyz/cli/install) 2.x or newer, Anchor CLI 0.32, Node 20.

```bash
npm install
anchor build
anchor test          # local validator: 33 tests (guard program, CPI vault, off-chain checks)
npm run test:unit    # off-chain only: encoding, dataset numbers, signed API record verification
cargo test           # Rust unit tests
npx ts-node scripts/stats.ts   # recomputes 3,005 / 2,666 / 323 / 2,543 / 853
npx ts-node scripts/verify-pack.ts examples/pm-2169995-microstrategy-may31.pack.json
```

Local end-to-end demo with both programs:

```bash
solana-test-validator --reset \
  --bpf-program B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush target/deploy/predge_guard.so \
  --bpf-program 6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg target/deploy/example_consumer.so
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json
npx ts-node scripts/api-demo.ts 1484949   # live signed API record -> attestations -> CPI gate
npx ts-node scripts/demo.ts               # evidence-pack replay, then the open-dispute board
```

Devnet: `./scripts/deploy-devnet.sh` deploys both programs (skips ones already deployed, recovers buffer rent on failure) and runs both demos with explorer links.

## Data

- `data/polymarket-disputes-2026.json`: the 2,666 disputed markets from Predge's on-chain scan (market-level fields and Polygon tx hashes only, no wallet addresses).
- `examples/pm-2169995-microstrategy-may31.pack.json`: a full signed evidence pack for market 2169995 (every proposal, dispute, bulletin-board update, the UMA vote and the final resolution, each with a tx hash). Signed with a throwaway prototype key, stated inside the pack.
- `examples/api-settlement-risk-*.json`: signed API records used by the unit tests.

## Built before vs during the hackathon

Colosseum Crypto World's Fair runs 14 Sep to 12 Oct 2026. The honest split:

**Built before the hackathon and reused here:**
- Predge's Polygon scanner for UMA disputes on Polymarket, and the 2026 dataset.
- The signed evidence-pack format and `api.predge.io` (paid x402 API, accepting USDC on Base and on Solana mainnet), including the signed `/v1/settlement-risk` endpoint.
- Verdict-arbiter contracts on Arc, Arbitrum and Robinhood Chain.

**Built during the hackathon (this repo; see the commit history):**
- The Solana guard program: ed25519 attestation verification through the instructions sysvar, per-market risk PDAs, the `check_settlement` gate, the built-in escrow, tests and the replay demo (first commit, 4 Oct 2026).
- The example consumer vault program and its CPI tests.
- Verification of signed `api.predge.io` records, the live API-to-gate demo and the Jupiter Predict cross-check.
- Devnet deployment tooling and the devnet run.

## Roadmap

1. **Event-perps safety switch.** A perp or prediction-market venue reads `MarketRisk` and goes close-only while the reference market is disputed, freezes liquidations and funding while it is escalated to a vote, and settles only after the cooling window.
2. **Live relayer** posting attestations for every proposal, dispute and resolution as they happen on Polygon.
3. **On-chain format from the API.** `api.predge.io` returns the 97-byte message signed by the published attestation key, so relayers never re-sign.
4. **Bonded attestor on Solana**, matching the bond Predge already runs on other chains; then more venues under the same venue-namespaced key.
5. **Paid feeds** per call in USDC on Solana over x402, the rail Predge's API already runs.

## Trust model and limits

- The attestor key is the trust anchor. The devnet demo uses a locally generated demo key; production would use Predge's published attestation key, rotated through `update_config`.
- v0 covers Polymarket markets resolved through UMA on Polygon. The market key is venue-namespaced so other venues can be added.
- One attestor and no slashing on Solana yet.
- The escrow and the example vault are reference consumers, not audited products.
- This product has no revenue and no paying customers yet.

MIT licensed.
