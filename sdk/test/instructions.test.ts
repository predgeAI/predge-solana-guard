import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { ed25519 } from "@noble/curves/ed25519";
import { Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  Attestation,
  DISCRIMINATORS,
  PREDGE_GUARD_PROGRAM_ID,
  Status,
  buildPostAttestationTransaction,
  createCheckSettlementInstruction,
  createEd25519VerifyInstruction,
  createPostAttestationInstruction,
  encodeAttestationMessage,
  findConfigPda,
  findMarketRiskPda,
  sha256,
  signAttestation,
} from "../src/index.js";
import { hex, readJson } from "./helpers.js";

const idl = readJson("target/idl/predge_guard.json");
const coder = new BorshInstructionCoder(idl);
const payer = Keypair.fromSeed(sha256("sdk-test-payer")).publicKey;
const attestorSeed = sha256("sdk-test-attestor");
const now = Math.floor(Date.now() / 1000);

const att: Attestation = {
  marketKey: sha256("polymarket:0x0382b71b4df8e161d7947966fef8e5f6cc2d29b0285f87761e569b043e68f83d"),
  status: Status.ESCALATED,
  disputeCount: 2,
  settledDifferently: 0,
  riskBps: 3354,
  settledAt: 0,
  observedAt: now - 60,
  evidenceHash: sha256("evidence"),
};

/**
 * Port of `verify_ed25519_ix` in lib.rs. Returns the error name the program
 * would raise, or "ok".
 */
function guardAcceptsEd25519Ix(ix: TransactionInstruction, expectedPk: Uint8Array, expectedMsg: Uint8Array): string {
  if (!ix.programId.equals(Ed25519Program.programId)) return "MissingEd25519Ix";
  if (ix.keys.length !== 0) return "BadEd25519Ix";
  const d = ix.data;
  if (d.length < 16 || d[0] !== 1) return "BadEd25519Ix";
  const rd = (i: number) => d.readUInt16LE(i);
  const [sigOff, sigIx, pkOff, pkIx, msgOff, msgLen, msgIx] = [rd(2), rd(4), rd(6), rd(8), rd(10), rd(12), rd(14)];
  if (sigIx !== 0xffff || pkIx !== 0xffff || msgIx !== 0xffff) return "BadEd25519Ix";
  if (sigOff + 64 > d.length || pkOff + 32 > d.length || msgOff + msgLen > d.length) return "BadEd25519Ix";
  if (hex(d.subarray(pkOff, pkOff + 32)) !== hex(expectedPk)) return "WrongAttestor";
  if (hex(d.subarray(msgOff, msgOff + msgLen)) !== hex(expectedMsg)) return "MessageMismatch";
  // The native program itself checks the signature; check it here too.
  if (!ed25519.verify(d.subarray(sigOff, sigOff + 64), d.subarray(msgOff, msgOff + msgLen), d.subarray(pkOff, pkOff + 32))) return "SignatureInvalid";
  return "ok";
}

describe("Ed25519 verify instruction", () => {
  it("has the shape verify_ed25519_ix requires", () => {
    const s = signAttestation(att, attestorSeed);
    const ix = createEd25519VerifyInstruction({ attestor: s.attestor, message: s.message, signature: s.signature });
    expect(guardAcceptsEd25519Ix(ix, s.attestor, encodeAttestationMessage(att))).toBe("ok");
    expect(ix.data.length).toBe(16 + 32 + 64 + 97);
  });

  it("accepts the attestor as a PublicKey", () => {
    const s = signAttestation(att, attestorSeed);
    const ix = createEd25519VerifyInstruction({ attestor: new PublicKey(s.attestor), message: s.message, signature: s.signature });
    expect(guardAcceptsEd25519Ix(ix, s.attestor, s.message)).toBe("ok");
  });
});

