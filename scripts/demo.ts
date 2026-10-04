// End-to-end demo against a running cluster (localnet or devnet).
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/predge-devnet.json \
//   npx ts-node scripts/demo.ts
//
// 1. Initializes the guard config (or reuses it) with the demo attestor key.
// 2. Replays the real resolution path of Polymarket market 2169995
//    ("MicroStrategy sells any Bitcoin by May 31, 2026?") as signed
//    attestations, with an escrow that tries to release after every step.
// 3. Publishes attestations for the markets that were still open (disputed,
//    not settled) at the end of Predge's 2026 scan, then reads the board back.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import nacl from "tweetnacl";
import idl from "../target/idl/predge_guard.json";
import { PredgeGuard } from "../target/types/predge_guard";
import {
  Attestation,
  DisputeRecord,
  OPEN_DISPUTE_RISK_BPS,
  STATUS_NAME,
  Status,
  attestationFromRecord,
  ed25519Ix,
  pda,
  polymarketKey,
  recordEvidenceHash,
  sha256,
  signAttestation,
  toAnchorArg,
  toUnix,
} from "./lib";

const COOLING_SECS = Number(process.env.COOLING_SECS ?? 3600);
const OPEN_LIMIT = Number(process.env.OPEN_LIMIT ?? 5);
const SCAN_END = toUnix("2026-10-02T22:29:00Z");

