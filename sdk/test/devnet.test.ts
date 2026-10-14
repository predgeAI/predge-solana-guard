// Read-only checks against the deployed devnet programs and the live API.
// Nothing is sent: transactions are simulated with sigVerify off, so no key
// or SOL is needed. Skipped unless PREDGE_SDK_DEVNET=1 (needs network).
//
//   PREDGE_SDK_DEVNET=1 npx vitest run test/devnet.test.ts
//   SOLANA_RPC_URL=<your devnet RPC>   (optional, default https://api.devnet.solana.com)
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  PREDGE_ATTESTATION_KEY_HEX,
  Status,
  attestationKeysFrom,
  createCheckSettlementInstruction,
  createPostAttestationInstructions,
  evaluateGate,
  fetchConfig,
  fetchMarketRisk,
  fetchPredgeKeys,
  parseGuardError,
  prepareAttestation,
  sha256,
  signAttestation,
} from "../src/index.js";
import { hex } from "./helpers.js";

const RUN = process.env.PREDGE_SDK_DEVNET === "1";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

describe.skipIf(!RUN)("devnet (read-only, PREDGE_SDK_DEVNET=1)", () => {
  const connection = new Connection(RPC, "confirmed");

  async function simulate(feePayer: PublicKey, ixs: TransactionInstruction[]) {
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const res = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    return res.value;
  }

  it("reads the guard config", async () => {
    const cfg = await fetchConfig(connection);
    expect(cfg).not.toBeNull();
    expect(cfg!.coolingSecs).toBeGreaterThanOrEqual(0);
  });

  it("the live API record, verified offline, agrees with the on-chain record for Polymarket 1484949", async () => {
    const p = await prepareAttestation(1484949);
    expect(p.verified.contentHashChecked).toBe(true);
    const risk = await fetchMarketRisk(connection, p.marketKey);
    expect(risk).not.toBeNull();
    expect(hex(risk!.marketKey)).toBe(hex(p.marketKey));
    expect(risk!.status).toBe(p.attestation.status);
    expect(risk!.status).toBe(Status.SETTLED);
    expect(risk!.disputeCount).toBe(p.attestation.disputeCount);
  });

  it("the published keys document lists the pinned key", async () => {
    expect(attestationKeysFrom(await fetchPredgeKeys())).toContain(PREDGE_ATTESTATION_KEY_HEX);
  });

  it("check_settlement passes for a settled market past the cooling window (simulated)", async () => {
    const cfg = (await fetchConfig(connection))!;
    const p = await prepareAttestation(1484949);
    const risk = (await fetchMarketRisk(connection, p.marketKey))!;
    expect(evaluateGate(risk, cfg.coolingSecs, Math.floor(Date.now() / 1000))).toEqual({ final: true });
    const sim = await simulate(cfg.admin, [createCheckSettlementInstruction({ marketKey: p.marketKey })]);
    expect(sim.err).toBeNull();
  });

  it("the deployed program parses the SDK's relay transaction and rejects a non-attestor signature (simulated)", async () => {
    const cfg = (await fetchConfig(connection))!;
    const attestation = {
      marketKey: sha256(`sdk-devnet-sim:${Date.now()}`),
      status: Status.DISPUTED,
      disputeCount: 1,
      settledDifferently: 0,
      riskBps: 3354,
      settledAt: 0,
      observedAt: Math.floor(Date.now() / 1000) - 60,
      evidenceHash: sha256("sdk-devnet-sim"),
    };
    const s = signAttestation(attestation, sha256("not-the-attestor"));
    const ixs = createPostAttestationInstructions({ payer: cfg.admin, attestation, signature: s.signature, attestor: s.attestor });
    const sim = await simulate(cfg.admin, ixs);
    // Reaching WrongAttestor means the discriminator, Borsh argument, accounts
    // and Ed25519 instruction were all accepted and the program compared keys.
    expect(parseGuardError(sim.logs)).toEqual({ code: 6008, name: "WrongAttestor" });
  });
});
