# Integrate Predge Settlement Guard

Two sides, each about ten lines:

- **Consumer program (Rust).** Before your program moves funds on a Polymarket outcome, one CPI into `check_settlement` reverts unless the market is settled and past the cooling window.
- **Relayer or client (TypeScript, `@predge/solana-guard`).** Fetch and verify the signed record from `api.predge.io`, build the `post_attestation` transaction, derive and read the accounts.

| | Devnet address |
|---|---|
| Guard program | `B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush` |
| Guard config PDA (`["config"]`) | `EDqsV128my3Mugs8BskPuRESrzyNrwUWUwxXkGkcy2zs` |
| Example consumer | `6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg` |
| `MarketRisk` for Polymarket 1484949 (settled) | `DDn4AwFGJTeryNcLqnEqUm6k5kShCNznWCCXbPQNAurG` |
| Devnet attestor (`config.attestor`) | `FZi4ZmNsFN2E4VxXJLks8VUXFRihk97fsAQYYwAhJTyp` |
| Cooling window (`config.cooling_secs`) | 3600 s |

Values read from devnet on 14 Oct 2026. `fetchConfig()` returns the current ones.

## 1. Consumer program (Rust CPI)

`Cargo.toml` (Anchor 0.32):

```toml
predge_guard = { git = "https://github.com/predgeAI/predge-solana-guard", features = ["cpi"] }
```

Accounts and the call:

```rust
use predge_guard::{program::PredgeGuard, Config as GuardConfig, MarketRisk};

// in your #[derive(Accounts)] struct for the instruction that pays out:
pub guard_config: Account<'info, GuardConfig>,
#[account(constraint = market_risk.market_key == my_market.market_key @ MyError::WrongMarket)]
pub market_risk: Account<'info, MarketRisk>,
pub predge_guard: Program<'info, PredgeGuard>,

// in the handler, before any transfer:
predge_guard::cpi::check_settlement(CpiContext::new(
    ctx.accounts.predge_guard.to_account_info(),
    predge_guard::cpi::accounts::CheckSettlement {
        config: ctx.accounts.guard_config.to_account_info(),
        market_risk: ctx.accounts.market_risk.to_account_info(),
    },
))?;
```

What this gives you:

- The CPI fails with `SettlementNotFinal` (6010, only proposed), `MarketDisputed` (6011), `MarketEscalated` (6012, sent to a UMA vote) or `CoolingPeriod` (6013, settled less than `cooling_secs` ago). Your instruction reverts with it.
- `Account<'info, …>` checks that both accounts are owned by the guard program, and `check_settlement` re-checks their PDA seeds. A caller cannot pass a fake config or a record from another program.
- The `constraint` line is your part: bind the risk record to the market your position was opened on (store the 32-byte `market_key` at open time). Without it, a caller could pass the record of a different, already settled market. The example consumer does this with `WrongMarket`.
- If no attestation has been posted for the market yet, the `MarketRisk` account does not exist and Anchor fails with `AccountNotInitialized`, so funds stay locked.

Full example: [`programs/example-consumer/src/lib.rs`](../programs/example-consumer/src/lib.rs). Tests: [`tests/vault_cpi.ts`](../tests/vault_cpi.ts).

The `market_key` is `sha256("polymarket:" + uma_question_id)`, with the UMA question id as lowercase `0x` hex. The API record for a Polymarket market id carries `uma_question_id`; `prepareAttestation(id).marketKey` computes it.

## 2. Client side (TypeScript)

The package is not published to npm yet. Build it from this repo:

```bash
cd sdk && npm install && npm run build && npm pack   # -> predge-solana-guard-0.1.0.tgz
npm install /path/to/predge-solana-guard-0.1.0.tgz   # in your project
```

ESM with type declarations. Peer dependency: `@solana/web3.js` 1.x.

### Call your program with the three guard accounts

```ts
import { getCheckSettlementAccounts, prepareAttestation } from "@predge/solana-guard";

const { marketKey } = await prepareAttestation(1484949); // Polymarket market id -> verified record -> market key
const guard = getCheckSettlementAccounts(marketKey);      // { predgeGuard, guardConfig, marketRisk }

await myProgram.methods
  .release()
  .accountsPartial({ ...accounts, ...guard })             // names match example-consumer's Release
  .rpc();
```

If your account names differ, map them: `guard.guardConfig`, `guard.marketRisk`, `guard.predgeGuard`. Store `marketKey` in your own account when the position is opened.

### Relay an attestation (`post_attestation`)

```ts
import { Connection, sendAndConfirmTransaction } from "@solana/web3.js";
import { buildPostAttestationTransaction, prepareAttestation } from "@predge/solana-guard";

const p = await prepareAttestation(1484949);   // fetch, verify offline, map to the 97-byte attestation
const signature = await signWithAttestor(p.message);   // 64-byte ed25519 signature by config.attestor
const tx = buildPostAttestationTransaction({
  payer: wallet.publicKey,
  attestation: p.attestation,
  signature,
  attestor: attestorPublicKey,
});
await sendAndConfirmTransaction(connection, tx, [wallet]);
```

