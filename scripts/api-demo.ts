// Live demo: signed record from api.predge.io -> Solana settlement gate.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/predge-devnet.json \
//   npx ts-node scripts/api-demo.ts [polymarket_market_id]     (default 1484949)
//
// 1. GET https://api.predge.io/v1/settlement-risk/<id> and verify the ed25519
//    signature against Predge's pinned attestation key, byte for byte.
// 2. Replay the resolution path inside that signed record (each dispute, then
//    the current state) as 97-byte attestations, posted with a native Ed25519
//    instruction. evidence_hash = sha256(signed API record).
// 3. After every post, try to release funds that settle on this market:
//    through the example vault (one CPI into check_settlement) when it is
//    deployed, otherwise by calling check_settlement directly. Blocked
//    attempts are sent with preflight off, so they land on-chain as failed
//    transactions with the guard's error code, viewable in the explorer.
// 4. Post the current signed state under the market's canonical key.
// 5. Show how the same market is exposed on Solana through Jupiter Predict
//    (Jupiter market id POLY-<polymarket market id>), when Jupiter lists it.
//
// Note on keys: the API signs JSON with Predge's API key. The program verifies
// the compact 97-byte message against the attestor key in its config. Here the
// relayer checks the API signature off-chain and the configured attestor key
// signs the compact message; evidence_hash pins it to the API-signed record.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import nacl from "tweetnacl";
import guardIdl from "../target/idl/predge_guard.json";
import vaultIdl from "../target/idl/example_consumer.json";
import { ExampleConsumer } from "../target/types/example_consumer";
import { PredgeGuard } from "../target/types/predge_guard";
import { ApiRecord, PREDGE_API_KEY_HEX, timelineAttestations, verifyApiRecord } from "./api-record";
import { Attestation, DisputeRecord, STATUS_NAME, Status, ed25519Ix, pda, sha256, signAttestation, toAnchorArg, toUnix } from "./lib";

const API = process.env.PREDGE_API ?? "https://api.predge.io";
const JUPITER = process.env.JUPITER_PREDICTION_API ?? "https://api.jup.ag/prediction/v1";