describe("post_attestation instruction", () => {
  it("matches the IDL: discriminator, Borsh args, account order and flags", () => {
    const ix = createPostAttestationInstruction({ payer, attestation: att });
    expect(ix.programId.equals(PREDGE_GUARD_PROGRAM_ID)).toBe(true);

    const anchorData = coder.encode("post_attestation", {
      att: {
        market_key: Array.from(att.marketKey),
        status: att.status,
        dispute_count: att.disputeCount,
        settled_differently: att.settledDifferently,
        risk_bps: att.riskBps,
        settled_at: new BN(att.settledAt),
        observed_at: new BN(att.observedAt),
        evidence_hash: Array.from(att.evidenceHash),
      },
    });
    expect(hex(ix.data)).toBe(anchorData.toString("hex"));
    expect(hex(ix.data.subarray(0, 8))).toBe(hex(DISCRIMINATORS.postAttestation));
    // The argument is the signed message without its 12-byte domain.
    expect(hex(ix.data.subarray(8))).toBe(hex(encodeAttestationMessage(att).subarray(12)));

    const idlIx = idl.instructions.find((i: any) => i.name === "post_attestation");
    expect(ix.keys.length).toBe(idlIx.accounts.length);
    idlIx.accounts.forEach((a: any, i: number) => {
      expect(ix.keys[i].isSigner).toBe(!!a.signer);
      expect(ix.keys[i].isWritable).toBe(!!a.writable);
      if (a.address) expect(ix.keys[i].pubkey.toBase58()).toBe(a.address);
    });
    expect(ix.keys[0].pubkey.equals(payer)).toBe(true);
    expect(ix.keys[1].pubkey.equals(findConfigPda()[0])).toBe(true);
    expect(ix.keys[2].pubkey.equals(findMarketRiskPda(att.marketKey)[0])).toBe(true);
    expect(ix.keys[3].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)).toBe(true);
    expect(ix.keys[4].pubkey.equals(SystemProgram.programId)).toBe(true);
  });
});

describe("relay transaction", () => {
  it("is [Ed25519 verify, post_attestation] with only the payer as signer", () => {
    const s = signAttestation(att, attestorSeed);
    const tx = buildPostAttestationTransaction({ payer, attestation: att, signature: s.signature, attestor: s.attestor });
    expect(tx.instructions.length).toBe(2);
    expect(tx.instructions[0].programId.equals(Ed25519Program.programId)).toBe(true);
    expect(tx.instructions[1].programId.equals(PREDGE_GUARD_PROGRAM_ID)).toBe(true);
    expect(guardAcceptsEd25519Ix(tx.instructions[0], s.attestor, encodeAttestationMessage(att))).toBe("ok");
    expect(tx.feePayer?.equals(payer)).toBe(true);
    const signers = tx.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()));
    expect(new Set(signers)).toEqual(new Set([payer.toBase58()]));
  });

  it("refuses to build when the signature does not match", () => {
    const s = signAttestation(att, attestorSeed);
    expect(() =>
      buildPostAttestationTransaction({ payer, attestation: { ...att, riskBps: 0 }, signature: s.signature, attestor: s.attestor })
    ).toThrow(/signature/);
  });

  it("refuses to build an attestation the program would reject", () => {
    const bad = { ...att, observedAt: now + 3600 };
    const s = signAttestation(bad, attestorSeed);
    expect(() => buildPostAttestationTransaction({ payer, attestation: bad, signature: s.signature, attestor: s.attestor })).toThrow(
      /FutureAttestation/
    );
    // check: false skips local checks (e.g. to reproduce an on-chain error).
    expect(
      buildPostAttestationTransaction({ payer, attestation: bad, signature: s.signature, attestor: s.attestor, check: false }).instructions.length
    ).toBe(2);
  });
});

describe("check_settlement instruction", () => {
  it("matches the IDL", () => {
    const ix = createCheckSettlementInstruction({ marketKey: att.marketKey });
    expect(ix.data.toString("hex")).toBe(coder.encode("check_settlement", {}).toString("hex"));
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [findConfigPda()[0].toBase58(), false, false],
      [findMarketRiskPda(att.marketKey)[0].toBase58(), false, false],
    ]);
  });
});
