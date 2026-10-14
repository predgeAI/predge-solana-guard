// Decoders for the guard's accounts. Layouts follow the Anchor structs in
// programs/predge_guard/src/lib.rs (8-byte discriminator, then Borsh fields).
import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { DISCRIMINATORS, PREDGE_GUARD_PROGRAM_ID, Status } from "./constants.js";
import { bytesEqual } from "./bytes.js";
import { findConfigPda, findMarketRiskPda } from "./pda.js";

/** `Config` account: 8 + 32 + 32 + 8 + 1 = 81 bytes. */
export const CONFIG_ACCOUNT_LEN = 81;
/** `MarketRisk` account: 8 + 32 + 1 + 1 + 1 + 2 + 8 + 8 + 32 + 8 + 1 = 102 bytes. */
export const MARKET_RISK_ACCOUNT_LEN = 102;

export interface GuardConfig {
  admin: PublicKey;
  attestor: PublicKey;
  coolingSecs: number;
  bump: number;
}

export interface MarketRisk {
  marketKey: Uint8Array;
  status: number;
  disputeCount: number;
  settledDifferently: number;
  riskBps: number;
  settledAt: number;
  observedAt: number;
  evidenceHash: Uint8Array;
  updatedSlot: bigint;
  bump: number;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function checkHeader(data: Uint8Array, disc: Uint8Array, len: number, what: string): void {
  if (data.length < len) throw new Error(`${what}: expected at least ${len} bytes, got ${data.length}`);
  if (!bytesEqual(data.subarray(0, 8), disc)) throw new Error(`${what}: wrong account discriminator`);
}

export function decodeConfig(data: Uint8Array): GuardConfig {
  checkHeader(data, DISCRIMINATORS.configAccount, CONFIG_ACCOUNT_LEN, "Config");
  return {
    admin: new PublicKey(data.slice(8, 40)),
    attestor: new PublicKey(data.slice(40, 72)),
    coolingSecs: Number(view(data).getBigInt64(72, true)),
    bump: data[80],
  };
}

export function decodeMarketRisk(data: Uint8Array): MarketRisk {
  checkHeader(data, DISCRIMINATORS.marketRiskAccount, MARKET_RISK_ACCOUNT_LEN, "MarketRisk");
  const dv = view(data);
  return {
    marketKey: data.slice(8, 40),
    status: data[40],
    disputeCount: data[41],
    settledDifferently: data[42],
    riskBps: dv.getUint16(43, true),
    settledAt: Number(dv.getBigInt64(45, true)),
    observedAt: Number(dv.getBigInt64(53, true)),
    evidenceHash: data.slice(61, 93),
    updatedSlot: dv.getBigUint64(93, true),
    bump: data[101],
  };
}

function checkOwner(owner: PublicKey, programId: PublicKey, what: string): void {
  if (!owner.equals(programId)) throw new Error(`${what} is owned by ${owner.toBase58()}, expected ${programId.toBase58()}`);
}

/** Read the guard config. Returns null if it does not exist. */
export async function fetchConfig(
  connection: Connection,
  opts: { programId?: PublicKey; commitment?: Commitment } = {}
): Promise<GuardConfig | null> {
  const programId = opts.programId ?? PREDGE_GUARD_PROGRAM_ID;
  const info = await connection.getAccountInfo(findConfigPda(programId)[0], opts.commitment);
  if (!info) return null;
  checkOwner(info.owner, programId, "Config");
  return decodeConfig(info.data);
}

/** Read a market's MarketRisk record. Returns null if nothing has been posted for it yet. */
export async function fetchMarketRisk(
  connection: Connection,
  marketKey: Uint8Array,
  opts: { programId?: PublicKey; commitment?: Commitment } = {}
): Promise<MarketRisk | null> {
  const programId = opts.programId ?? PREDGE_GUARD_PROGRAM_ID;
  const info = await connection.getAccountInfo(findMarketRiskPda(marketKey, programId)[0], opts.commitment);
  if (!info) return null;
  checkOwner(info.owner, programId, "MarketRisk");
  const risk = decodeMarketRisk(info.data);
  if (!bytesEqual(risk.marketKey, marketKey)) throw new Error("MarketRisk market_key does not match the requested key");
  return risk;
}

export type GateError = "SettlementNotFinal" | "MarketDisputed" | "MarketEscalated" | "CoolingPeriod";
export type GateResult = { final: true } | { final: false; error: GateError };

/**
 * Off-chain mirror of `assert_final` in lib.rs: what `check_settlement`
 * would return for this record at `nowUnix`. Pass `null` for a market with
 * no record (the CPI then fails on the missing account).
 */
export function evaluateGate(risk: Pick<MarketRisk, "status" | "settledAt"> | null, coolingSecs: number, nowUnix: number): GateResult {
  if (!risk) return { final: false, error: "SettlementNotFinal" };
  switch (risk.status) {
    case Status.SETTLED:
      return nowUnix >= risk.settledAt + coolingSecs ? { final: true } : { final: false, error: "CoolingPeriod" };
    case Status.DISPUTED:
      return { final: false, error: "MarketDisputed" };
    case Status.ESCALATED:
      return { final: false, error: "MarketEscalated" };
    default:
      return { final: false, error: "SettlementNotFinal" };
  }
}
