import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

/** Path relative to the repository root (one level above sdk/). */
export const repoPath = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));
export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(repoPath(p), "utf8")) as T;

/**
 * Cross-checks import scripts/lib.ts and scripts/api-record.ts, which need the
 * repository root dependencies (`npm install` at the root).
 */
export const rootDepsInstalled = existsSync(repoPath("node_modules/tweetnacl")) && existsSync(repoPath("node_modules/@solana/web3.js"));

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
