// Verify an off-chain Predge evidence pack: canonical bytes, content hash, ed25519 signature.
// Usage: npx ts-node scripts/verify-pack.ts examples/pm-2169995-microstrategy-may31.pack.json
import { readFileSync } from "fs";
import nacl from "tweetnacl";
import { sha256 } from "./lib";

const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const canon = (v: any): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
    : JSON.stringify(v);

const canonicalOk = canon(p.payload) === p.canonical;
const hashOk = sha256(Buffer.from(p.canonical, "utf8")).toString("hex") === p.content_hash;
const sigOk = nacl.sign.detached.verify(
  Buffer.from(p.canonical, "utf8"),
  Buffer.from(p.signature, "hex"),
  Buffer.from(p.public_key, "hex")
);
console.log({ canonicalOk, hashOk, sigOk, content_hash: p.content_hash, key_notice: p.key_notice });
process.exit(canonicalOk && hashOk && sigOk ? 0 : 1);