The transaction is `[Ed25519 verify, post_attestation]`. Only the fee payer signs it; the attestor's signature travels inside the Ed25519 instruction, and the program checks it against `config.attestor` over exactly these 97 bytes. The payer pays rent the first time a market's `MarketRisk` account is created (102 bytes).

Before building, the SDK checks the signature and the program's field rules locally (`check: false` turns this off), so a bad relay fails without a fee.

Read the result:

```ts
import { evaluateGate, fetchConfig, fetchMarketRisk } from "@predge/solana-guard";

const cfg = await fetchConfig(connection);
const risk = await fetchMarketRisk(connection, p.marketKey);           // null if nothing posted yet
evaluateGate(risk, cfg!.coolingSecs, Math.floor(Date.now() / 1000));   // { final: true } or { final: false, error }
```

### Who can sign attestations

There are two keys, and the difference matters for relayers:

1. **API record key** (`13fa3d18…52d9`, role `attestation` in [`/.well-known/predge-keys.json`](https://api.predge.io/.well-known/predge-keys.json), pinned in the SDK as `PREDGE_ATTESTATION_KEY_HEX`). It signs the JSON record. `verifySettlementRecord` checks it offline.
2. **On-chain attestor** (`config.attestor`). It signs the 97-byte message. On devnet this is a Predge devnet key (`FZi4…JTyp`).

Today the API returns the signed JSON, not a signed 97-byte message. Anyone can fetch and verify the record and compute the exact message to sign, but posting needs a signature from `config.attestor`. The 97-byte message carries `evidence_hash = sha256(canonical)`, which ties each on-chain record to exactly one API-signed record. The roadmap item "on-chain format from the API" removes this step: the API will return the 97-byte message signed by the published key, and then any relayer can post it with `buildPostAttestationTransaction` unchanged.

For your own deployment or a local validator, initialise the guard with your own attestor and sign with `signAttestation(attestation, secretKey)`.

### Verify a record offline

```ts
import { fetchSettlementRisk, verifySettlementRecord } from "@predge/solana-guard";

const record = await fetchSettlementRisk(1484949);
const v = verifySettlementRecord(record); // throws unless every check below passes
```

Checks, in order:

- `algorithm` is `ed25519`;
- `public_key` is a trusted key (default: the pinned key), and `kid` is its prefix;
- `payload` re-canonicalises to exactly `canonical` (keys sorted at every level, no whitespace);
- `sha256(canonical) == content_hash`;
- `signature` verifies over the UTF-8 bytes of `canonical`;
- `envelope_signature`, when present, verifies over the canonical envelope without that field.

Records saved before the API added `content_hash` (the files in `examples/`) need `{ requireContentHash: false }`. To follow a key rotation announced in the keys document, pass `trustedKeys: attestationKeysFrom(await fetchPredgeKeys())`. Keep the pinned key as the default: a key fetched over the network is only as trustworthy as that fetch.

`attestationFromRecord(v)` maps the record to the attestation: resolved on chain gives `SETTLED`; an open dispute gives `ESCALATED` (sent to a vote or disputed twice) or `DISPUTED`, with risk 3354 bps; a pending proposal gives `PROPOSED`. The record does not carry the resolution time. Pass `{ settledAt }` if you have it; otherwise `checked_at` is used, which is never earlier than the real resolution, so the cooling window is never shorter than configured.

## Byte layouts

All layouts match the program byte for byte; `sdk/test` checks them against the Rust test vector, `scripts/lib.ts` (all 2,666 dataset rows), Anchor's coder for the IDL, and account data read from devnet.

| Item | Layout |
|---|---|
| Attestation message (97 bytes) | `"PREDGE-SR-v1"` · market_key 32 · status u8 · dispute_count u8 · settled_differently u8 · risk_bps u16 LE · settled_at i64 LE · observed_at i64 LE · evidence_hash 32 |
| `post_attestation` data | discriminator `0c4bff533bab8d1b` · message bytes 12..97 (the Borsh `Attestation`) |
| `post_attestation` accounts | payer (signer, writable) · config · market_risk (writable) · instructions sysvar · system program |
| `check_settlement` | discriminator `0968419d84d3ff07` · accounts: config, market_risk |
| `MarketRisk` account (102 bytes) | discriminator 8 · market_key 32 · status · dispute_count · settled_differently · risk_bps u16 · settled_at i64 · observed_at i64 · evidence_hash 32 · updated_slot u64 · bump |
| Ed25519 instruction | one signature, all offsets inside the instruction (instruction indices `u16::MAX`), immediately before `post_attestation` |

## Tests

```bash
cd sdk && npm install
npm test                 # unit tests: encoding, PDAs, decoding, instructions, record verification
npm run test:devnet      # read-only against devnet and the live API (network; simulates, sends nothing)
npm run test:localnet    # end-to-end relay on a local validator with both programs loaded
```

The cross-checks against `scripts/` need `npm install` at the repo root as well; without it they are skipped. `test:localnet` needs `solana-test-validator` with both programs loaded (see the comment at the top of `sdk/test/localnet.test.ts`) and is skipped unless `PREDGE_SDK_LOCALNET=1`.
