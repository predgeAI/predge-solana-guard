// Build data/polymarket-disputes-2026.json from Predge's raw 2026 scan of
// Polymarket's UMA adapters on Polygon, and recompute the headline numbers.
//
// Usage: npx ts-node scripts/build-dataset.ts <path/to/disputed_markets_2026.json>
//
// The raw file comes from Predge's settlement-risk scanner (eth_getLogs over
// DisputePrice, QuestionResolved and related events on the UMA CTF adapters,
// 1 Jan to 2 Oct 2026). Only market-level fields are kept. No wallet
// addresses are included.
import { readFileSync, writeFileSync } from "fs";
import { DisputeRecord } from "./lib";

const src = process.argv[2];
if (!src) {
  console.error("usage: build-dataset.ts <disputed_markets_2026.json>");
  process.exit(1);
}

const raw: any[] = JSON.parse(readFileSync(src, "utf8"));
const out: DisputeRecord[] = raw.map((m) => ({
  question_id: m.qid,
  market_id: m.market_id ?? null,
  title: m.title ?? null,
  adapter: m.adapter,
  n_disputes: m.n_disputes,
  first_dispute_utc: m.first_dispute_utc,
  dispute_txs: m.dispute_txs,
  last_disputed_price: m.disputed_prices[m.disputed_prices.length - 1],
  resolved_utc: m.resolved_utc ?? null,
  settled_price: m.settled_price ?? null,
}));

writeFileSync("data/polymarket-disputes-2026.json", JSON.stringify(out));
console.log(`wrote ${out.length} markets`);