function loadAttestor(): nacl.SignKeyPair {
  const path = process.env.ATTESTOR_KEY ?? "keys/attestor-dev.json";
  if (!existsSync(path)) {
    mkdirSync("keys", { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.log(`generated demo attestor key at ${path} (devnet demo key, not Predge's production key)`);
  }
  return nacl.sign.keyPair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program<PredgeGuard>(idl as any, provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const cluster = conn.rpcEndpoint.includes("devnet") ? "devnet" : "custom&customUrl=" + encodeURIComponent(conn.rpcEndpoint);
  const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;

  const attestor = loadAttestor();
  const attestorPk = new PublicKey(attestor.publicKey);
  const configPda = pda(program.programId, Buffer.from("config"));
  const riskPda = (k: Buffer) => pda(program.programId, Buffer.from("risk"), k);

  console.log(`program   ${program.programId.toBase58()}`);
  console.log(`payer     ${payer.publicKey.toBase58()}  (${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL)`);
  console.log(`attestor  ${attestorPk.toBase58()}`);

  // 1. Config
  const cfgInfo = await conn.getAccountInfo(configPda);
  if (!cfgInfo) {
    const sig = await program.methods
      .initialize(attestorPk, new anchor.BN(COOLING_SECS))
      .accountsPartial({ admin: payer.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`initialize            ${link(sig)}`);
  } else {
    const cfg = await program.account.config.fetch(configPda);
    if (!cfg.attestor.equals(attestorPk) && cfg.admin.equals(payer.publicKey)) {
      const sig = await program.methods
        .updateConfig(attestorPk, new anchor.BN(COOLING_SECS))
        .accountsPartial({ admin: payer.publicKey, config: configPda })
        .rpc();
      console.log(`update_config         ${link(sig)}`);
    }
  }

  async function post(a: Attestation): Promise<string> {
    const signed = signAttestation(a, attestor.secretKey);
    const ix = await program.methods
      .postAttestation(toAnchorArg(a) as any)
      .accountsPartial({
        payer: payer.publicKey,
        config: configPda,
        marketRisk: riskPda(a.marketKey),
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return provider.sendAndConfirm(new Transaction().add(ed25519Ix(signed), ix));
  }

  // 2. Replay of a real market. A run-specific key keeps the replay
  //    repeatable; the canonical key for this market is used in step 3.
  const rows: DisputeRecord[] = JSON.parse(readFileSync("data/polymarket-disputes-2026.json", "utf8"));
  const strategy = rows.find((r) => r.market_id === "2169995")!;
  const runId = Date.now();
  const replayKey = sha256(`replay:${runId}:polymarket:${strategy.question_id}`);
  const pack = JSON.parse(readFileSync("examples/pm-2169995-microstrategy-may31.pack.json", "utf8"));
  const evidence = Buffer.from(pack.content_hash, "hex");

  console.log(`\nReplay: "${strategy.title}" (Polymarket ${strategy.market_id})`);
  console.log(`evidence pack sha256 ${pack.content_hash}`);

  const beneficiary = Keypair.generate().publicKey;
  const escrowId = new anchor.BN(runId);
  const escrowPda = pda(program.programId, Buffer.from("escrow"), payer.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8));
  const amount = Number(process.env.ESCROW_LAMPORTS ?? 0.01 * LAMPORTS_PER_SOL);
  const openSig = await program.methods
    .openEscrow(escrowId, Array.from(replayKey), new anchor.BN(amount))
    .accountsPartial({ depositor: payer.publicKey, beneficiary, escrow: escrowPda, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`open_escrow ${amount / LAMPORTS_PER_SOL} SOL  ${link(openSig)}`);

  const tryRelease = async () => {
    try {
      const sig = await program.methods
        .releaseEscrow()
        .accountsPartial({ caller: payer.publicKey, config: configPda, marketRisk: riskPda(replayKey), escrow: escrowPda, beneficiary })
        .rpc();
      return `RELEASED  ${link(sig)}`;
    } catch (e: any) {
      const code = e?.error?.errorCode?.code ?? String(e?.message ?? e).match(/Error Code: (\w+)/)?.[1] ?? "error";
      return `blocked: ${code}`;
    }
  };

  const settledAt = toUnix(strategy.resolved_utc!);
  const steps: [string, Partial<Attestation>][] = [
    ["2026-06-01T04:00:05Z", { status: Status.PROPOSED, disputeCount: 0, riskBps: 0 }],
    ["2026-06-01T04:12:20Z", { status: Status.DISPUTED, disputeCount: 1, riskBps: OPEN_DISPUTE_RISK_BPS }],
    ["2026-06-01T04:53:01Z", { status: Status.ESCALATED, disputeCount: 2, riskBps: OPEN_DISPUTE_RISK_BPS }],
    ["2026-06-04T00:34:19Z", { status: Status.SETTLED, disputeCount: 2, riskBps: 0, settledAt }],
  ];
  for (const [when, s] of steps) {
    const a: Attestation = {
      marketKey: replayKey,
      settledDifferently: 0,
      settledAt: 0,
      observedAt: toUnix(when),
      evidenceHash: evidence,
      status: 0,
      disputeCount: 0,
      riskBps: 0,
      ...s,
    };
    const sig = await post(a);
    console.log(`${when}  ${STATUS_NAME[a.status].padEnd(21)} risk ${String(a.riskBps).padStart(4)} bps  ${link(sig)}`);
    console.log(`    release_escrow -> ${await tryRelease()}`);
  }

  // 3. Board: markets still open at the end of the scan, plus the Strategy market.
  const open = rows.filter((r) => !r.resolved_utc).slice(-OPEN_LIMIT);
  console.log(`\nPosting ${open.length} open markets + Strategy (as observed ${new Date(SCAN_END * 1000).toISOString()})`);
  for (const r of [...open, strategy]) {
    const key = polymarketKey(r.question_id);
    const a = attestationFromRecord(r, SCAN_END, recordEvidenceHash(r));
    const existing = await program.account.marketRisk.fetchNullable(riskPda(key));
    if (existing && existing.observedAt.toNumber() >= a.observedAt) {
      console.log(`  skip (already posted)  ${r.title}`);
      continue;
    }
    const sig = await post(a);
    console.log(`  ${STATUS_NAME[a.status].padEnd(21)} ${(r.title ?? r.question_id).slice(0, 60)}  ${link(sig)}`);
  }

  const board = await program.account.marketRisk.all();
  console.log(`\nOn-chain board: ${board.length} MarketRisk accounts`);
  for (const { publicKey, account } of board.slice(0, 20)) {
    console.log(
      `  ${publicKey.toBase58()}  ${STATUS_NAME[account.status].padEnd(21)} disputes ${account.disputeCount}  risk ${account.riskBps} bps`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
