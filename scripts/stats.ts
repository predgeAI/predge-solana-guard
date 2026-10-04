// Recompute the headline numbers from data/polymarket-disputes-2026.json.
import { readFileSync } from "fs";
import { DisputeRecord } from "./lib";

export function stats(rows: DisputeRecord[]) {
  const disputes = rows.reduce((s, r) => s + r.n_disputes, 0);
  const twicePlus = rows.filter((r) => r.n_disputes >= 2).length;
  const settled = rows.filter((r) => r.resolved_utc);
  const different = settled.filter((r) => r.settled_price !== r.last_disputed_price).length;
  return {
    window: "2026-01-01 to 2026-10-02 (Polygon)",
    disputes,
    disputed_markets: rows.length,
    disputed_twice_or_more: twicePlus,
    settled: settled.length,
    settled_differently_from_disputed_proposal: different,
    share: +(different / settled.length).toFixed(4),
    open: rows.length - settled.length,
  };
}

if (require.main === module) {
  const rows: DisputeRecord[] = JSON.parse(
    readFileSync("data/polymarket-disputes-2026.json", "utf8")
  );
  console.log(JSON.stringify(stats(rows), null, 2));
}
