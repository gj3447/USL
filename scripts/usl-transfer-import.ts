#!/usr/bin/env node
/** Fixed-format PT03 importer; the JSON spec is data only and cannot register execution. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  importPortableTransfer,
  PORTABLE_TRANSFER_IMPORT_SCHEMA,
} from "../src/addons/portable-transfer-import.js";

const usage =
  "usage: tsx scripts/usl-transfer-import.ts --spec FILE --destination-parent DIRECTORY --destination-name NAME";
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
if (
  args.length !== 6 ||
  args[0] !== "--spec" ||
  args[2] !== "--destination-parent" ||
  args[4] !== "--destination-name"
)
  throw new Error(usage);
const specPath = resolve(args[1]!),
  destinationParent = resolve(args[3]!),
  destinationName = args[5]!;
const before = await lstat(specPath);
if (
  !before.isFile() ||
  before.isSymbolicLink() ||
  before.size > 2 * 1024 * 1024
)
  throw new Error("spec must be a regular non-symlink file of at most 2 MiB");
const fh = await open(
  specPath,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
let bytes: Buffer;
try {
  if (!before.isFile() || before.size < 0) throw new Error("invalid spec");
  bytes = Buffer.allocUnsafe(before.size);
  let at = 0;
  while (at < bytes.length) {
    const r = await fh.read(bytes, at, bytes.length - at, null);
    if (!r.bytesRead) break;
    at += r.bytesRead;
  }
  const after = await fh.stat();
  if (
    at !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error("spec changed during reading");
} finally {
  await fh.close();
}
let spec: unknown;
try {
  spec = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
} catch {
  throw new Error("invalid spec JSON");
}
if (!spec || typeof spec !== "object" || Array.isArray(spec))
  throw new Error("spec must be an object");
const v = spec as Record<string, unknown>,
  allowed = new Set([
    "schema",
    "bundlePath",
    "expectedReceiptDigest",
    "allowedOwnerNamespace",
    "freshnessMode",
    "localBranchId",
    "ownerState",
    "registry",
    "maxTotalBytes",
    "maxDurationMs",
  ]);
for (const k of Object.keys(v))
  if (!allowed.has(k)) throw new Error(`unknown spec field: ${k}`);
if (
  v.schema !== PORTABLE_TRANSFER_IMPORT_SCHEMA ||
  typeof v.bundlePath !== "string" ||
  !isAbsolute(v.bundlePath) ||
  typeof v.expectedReceiptDigest !== "string" ||
  !/^sha256:[0-9a-f]{64}$/u.test(v.expectedReceiptDigest) ||
  typeof v.allowedOwnerNamespace !== "string"
)
  throw new Error(
    "CLI spec requires import schema, absolute bundlePath, expected receipt digest, and allowed owner namespace",
  );
const result = await importPortableTransfer({
  ...v,
  schema: PORTABLE_TRANSFER_IMPORT_SCHEMA,
  bundlePath: v.bundlePath,
  destinationParent,
  destinationName,
  expectedReceiptDigest: v.expectedReceiptDigest,
  allowedOwnerNamespace: v.allowedOwnerNamespace,
} as Parameters<typeof importPortableTransfer>[0]);
process.stdout.write(`${JSON.stringify(result)}\n`);