async function jupiterMarket(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${JUPITER}/markets/POLY-${encodeURIComponent(id)}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const COOLING_SECS = Number(process.env.COOLING_SECS ?? 3600);

function loadAttestor(): nacl.SignKeyPair {
  const path = process.env.ATTESTOR_KEY ?? "keys/attestor-dev.json";
  if (!existsSync(path)) {
    mkdirSync("keys", { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.log(`generated demo attestor key at ${path}`);
  }
  return nacl.sign.keyPair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function fetchRecord(id: string): Promise<ApiRecord> {
  if (process.env.RECORD_FILE) return JSON.parse(readFileSync(process.env.RECORD_FILE, "utf8"));
  const res = await fetch(`${API}/v1/settlement-risk/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`api.predge.io returned HTTP ${res.status}`);
  return (await res.json()) as ApiRecord;
}

async function main() {
  const marketId = process.argv[2] ?? "1484949";
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const guard = new Program<PredgeGuard>(guardIdl as any, provider);
  const vault = new Program<ExampleConsumer>(vaultIdl as any, provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const cluster = conn.rpcEndpoint.includes("devnet")
    ? "devnet"
    : "custom&customUrl=" + encodeURIComponent(conn.rpcEndpoint);
  const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;

  // 1. Fetch and verify.
  const rec = await fetchRecord(marketId);
  const v = verifyApiRecord(rec);
  const p = v.payload;
  console.log(`Market    "${v.title}" (Polymarket ${p.market_id})`);
  console.log(`UMA       question ${p.uma_question_id}`);
  console.log(`API       ${API}/v1/settlement-risk/${marketId}  checked_at ${p.checked_at}`);
  console.log(`signature ed25519 OK, signer ${PREDGE_API_KEY_HEX.slice(0, 16)}... (pinned Predge attestation key)`);
  console.log(`state     ${p.uma_state}, disputes ${p.dispute_count}, open_dispute ${p.open_dispute}, resolved ${p.resolved_on_chain}`);
  console.log(`evidence  sha256(canonical) = ${v.evidenceHash.toString("hex")}`);

  // Resolution time is a chain fact the API record does not carry; take it
  // from the dataset when the market is in it.
  let settledAt: number | undefined;
  try {
    const rows: DisputeRecord[] = JSON.parse(readFileSync("data/polymarket-disputes-2026.json", "utf8"));
    const row = rows.find((r) => r.question_id.toLowerCase() === p.uma_question_id.toLowerCase());
    if (row?.resolved_utc) settledAt = toUnix(row.resolved_utc);
  } catch {
    /* dataset optional */
  }

  // 2. Program setup.
  const attestor = loadAttestor();
  const attestorPk = new PublicKey(attestor.publicKey);
  const configPda = pda(guard.programId, Buffer.from("config"));
  const riskPda = (k: Buffer) => pda(guard.programId, Buffer.from("risk"), k);
  console.log(`\nprogram   ${guard.programId.toBase58()}  (cluster ${cluster.split("&")[0]})`);
  console.log(`payer     ${payer.publicKey.toBase58()}  ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`attestor  ${attestorPk.toBase58()}`);

  if (!(await conn.getAccountInfo(configPda))) {
    const sig = await guard.methods
      .initialize(attestorPk, new anchor.BN(COOLING_SECS))
      .accountsPartial({ admin: payer.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`initialize               ${link(sig)}`);
  } else {
    const cfg = await guard.account.config.fetch(configPda);
    if (!cfg.attestor.equals(attestorPk)) {
      if (!cfg.admin.equals(payer.publicKey)) throw new Error("config attestor differs and payer is not admin");
      const sig = await guard.methods
        .updateConfig(attestorPk, new anchor.BN(COOLING_SECS))
        .accountsPartial({ admin: payer.publicKey, config: configPda })
        .rpc();
      console.log(`update_config            ${link(sig)}`);
    }
  }

  const post = async (a: Attestation) => {
    const signed = signAttestation(a, attestor.secretKey);
    const ix = await guard.methods
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
  };

  // Send with preflight off so a blocked attempt is recorded on-chain.
  // A distinct compute limit per attempt keeps repeated identical release
  // attempts from colliding on the same signature within one blockhash.
  let attemptNo = 0;
  const attempt = async (ix: TransactionInstruction): Promise<{ ok: boolean; code: string; sig: string }> => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + ++attemptNo }), ix);
    const sig = await conn.sendTransaction(tx, [payer], { skipPreflight: true });
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    let info = null;
    for (let i = 0; i < 10 && !info; i++) {
      info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!info) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!info?.meta?.err) return { ok: true, code: "OK", sig };
    const logs = info.meta.logMessages?.join("\n") ?? "";
    return { ok: false, code: logs.match(/Error Code: (\w+)/)?.[1] ?? JSON.stringify(info.meta.err), sig };
  };

  // 3. Replay the signed resolution path under a run-specific key.
  const runId = Date.now();
  const replayKey = sha256(`api-replay:${runId}:polymarket:${p.uma_question_id.toLowerCase()}`);
  const timeline = timelineAttestations(v, { marketKey: replayKey, settledAt });

  const vaultDeployed = !!(await conn.getAccountInfo(vault.programId))?.executable;
  let releaseIx: () => Promise<TransactionInstruction>;
  if (vaultDeployed) {
    const beneficiary = Keypair.generate().publicKey;
    const vaultId = new anchor.BN(runId);
    const vaultPda = pda(vault.programId, Buffer.from("vault"), payer.publicKey.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8));
    const amount = Number(process.env.VAULT_LAMPORTS ?? 0.01 * LAMPORTS_PER_SOL);
    // The MarketRisk PDA must exist before the vault can reference it; post first, deposit right after.
    console.log(`\nReplay of the signed resolution path (run key ${replayKey.toString("hex").slice(0, 12)}...)`);
    const first = timeline.shift()!;
    const s0 = await post(first);
    const dep = await vault.methods
      .deposit(vaultId, Array.from(replayKey), new anchor.BN(amount))
      .accountsPartial({ depositor: payer.publicKey, beneficiary, vault: vaultPda, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`vault deposit ${amount / LAMPORTS_PER_SOL} SOL (example_consumer ${vault.programId.toBase58()})  ${link(dep)}`);
    releaseIx = () =>
      vault.methods
        .release()
        .accountsPartial({
          caller: payer.publicKey,
          vault: vaultPda,
          beneficiary,
          guardConfig: configPda,
          marketRisk: riskPda(replayKey),
          predgeGuard: guard.programId,
        })
        .instruction();
    await report(first, s0);
  } else {
    console.log(`\nReplay of the signed resolution path (run key ${replayKey.toString("hex").slice(0, 12)}...)`);
    console.log(`(example_consumer not deployed on this cluster: calling check_settlement directly)`);
    releaseIx = () => guard.methods.checkSettlement().accountsPartial({ config: configPda, marketRisk: riskPda(replayKey) }).instruction();
  }

  async function report(a: Attestation, sig: string) {
    const when = new Date(a.observedAt * 1000).toISOString().replace(".000", "");
    console.log(`${when}  ${STATUS_NAME[a.status].padEnd(21)} disputes ${a.disputeCount}  risk ${String(a.riskBps).padStart(4)} bps`);
    console.log(`    post_attestation        ${link(sig)}`);
    let r = await attempt(await releaseIx());
    // A just-confirmed attestation can lag on the RPC node that serves the next
    // transaction. If settlement was just posted, give it a moment and retry so
    // the release reads the new state rather than the previous one.
    for (let i = 0; !r.ok && a.status === Status.SETTLED && i < 3; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await attempt(await releaseIx());
    }
    const label = vaultDeployed ? "vault.release (CPI)" : "check_settlement   ";
    console.log(`    ${label}     ${r.ok ? "ALLOWED" : `BLOCKED ${r.code}`}  ${link(r.sig)}`);
  }

  for (const a of timeline) await report(a, await post(a));

  // 4. Current signed state under the canonical market key.
  const current = timelineAttestations(v, { settledAt }).pop()!;
  const existing = await guard.account.marketRisk.fetchNullable(riskPda(current.marketKey));
  if (existing && existing.observedAt.toNumber() >= current.observedAt) {
    console.log(`\nCanonical record already at or past checked_at: ${riskPda(current.marketKey).toBase58()}`);
  } else {
    const sig = await post(current);
    console.log(`\nCanonical record ${riskPda(current.marketKey).toBase58()}  ${STATUS_NAME[current.status]}  ${link(sig)}`);
  }

  // 5. The same market on Solana, via Jupiter Predict.
  const jup = await jupiterMarket(p.market_id);
  if (jup) {
    console.log(`\nJupiter Predict: ${jup.marketId} (provider ${jup.provider}), status ${jup.status}, result ${jup.result ?? "-"}, resolveAt ${jup.resolveAt ?? "-"}`);
    if (jup.marketResultPubkey) console.log(`  result account on Solana mainnet: https://explorer.solana.com/address/${jup.marketResultPubkey}`);
    console.log(`  Polygon on-chain outcome (signed by Predge): ${p.onchain_resolution?.outcome ?? "not resolved"}`);
  } else {
    console.log(`\nJupiter Predict: POLY-${p.market_id} not returned by ${JUPITER}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
