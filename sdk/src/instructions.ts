// Instruction and transaction builders. No Anchor dependency: data and
// account order follow target/idl/predge_guard.json.
import { Buffer } from "buffer";
import {
  AccountMeta,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Attestation, attestationProblems, encodeAttestationArg, encodeAttestationMessage, verifyAttestationSignature } from "./attestation.js";
import { DISCRIMINATORS, PREDGE_GUARD_PROGRAM_ID } from "./constants.js";
import { expectLength } from "./bytes.js";
import { findConfigPda, findMarketRiskPda } from "./pda.js";

/**
 * Native Ed25519 verify instruction for one attestation, in the shape the
 * guard requires: one signature, all data inline (instruction indices
 * u16::MAX). Must be placed immediately before `post_attestation`.
 */
export function createEd25519VerifyInstruction(params: {
  attestor: Uint8Array | PublicKey;
  message: Uint8Array;
  signature: Uint8Array;
}): TransactionInstruction {
  const attestor = params.attestor instanceof PublicKey ? params.attestor.toBytes() : params.attestor;
  expectLength(attestor, 32, "attestor public key");
  expectLength(params.signature, 64, "signature");
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: attestor,
    message: params.message,
    signature: params.signature,
  });
}

/** `post_attestation` instruction (without the Ed25519 instruction it needs in front). */
export function createPostAttestationInstruction(params: {
  payer: PublicKey;
  attestation: Attestation;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? PREDGE_GUARD_PROGRAM_ID;
  const keys: AccountMeta[] = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: findConfigPda(programId)[0], isSigner: false, isWritable: false },
    { pubkey: findMarketRiskPda(params.attestation.marketKey, programId)[0], isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([Buffer.from(DISCRIMINATORS.postAttestation), Buffer.from(encodeAttestationArg(params.attestation))]);
  return new TransactionInstruction({ programId, keys, data });
}

export interface PostAttestationParams {
  /** Fee payer; also pays rent the first time a market's record is created. */
  payer: PublicKey;
  attestation: Attestation;
  /** 64-byte ed25519 signature by the attestor over the 97-byte message. */
  signature: Uint8Array;
  /** The attestor public key that produced `signature` (must equal config.attestor on-chain). */
  attestor: Uint8Array | PublicKey;
  programId?: PublicKey;
  /**
   * Check the fields and the signature locally before building, so an
   * invalid relay fails here instead of costing a transaction fee. Default true.
   */
  check?: boolean;
}

/** The two instructions of a relay, in order: [Ed25519 verify, post_attestation]. */
export function createPostAttestationInstructions(p: PostAttestationParams): TransactionInstruction[] {
  const attestor = p.attestor instanceof PublicKey ? p.attestor.toBytes() : p.attestor;
  if (p.check !== false) {
    const problems = attestationProblems(p.attestation, Math.floor(Date.now() / 1000));
    if (problems.length) throw new Error(`attestation would be rejected: ${problems.join("; ")}`);
    if (!verifyAttestationSignature(p.attestation, p.signature, attestor)) {
      throw new Error("signature does not verify for this attestation and attestor");
    }
  }
  return [
    createEd25519VerifyInstruction({ attestor, message: encodeAttestationMessage(p.attestation), signature: p.signature }),
    createPostAttestationInstruction({ payer: p.payer, attestation: p.attestation, programId: p.programId }),
  ];
}

/**
 * Permissionless relay transaction: [Ed25519 verify, post_attestation].
 * Set `recentBlockhash` (or let your wallet adapter do it) and sign with `payer`.
 * Nothing else needs to sign: the attestor's signature is inside the Ed25519 instruction.
 */
export function buildPostAttestationTransaction(p: PostAttestationParams): Transaction {
  const tx = new Transaction();
  tx.feePayer = p.payer;
  return tx.add(...createPostAttestationInstructions(p));
}

/** Top-level `check_settlement` instruction, e.g. to simulate the gate from a client. */
export function createCheckSettlementInstruction(params: { marketKey: Uint8Array; programId?: PublicKey }): TransactionInstruction {
  const programId = params.programId ?? PREDGE_GUARD_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: findConfigPda(programId)[0], isSigner: false, isWritable: false },
      { pubkey: findMarketRiskPda(params.marketKey, programId)[0], isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.checkSettlement),
  });
}
