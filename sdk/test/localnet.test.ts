// End-to-end relay through the SDK on a local validator. Skipped unless
// PREDGE_SDK_LOCALNET=1. Needs both programs loaded at their IDs:
//
//   anchor build
//   solana-test-validator --reset \
//     --bpf-program B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush target/deploy/predge_guard.so \
//     --bpf-program 6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg target/deploy/example_consumer.so
//   PREDGE_SDK_LOCALNET=1 ANCHOR_WALLET=~/.config/solana/id.json npx vitest run test/localnet.test.ts
//
// The wallet must be the config admin, or the config must not exist yet: the
// test points the attestor at a fresh key of its own (as tests/vault_cpi.ts does).
import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { ed25519 } from "@noble/curves/ed25519";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Attestation,
  OPEN_DISPUTE_RISK_BPS,
  PREDGE_GUARD_PROGRAM_ID,
  Status,
  buildPostAttestationTransaction,
  createCheckSettlementInstruction,
  createEd25519VerifyInstruction,
  createPostAttestationInstruction,
  encodeAttestationMessage,
  fetchConfig,
  fetchMarketRisk,
  findConfigPda,
  parseGuardError,
  sha256,
  signAttestation,
} from "../src/index.js";
import { hex, readJson } from "./helpers.js";

const RUN = process.env.PREDGE_SDK_LOCALNET === "1";
const RPC = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const WALLET = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, homedir());
const COOLING_SECS = 3600;

describe.skipIf(!RUN)("localnet end-to-end (PREDGE_SDK_LOCALNET=1)", () => {
  const connection = new Connection(RPC, "confirmed");
  const coder = new BorshInstructionCoder(readJson("target/idl/predge_guard.json"));
  const attestorSeed = sha256(`sdk-localnet-attestor:${Date.now()}`);
  const attestorPk = new PublicKey(ed25519.getPublicKey(attestorSeed));
  const marketKey = sha256(`sdk-localnet:${Date.now()}`);
  const t0 = Math.floor(Date.now() / 1000) - 7 * 86400;
  let payer: Keypair;

  const att = (over: Partial<Attestation>): Attestation => ({
    marketKey,
    status: Status.PROPOSED,
    disputeCount: 0,
    settledDifferently: 0,
    riskBps: 0,
    settledAt: 0,
    observedAt: t0,
    evidenceHash: sha256("sdk-localnet-evidence"),
    ...over,
  });

  const send = (tx: Transaction) => sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  const relay = (a: Attestation) => {
    const s = signAttestation(a, attestorSeed);
    return send(buildPostAttestationTransaction({ payer: payer.publicKey, attestation: a, signature: s.signature, attestor: s.attestor }));
  };
  async function gate(): Promise<string> {
    try {
      await send(new Transaction().add(createCheckSettlementInstruction({ marketKey })));
      return "OK";
    } catch (e) {
      return parseGuardError(e)?.name ?? String(e);
    }
  }
  async function expectGuardError(p: Promise<unknown>, name: string) {
    let err: unknown = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(parseGuardError(err)?.name).toBe(name);
  }

  beforeAll(async () => {
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET, "utf8"))));
    const config = findConfigPda()[0];
    const existing = await fetchConfig(connection);
    const ix = existing
      ? new TransactionInstruction({
          programId: PREDGE_GUARD_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: config, isSigner: false, isWritable: true },
          ],
          data: coder.encode("update_config", { attestor: attestorPk, cooling_secs: new BN(COOLING_SECS) }),
        })
      : new TransactionInstruction({
          programId: PREDGE_GUARD_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: config, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: coder.encode("initialize", { attestor: attestorPk, cooling_secs: new BN(COOLING_SECS) }),
        });
    await send(new Transaction().add(ix));
    expect((await fetchConfig(connection))!.attestor.equals(attestorPk)).toBe(true);
  });

  it("relays a signed attestation and reads it back", async () => {
    await relay(att({}));
    const r = await fetchMarketRisk(connection, marketKey);
    expect(r!.status).toBe(Status.PROPOSED);
    expect(hex(r!.evidenceHash)).toBe(hex(sha256("sdk-localnet-evidence")));
    expect(await gate()).toBe("SettlementNotFinal");
  });

  it("gate follows DISPUTED -> ESCALATED -> SETTLED", async () => {
    await relay(att({ status: Status.DISPUTED, disputeCount: 1, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: t0 + 10 }));
    expect(await gate()).toBe("MarketDisputed");
    await relay(att({ status: Status.ESCALATED, disputeCount: 2, riskBps: OPEN_DISPUTE_RISK_BPS, observedAt: t0 + 20 }));
    expect(await gate()).toBe("MarketEscalated");
    await relay(att({ status: Status.SETTLED, disputeCount: 2, settledAt: t0 + 30, observedAt: t0 + 40 }));
    expect(await gate()).toBe("OK");
  });

  it("rejects replays, foreign signers and mismatched arguments", async () => {
    // Same observed_at as the stored record (different evidence, so it is not a duplicate transaction).
    await expectGuardError(
      relay(att({ status: Status.SETTLED, disputeCount: 2, settledAt: t0 + 30, observedAt: t0 + 40, evidenceHash: sha256("replay") })),
      "StaleAttestation"
    );

    const later = att({ status: Status.SETTLED, disputeCount: 2, settledAt: t0 + 30, observedAt: t0 + 50 });
    const foreign = signAttestation(later, sha256("someone-else"));
    await expectGuardError(
      send(buildPostAttestationTransaction({ payer: payer.publicKey, attestation: later, signature: foreign.signature, attestor: foreign.attestor })),
      "WrongAttestor"
    );

    const signed = signAttestation(later, attestorSeed);
    const tampered = { ...later, riskBps: 1 };
    await expectGuardError(
      send(
        new Transaction().add(
          createEd25519VerifyInstruction({ attestor: signed.attestor, message: encodeAttestationMessage(later), signature: signed.signature }),
          createPostAttestationInstruction({ payer: payer.publicKey, attestation: tampered })
        )
      ),
      "MessageMismatch"
    );
  });
});
