#!/usr/bin/env node
// Loupe hook bootstrap. Generated — edit .loupe/loupe.json instead.
//
// Resolves the pinned runtime from the per-user cache and runs it. On a miss it
// starts a checksum-verified download in a detached process and exits 0, so the
// first prompt after a clone is uncaptured rather than slow.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FETCH_SOURCE = [
  "const [target, url, digest, lock] = process.argv.slice(1);",
  "const fs = require('fs'), crypto = require('crypto');",
  "(async () => {",
  "  try {",
  // Detached with its output discarded: an unbounded wait would leave a process
  // alive until the machine restarts, holding the lock the whole time.
  "    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });",
  "    if (!response.ok) return;",
  "    const body = Buffer.from(await response.arrayBuffer());",
  "    if (crypto.createHash('sha256').update(body).digest('hex') !== digest) return;",
  "    const partial = target + '.partial';",
  "    fs.writeFileSync(partial, body);",
  "    fs.renameSync(partial, target);",
  "  } catch {} finally {",
  "    try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}",
  "  }",
  "})();",
].join("\n");

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));

  let pack;
  try {
    pack = JSON.parse(readFileSync(join(here, "loupe.json"), "utf8"));
  } catch {
    return;
  }

  const version = pack?.cli?.version;
  const digest = pack?.cli?.checksum;
  const downloadUrl = pack?.cli?.downloadUrl;
  if (typeof version !== "string" || version.length === 0) {
    return;
  }

  const root = process.env.LOUPE_HOME ?? join(homedir(), ".loupe");
  const cacheDir = join(root, "cli");
  const bundle = join(cacheDir, "loupe-hook-" + version + ".mjs");

  if (existsSync(bundle)) {
    // The bundle owns the exit code from here: a refusal has to reach the editor.
    await import(pathToFileURL(bundle).href);
    return;
  }

  if (typeof digest !== "string" || digest.length === 0) return;
  if (typeof downloadUrl !== "string" || downloadUrl.length === 0) return;

  const lock = join(cacheDir, ".downloading-" + version);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    return;
  }

  // The downloader releases the lock itself, which cannot happen if it was
  // killed. Left alone, the leftover directory reads as "already downloading"
  // and this bootstrap would never install the runtime again.
  try {
    if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) {
      rmSync(lock, { recursive: true, force: true });
    }
  } catch {}

  // mkdir is atomic, so only the first of several concurrent hooks downloads.
  try {
    mkdirSync(lock);
  } catch {
    return;
  }

  // Detached, so the download survives this process exiting a moment later.
  const child = spawn(
    process.execPath,
    ["-e", FETCH_SOURCE, bundle, downloadUrl + "/" + version + "/hook.mjs", digest, lock],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

// A bootstrap failure must never cost a prompt.
try {
  await main();
} catch {
  process.exitCode = 0;
}
