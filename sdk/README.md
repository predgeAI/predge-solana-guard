# @predge/solana-guard

TypeScript client for Predge Settlement Guard on Solana (program `B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush`, devnet).

- `fetchSettlementRisk(marketId)` and `verifySettlementRecord(record)`: signed record from `api.predge.io`, verified offline (pinned key, `content_hash`, ed25519 signature, envelope signature).
- `attestationFromRecord`, `encodeAttestationMessage`, `signAttestation`: the 97-byte attestation.
- `buildPostAttestationTransaction`: `[Ed25519 verify, post_attestation]`, the permissionless relay.
- `findConfigPda`, `findMarketRiskPda`, `fetchConfig`, `fetchMarketRisk`, `decodeMarketRisk`, `evaluateGate`.
- `getCheckSettlementAccounts(marketKey)`: the three accounts for the `check_settlement` CPI.
- `prepareAttestation(marketId)`: fetch, verify and map in one call.
- `parseGuardError(logsOrError)`: guard error name and code from transaction logs.

ESM with type declarations; peer dependency `@solana/web3.js` 1.x. Not published to npm yet; build with `npm install && npm run build`.

Guide: [docs/INTEGRATE.md](../docs/INTEGRATE.md). Tests: `npm test` (unit), `npm run test:devnet` (read-only, network), `npm run test:localnet` (local validator).

MIT licensed.
