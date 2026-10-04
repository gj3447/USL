/** Strict, local-only PT03 restore for a completed PT02 pinned-file bundle. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { assertJsonData } from "../json-data.js";
import { contractDigest } from "../contract-core.js";
import {
  parsePortableTransferEnvelope,
  parsePortableTransferManifest,
  portableResourceIdentityKey,
  portableTransferEnvelopeSchema,
  portableTransferManifestSchema,
  type PortableTransferManifest,
} from "./portable-transfer.js";
import {
  PORTABLE_TRANSFER_EXPORT_SCHEMA,
  portableTransferClosureDigest,
  type PortableTransferDependency,
  type FrozenPortableTransferFile,
} from "./portable-transfer-export.js";

export const PORTABLE_TRANSFER_IMPORT_SCHEMA =
  "usl-portable-transfer-import/v1" as const;
const MAX_FILES = 1024,
  MAX_BYTES = 512 * 1024 * 1024,
  MAX_METADATA = 2 * 1024 * 1024,
  MAX_DURATION = 5 * 60_000;
const SIDE_CARS = [
  "manifest.json",
  "envelope.json",
  "inventory.json",
  "policy.json",
  "dictionary.json",
  "schema.json",
] as const;
type Freshness =
  | "FRESHNESS_UNKNOWN"
  | "MATCHES_KNOWN_HEAD"
  | "DIVERGED"
  | "WITHDRAWN";

export interface PortableTransferHostState {
  readonly resources: readonly {
    nativeId: string;
    headRevisionId?: string;
    withdrawn?: boolean;
  }[];
}
/** A bounded, independent local snapshot.  It is never a host registration API. */
export interface PortableTransferRegistry {
  readonly resources?: readonly {
    ownerNamespace: string;
    nativeId: string;
    descriptorDigest: string;
  }[];
  readonly revisions?: readonly { id: string; descriptorDigest: string }[];
  readonly representations?: readonly {
    id: string;
    descriptorDigest: string;
  }[];
}
export interface PortableTransferImportRequest {
  readonly schema: typeof PORTABLE_TRANSFER_IMPORT_SCHEMA;
  readonly bundlePath: string;
  readonly destinationParent: string;
  readonly destinationName: string;
  readonly expectedReceiptDigest: string;
  readonly allowedOwnerNamespace: string;
  readonly freshnessMode?: "HISTORICAL_SNAPSHOT" | "LOCAL_BRANCH";
  /** Required for LOCAL_BRANCH; this declares a new local label, never an owner head. */
  readonly localBranchId?: string;
  readonly ownerState?: PortableTransferHostState;
  readonly registry?: PortableTransferRegistry;
  readonly maxTotalBytes?: number;
  readonly maxDurationMs?: number;
}
export interface RestoredPortableTransferFile {
  readonly representationId: string;
  readonly revisionId: string;
  readonly nativeId: string;
  readonly restorePath: string;
}
export interface PortableTransferImportResult {
  readonly destinationPath: string;
  readonly bundleDigest: string;
  readonly manifestDigest: string;
  readonly ownerNamespace: string;
  readonly manifest: PortableTransferManifest;
  readonly restored: readonly RestoredPortableTransferFile[];
  readonly freshness: Freshness;
  readonly resourceFreshness: Readonly<Record<string, Freshness>>;
  readonly freshnessMode: "HISTORICAL_SNAPSHOT" | "LOCAL_BRANCH";
  readonly localBranchId?: string;
  readonly operations: "HISTORICAL_UNRECONCILED";
  readonly executionCalls: 0;
  readonly reusedExisting: boolean;
}

const pin = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const requestSchema = z
  .object({
    schema: z.literal(PORTABLE_TRANSFER_IMPORT_SCHEMA),
    bundlePath: z.string().min(1).max(4096),
    destinationParent: z.string().min(1).max(4096),
    destinationName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    expectedReceiptDigest: pin,
    allowedOwnerNamespace: z.string().min(1).max(512),
    freshnessMode: z.enum(["HISTORICAL_SNAPSHOT", "LOCAL_BRANCH"]).optional(),
    localBranchId: z.string().min(1).max(512).optional(),
    ownerState: z
      .object({
        resources: z
          .array(
            z
              .object({
                nativeId: z.string().min(1).max(256),
                headRevisionId: z.string().min(1).max(512).optional(),
                withdrawn: z.boolean().optional(),
              })
              .strict(),
          )
          .max(MAX_FILES),
      })
      .strict()
      .optional(),
    registry: z
      .object({
        resources: z
          .array(
            z
              .object({
                ownerNamespace: z.string().min(1).max(512),
                nativeId: z.string().min(1).max(256),
                descriptorDigest: pin,
              })
              .strict(),
          )
          .max(MAX_FILES)
          .optional(),
        revisions: z
          .array(
            z
              .object({ id: z.string().min(1).max(512), descriptorDigest: pin })
              .strict(),
          )
          .max(4096)
          .optional(),
        representations: z
          .array(
            z
              .object({ id: z.string().min(1).max(512), descriptorDigest: pin })
              .strict(),
          )
          .max(4096)
          .optional(),
      })
      .strict()
      .optional(),
    maxTotalBytes: z.number().int().min(0).max(MAX_BYTES).optional(),
    maxDurationMs: z.number().int().min(1).max(MAX_DURATION).optional(),
  })
  .strict();
const verifiedRestores = new WeakMap<
  object,
  {
    readonly markerDigest: string;
    readonly root: string;
    readonly rootStat: Awaited<ReturnType<typeof stat>>;
    readonly restored: readonly RestoredPortableTransferFile[];
  }
>();
const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const deadline = (until: number) => {
  if (Date.now() > until) throw new Error("import duration budget exceeded");
};
const same = (
  a: Awaited<ReturnType<typeof stat>>,
  b: Awaited<ReturnType<typeof stat>>,
) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const safeRelative = (value: string, what: string) => {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw new Error(`unsafe ${what}`);
};
const safeRestore = (value: string) => {
  safeRelative(value, "restore path");
  const parts = value.split("/");
  if (
    parts.length > 16 ||
    parts.some(
      (x) =>
        Buffer.byteLength(x) > 255 ||
        /[\u0000-\u001f\u007f<>:"|?*]/u.test(x) ||
        /[. ]$/u.test(x) ||
        /^(?:\.git|\.ssh|\.aws|\.npmrc|\.gitconfig|\.netrc|\.env(?:\..*)?)$/iu.test(
          x,
        ) ||
        /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(
          x,
        ),
    )
  )
    throw new Error("unsafe portable restore path");
};
const within = (root: string, child: string) => {
  const r = relative(root, child);
  if (!r || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r))
    throw new Error("path escapes selected root");
};
async function safeDir(path: string) {
  let current = parsePath(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(
        "directory path contains a symlink or non-directory component",
      );
  }
  return lstat(path);
}
async function components(root: string, path: string) {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink())
      throw new Error("path contains a symlink component");
  }
}
async function regular(path: string, label: string) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new Error(`${label} must be a regular non-symlink file`);
  return entry;
}
async function readRegular(
  root: string,
  path: string,
  cap: number,
  until: number,
) {
  deadline(until);
  await components(root, path);
  const before = await regular(path, "bundle file");
  if (before.size > cap) throw new Error("bundle metadata exceeds byte budget");
  const fh = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await fh.stat();
    if (!opened.isFile() || !same(before, opened))
      throw new Error("bundle file changed before reading");
    const data = Buffer.allocUnsafe(before.size);
    let at = 0;
    while (at < data.length) {
      deadline(until);
      const r = await fh.read(data, at, data.length - at, null);
      if (!r.bytesRead) break;
      at += r.bytesRead;
    }
    if (at !== before.size || !same(before, await fh.stat()))
      throw new Error("bundle file changed during reading");
    return data;
  } finally {
    await fh.close();
  }
}
async function hashFile(
  root: string,
  path: string,
  cap: number,
  until: number,
) {
  await components(root, path);
  const before = await regular(path, "payload");
  if (before.size > cap) throw new Error("payload exceeds byte budget");
  const fh = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const hash = createHash("sha256");
  let count = 0;
  try {
    if (!same(before, await fh.stat()))
      throw new Error("payload changed before reading");
    const buf = Buffer.allocUnsafe(65536);
    for (;;) {
      deadline(until);
      const r = await fh.read(buf, 0, buf.length, null);
      if (!r.bytesRead) break;
      count += r.bytesRead;
      if (count > cap) throw new Error("payload exceeds byte budget");
      hash.update(buf.subarray(0, r.bytesRead));
    }
    if (!same(before, await fh.stat()))
      throw new Error("payload changed during reading");
  } finally {
    await fh.close();
  }
  return { byteLength: count, byteDigest: `sha256:${hash.digest("hex")}` };
}
async function copyFile(
  source: string,
  destination: string,
  pin: { byteLength: number; byteDigest: string },
  until: number,
) {
  const before = await regular(source, "bundle payload");
  if (before.size !== pin.byteLength) throw new Error("payload size mismatch");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let count = 0;
  try {
    output = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    if (!same(before, await input.stat()))
      throw new Error("payload changed before copying");
    const buf = Buffer.allocUnsafe(65536);
    for (;;) {
      deadline(until);
      const r = await input.read(buf, 0, buf.length, null);
      if (!r.bytesRead) break;
      count += r.bytesRead;
      if (count > pin.byteLength)
        throw new Error("payload exceeds pinned byte length");
      let off = 0;
      while (off < r.bytesRead) {
        deadline(until);
        const w = await output.write(buf, off, r.bytesRead - off, null);
        if (!w.bytesWritten) throw new Error("partial payload write");
        off += w.bytesWritten;
      }
      hash.update(buf.subarray(0, r.bytesRead));
    }
    deadline(until);
    await output.sync();
    if (!same(before, await input.stat()))
      throw new Error("payload changed during copying");
  } finally {
    await output?.close();
    await input.close();
  }
  const actual = `sha256:${hash.digest("hex")}`;
  if (count !== pin.byteLength || actual !== pin.byteDigest)
    throw new Error("payload digest mismatch");
  deadline(until);
  if (!(await regular(destination, "restored payload")).isFile())
    throw new Error("restored payload is not regular");
}
async function exactTree(
  root: string,
  wanted: readonly string[],
  until: number,
) {
  const expected = new Map<string, "file" | "directory">();
  for (const f of wanted) {
    const p = f.split("/");
    for (let i = 1; i < p.length; i++)
      expected.set(p.slice(0, i).join("/"), "directory");
    expected.set(f, "file");
  }
  const seen = new Set<string>(),
    todo = [""];
  while (todo.length) {
    const base = todo.pop()!,
      dir = await opendir(resolve(root, base));
    for await (const item of dir) {
      deadline(until);
      const name = base ? `${base}/${item.name}` : item.name;
      if (!expected.has(name) || seen.has(name))
        throw new Error("unexpected bundle tree entry");
      seen.add(name);
      if (expected.get(name) === "directory" && item.isDirectory())
        todo.push(name);
      else if (expected.get(name) !== "file" || !item.isFile())
        throw new Error("special or mismatched bundle tree entry");
    }
  }
  if (seen.size !== expected.size) throw new Error("missing bundle tree entry");
}
function plain(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function json(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`invalid ${label} JSON`);
  }
}
function only(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`unknown ${label} field`);
}
function collision(paths: readonly string[]) {
  const seen = new Map<string, { spelling: string; file: boolean }>();
  for (const p of paths) {
    safeRestore(p);
    const chunks = p.split("/");
    for (let i = 0; i < chunks.length; i++) {
      const spelling = chunks.slice(0, i + 1).join("/"),
        key = spelling.normalize("NFC").toLowerCase(),
        file = i === chunks.length - 1,
        old = seen.get(key);
      if (old && (old.spelling !== spelling || old.file || file))
        throw new Error("restore path collision");
      seen.set(key, { spelling, file });
    }
  }
}

/** Verifies a PT02 receipt and all content before one local atomic publish. */
export async function importPortableTransfer(
  input: PortableTransferImportRequest,
): Promise<PortableTransferImportResult> {
  assertJsonData(input);
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `invalid portable transfer import request: ${parsed.error.issues[0]?.message ?? "schema"}`,
    );
  const req = parsed.data;
  const until = Date.now() + (req.maxDurationMs ?? MAX_DURATION),
    max = req.maxTotalBytes ?? MAX_BYTES;
  const bundle = resolve(req.bundlePath),
    parent = resolve(req.destinationParent),
    reservation = resolve(parent, req.destinationName);
  within(parent, reservation);
  if (
    bundle === parent ||
    bundle.startsWith(`${parent}${sep}`) ||
    parent.startsWith(`${bundle}${sep}`)
  )
    throw new Error(
      "bundle and destination parent must not contain one another",
    );
  const bundleRoot = await safeDir(bundle),
    parentRoot = await safeDir(parent);
  await components(bundle, bundle);
  const receiptBytes = await readRegular(
    bundle,
    resolve(bundle, "receipt.json"),
    MAX_METADATA,
    until,
  );
  if (digest(receiptBytes) !== req.expectedReceiptDigest)
    throw new Error(
      "bundle receipt digest does not match independently expected receipt digest",
    );
  const receipt = plain(json(receiptBytes, "receipt"), "receipt");
  only(receipt, "receipt", [
    "schema",
    "snapshotId",
    "manifestDigest",
    "metadata",
    "selfContained",
    "files",
    "bytes",
  ]);
  const receiptFiles = receipt.files,
    receiptBytesTotal = receipt.bytes;
  if (
    receipt.schema !== PORTABLE_TRANSFER_EXPORT_SCHEMA ||
    typeof receipt.manifestDigest !== "string" ||
    typeof receipt.snapshotId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/u.test(receipt.snapshotId) ||
    typeof receiptFiles !== "number" ||
    typeof receiptBytesTotal !== "number" ||
    !Number.isSafeInteger(receiptFiles) ||
    !Number.isSafeInteger(receiptBytesTotal) ||
    receiptFiles < 1 ||
    receiptBytesTotal < 0 ||
    receipt.selfContained !== true
  )
    throw new Error("invalid or incomplete PT02 receipt");
  const meta = plain(receipt.metadata, "receipt metadata");
  if (
    Object.keys(meta).length !== SIDE_CARS.length ||
    SIDE_CARS.some((n) => !(n in meta))
  )
    throw new Error("receipt must pin exactly six sidecar files");
  const sidecars: Record<string, unknown> = {};
  for (const name of SIDE_CARS) {
    const pin = plain(meta[name], `metadata ${name}`);
    if (
      typeof pin.byteDigest !== "string" ||
      typeof pin.byteLength !== "number" ||
      !Number.isSafeInteger(pin.byteLength) ||
      pin.byteLength < 0 ||
      pin.byteLength > MAX_METADATA
    )
      throw new Error("invalid metadata pin");
    const bytes = await readRegular(
      bundle,
      resolve(bundle, "payload-bundle", name),
      pin.byteLength,
      until,
    );
    if (bytes.length !== pin.byteLength || digest(bytes) !== pin.byteDigest)
      throw new Error("sidecar hash or size mismatch");
    sidecars[name] = json(bytes, name);
  }
  const manifest = parsePortableTransferManifest(sidecars["manifest.json"]);
  const envelope = parsePortableTransferEnvelope(sidecars["envelope.json"]);
  if (envelope.manifestDigest !== receipt.manifestDigest)
    throw new Error("manifest receipt mismatch");
  if (JSON.stringify(envelope.manifest) !== JSON.stringify(manifest))
    throw new Error("envelope and manifest differ");
  if (manifest.ownerNamespace !== req.allowedOwnerNamespace)
    throw new Error("owner namespace is not allowed");
  const policy = plain(sidecars["policy.json"], "policy"),
    inventory = plain(sidecars["inventory.json"], "inventory"),
    dictionary = plain(sidecars["dictionary.json"], "dictionary"),
    schema = plain(sidecars["schema.json"], "schema");
  const manifestSchemaJson = JSON.parse(
      JSON.stringify(z.toJSONSchema(portableTransferManifestSchema)),
    ),
    envelopeSchemaJson = JSON.parse(
      JSON.stringify(z.toJSONSchema(portableTransferEnvelopeSchema)),
    );
  only(policy, "policy", [
    "schema",
    "version",
    "snapshotId",
    "snapshotProfile",
    "ownerConsistency",
    "expectedClosureDigest",
    "closureDigest",
    "restoreProfile",
    "selfContained",
    "dependencyClasses",
  ]);
  only(inventory, "inventory", ["dependencies", "files"]);
  only(schema, "schema", [
    "schema",
    "version",
    "restoreProfiles",
    "manifest",
    "envelope",
  ]);
  if (
    policy.schema !== PORTABLE_TRANSFER_EXPORT_SCHEMA ||
    policy.version !== 1 ||
    typeof policy.snapshotId !== "string" ||
    policy.snapshotId !== receipt.snapshotId ||
    policy.restoreProfile !== "PINNED_FILES" ||
    policy.selfContained !== true ||
    !(
      policy.snapshotProfile === "PINNED_BYTE_SET" ||
      policy.snapshotProfile === "OWNER_FROZEN"
    ) ||
    !(
      policy.ownerConsistency === "NOT_ASSERTED_BY_CLI" ||
      policy.ownerConsistency === "ASSERTED_BY_HOST_NOT_INDEPENDENTLY_VERIFIED"
    ) ||
    (policy.snapshotProfile === "OWNER_FROZEN" &&
      policy.ownerConsistency !== "ASSERTED_BY_HOST_NOT_INDEPENDENTLY_VERIFIED") ||
    typeof policy.closureDigest !== "string" ||
    !(
      typeof policy.expectedClosureDigest === "string" ||
      policy.expectedClosureDigest === null
    ) ||
    (policy.snapshotProfile === "PINNED_BYTE_SET" &&
      typeof policy.expectedClosureDigest !== "string") ||
    (policy.snapshotProfile === "OWNER_FROZEN" &&
      policy.expectedClosureDigest !== null) ||
    !Array.isArray(policy.dependencyClasses) ||
    JSON.stringify(policy.dependencyClasses) !==
      JSON.stringify(["PACKAGED", "EXTERNAL_REQUIRED", "OPTIONAL"]) ||
    schema.schema !== PORTABLE_TRANSFER_EXPORT_SCHEMA ||
    schema.version !== 1 ||
    JSON.stringify(schema.restoreProfiles) !==
      JSON.stringify(["PINNED_FILES", "GIT_WORKTREE"]) ||
    contractDigest(schema.manifest) !== contractDigest(manifestSchemaJson) ||
    contractDigest(schema.envelope) !== contractDigest(envelopeSchemaJson)
  )
    throw new Error("unsupported restore policy");
  if (
    !Array.isArray(inventory.files) ||
    !Array.isArray(inventory.dependencies) ||
    inventory.files.length < 1 ||
    inventory.files.length > MAX_FILES
  )
    throw new Error("invalid inventory");
  // inventory has an additional restorePath presentation field; construct the exact
  // PT02 closure inputs instead of passing bundle-controlled objects through.
  const files = inventory.files.map((item): FrozenPortableTransferFile => {
    const f = plain(item, "inventory file");
    only(f, "inventory file", [
      "sourcePath",
      "restorePath",
      "payloadPath",
      "nativeId",
      "revisionId",
      "representationId",
      "byteDigest",
      "byteLength",
      "required",
      "parents",
    ]);
    const sourcePath = f.sourcePath,
      byteDigest = f.byteDigest,
      byteLength = f.byteLength;
    if (
      typeof sourcePath !== "string" ||
      f.restorePath !== sourcePath ||
      typeof f.payloadPath !== "string" ||
      typeof f.nativeId !== "string" ||
      typeof f.revisionId !== "string" ||
      typeof f.representationId !== "string" ||
      typeof byteDigest !== "string" ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0
    )
      throw new Error("invalid inventory restore path or file");
    const parents = f.parents;
    if (
      parents !== undefined &&
      (!Array.isArray(parents) || parents.length !== 0)
    )
      throw new Error("inventory parents are unsupported");
    return Object.freeze({
      ...{
        sourcePath,
        payloadPath: f.payloadPath,
        nativeId: f.nativeId,
        revisionId: f.revisionId,
        representationId: f.representationId,
        expectedByteDigest: byteDigest,
        expectedByteLength: byteLength,
      },
      ...(typeof f.required === "boolean" ? { required: f.required } : {}),
      ...(parents === undefined ? {} : { parents: [] }),
    });
  });
  const deps = inventory.dependencies.map(
    (item): PortableTransferDependency => {
      const d = plain(item, "inventory dependency");
      only(d, "inventory dependency", [
        "id",
        "class",
        "required",
        "reason",
        "packagedRepresentationIds",
      ]);
      if (
        typeof d.id !== "string" ||
        typeof d.class !== "string" ||
        typeof d.required !== "boolean" ||
        typeof d.reason !== "string" ||
        !["PACKAGED", "EXTERNAL_REQUIRED", "OPTIONAL"].includes(d.class) ||
        (d.class === "OPTIONAL" && d.required) ||
        (d.class === "EXTERNAL_REQUIRED" && d.required)
      )
        throw new Error("invalid dependency inventory");
      const packagedRepresentationIds = d.packagedRepresentationIds;
      if (
        packagedRepresentationIds !== undefined &&
        (!Array.isArray(packagedRepresentationIds) ||
          packagedRepresentationIds.some((x) => typeof x !== "string") ||
          new Set(packagedRepresentationIds).size !==
            packagedRepresentationIds.length)
      )
        throw new Error("invalid packaged representation IDs");
      if (
        (d.class === "PACKAGED" && !packagedRepresentationIds?.length) ||
        (d.class !== "PACKAGED" && packagedRepresentationIds !== undefined)
      )
        throw new Error("invalid dependency inventory");
      return Object.freeze({
        ...{
          id: d.id,
          class: d.class as PortableTransferDependency["class"],
          required: d.required,
          reason: d.reason,
        },
        ...(packagedRepresentationIds === undefined
          ? {}
          : { packagedRepresentationIds: [...packagedRepresentationIds] }),
      });
    },
  );
  if (
    portableTransferClosureDigest("PINNED_FILES", files, deps) !==
      policy.closureDigest ||
    (policy.expectedClosureDigest !== null &&
      policy.expectedClosureDigest !== policy.closureDigest)
  )
    throw new Error("inventory manifest closure does not match policy");
  if (
    deps.some(
      (d) =>
        d.class === "EXTERNAL_REQUIRED" ||
        (d.class === "PACKAGED" && !d.packagedRepresentationIds?.length),
    )
  )
    throw new Error("incomplete dependency closure");
  if (
    manifest.resources.length !== files.length ||
    manifest.revisions.length !== files.length ||
    manifest.representations.length !== files.length ||
    receiptFiles !== files.length
  )
    throw new Error("manifest and inventory file count mismatch");
  const representations = new Map(
    manifest.representations.map((x) => [x.id, x]),
  );
  const revisions = new Map(manifest.revisions.map((x) => [x.id, x]));
  if (
    new Set(files.map((x) => x.representationId)).size !== files.length ||
    new Set(files.map((x) => x.revisionId)).size !== files.length ||
    new Set(files.map((x) => x.nativeId)).size !== files.length
  )
    throw new Error("duplicate inventory identity");
  const packaged = new Set(
    deps.flatMap((d) => d.packagedRepresentationIds ?? []),
  );
  if ([...packaged].some((id) => !representations.has(id)))
    throw new Error("dependency references absent representation");
  const restores: string[] = [];
  let total = 0;
  const restored: RestoredPortableTransferFile[] = [];
  for (const f of files) {
    const restorePath = f.sourcePath;
    if (
      !f ||
      typeof f !== "object" ||
      typeof restorePath !== "string" ||
      typeof f.payloadPath !== "string" ||
      typeof f.representationId !== "string" ||
      typeof f.revisionId !== "string" ||
      typeof f.nativeId !== "string" ||
      typeof f.expectedByteDigest !== "string" ||
      typeof f.expectedByteLength !== "number"
    )
      throw new Error("invalid inventory file");
    safeRestore(restorePath);
    const rep = representations.get(f.representationId),
      rev = revisions.get(f.revisionId);
    if (
      !rep ||
      !rev ||
      rep.revision !== f.revisionId ||
      rep.payloadPath !== `payload/${f.payloadPath}` ||
      rep.byteDigest !== f.expectedByteDigest ||
      rep.byteLength !== f.expectedByteLength ||
      rev.resource.nativeId !== f.nativeId
    )
      throw new Error("inventory does not match manifest representation");
    restores.push(restorePath);
    total += f.expectedByteLength;
    if (total > max || total > receiptBytesTotal)
      throw new Error("payload budget exceeded");
    restored.push({
      representationId: f.representationId,
      revisionId: f.revisionId,
      nativeId: f.nativeId,
      restorePath,
    });
  }
  if (total !== receiptBytesTotal)
    throw new Error("receipt byte count mismatch");
  collision(restores);
  for (const value of Object.values(dictionary)) {
    if (
      typeof value !== "string" ||
      !files.some((f) => f.payloadPath === value)
    )
      throw new Error("dictionary does not refer to bundled payload");
  }
  const wanted = [
    "receipt.json",
    ...SIDE_CARS.map((n) => `payload-bundle/${n}`),
    ...files.map((f) => `payload-bundle/payload/${f.payloadPath}`),
  ];
  await exactTree(bundle, wanted, until);
  for (const f of files) {
    const h = await hashFile(
      bundle,
      resolve(bundle, "payload-bundle", "payload", f.payloadPath),
      f.expectedByteLength,
      until,
    );
    if (
      h.byteDigest !== f.expectedByteDigest ||
      h.byteLength !== f.expectedByteLength
    )
      throw new Error("payload hash mismatch");
  }
  if (
    (req.freshnessMode ?? "HISTORICAL_SNAPSHOT") === "LOCAL_BRANCH" &&
    !req.localBranchId
  )
    throw new Error("LOCAL_BRANCH requires an explicit localBranchId");
  for (const known of req.registry?.resources ?? []) {
    const actual = manifest.resources.find(
      (r) =>
        r.ownerNamespace === known.ownerNamespace &&
        r.nativeId === known.nativeId,
    );
    if (actual && contractDigest(actual) !== known.descriptorDigest)
      throw new Error("existing registry resource definition conflicts");
  }
  for (const known of req.registry?.revisions ?? []) {
    const actual = manifest.revisions.find((r) => r.id === known.id);
    if (actual && contractDigest(actual) !== known.descriptorDigest)
      throw new Error("existing registry revision definition conflicts");
  }
  for (const known of req.registry?.representations ?? []) {
    const actual = manifest.representations.find((r) => r.id === known.id);
    if (actual && contractDigest(actual) !== known.descriptorDigest)
      throw new Error("existing registry representation definition conflicts");
  }
  const ownerEntries = req.ownerState?.resources ?? [];
  if (new Set(ownerEntries.map((x) => x.nativeId)).size !== ownerEntries.length)
    throw new Error("duplicate owner state native ID");
  for (const list of [
    req.registry?.resources ?? [],
    req.registry?.revisions ?? [],
    req.registry?.representations ?? [],
  ]) {
    const keys = list.map((x) =>
      "nativeId" in x ? `${x.ownerNamespace}\u0000${x.nativeId}` : x.id,
    );
    if (new Set(keys).size !== keys.length)
      throw new Error("duplicate registry descriptor");
  }
  const state = new Map(ownerEntries.map((x) => [x.nativeId, x]));
  const resourceFreshness: Record<string, Freshness> = Object.create(
    null,
  ) as Record<string, Freshness>;
  for (const resource of manifest.resources) {
    const s = state.get(resource.nativeId),
      revisionsFor = manifest.revisions.filter(
        (x) =>
          portableResourceIdentityKey(x.resource) ===
          portableResourceIdentityKey(resource),
      );
    resourceFreshness[resource.nativeId] = s?.withdrawn
      ? "WITHDRAWN"
      : !s || !s.headRevisionId
        ? "FRESHNESS_UNKNOWN"
        : revisionsFor.some((x) => x.id === s.headRevisionId)
          ? "MATCHES_KNOWN_HEAD"
          : "DIVERGED";
  }
  const rank: Record<Freshness, number> = {
    MATCHES_KNOWN_HEAD: 0,
    FRESHNESS_UNKNOWN: 1,
    DIVERGED: 2,
    WITHDRAWN: 3,
  };
  const freshness = (Object.values(resourceFreshness).sort(
    (a, b) => rank[b] - rank[a],
  )[0] ?? "FRESHNESS_UNKNOWN") as Freshness;
  const completion = resolve(reservation, "import-receipt.json"),
    workspace = resolve(reservation, "workspace");
  const frozenRestored = Object.freeze(
    restored.map((item) => Object.freeze({ ...item })),
  );
  const result = async (reusedExisting: boolean, markerBytes: Buffer) => {
    const rootStat = await safeDir(workspace);
    const value = Object.freeze({
      destinationPath: workspace,
      bundleDigest: req.expectedReceiptDigest,
      manifestDigest: envelope.manifestDigest,
      ownerNamespace: manifest.ownerNamespace,
      manifest,
      restored: frozenRestored,
      freshness,
      resourceFreshness: Object.freeze(
        Object.fromEntries(Object.entries(resourceFreshness)),
      ),
      freshnessMode: req.freshnessMode ?? "HISTORICAL_SNAPSHOT",
      ...(req.localBranchId === undefined
        ? {}
        : { localBranchId: req.localBranchId }),
      operations: "HISTORICAL_UNRECONCILED" as const,
      executionCalls: 0 as const,
      reusedExisting,
    });
    verifiedRestores.set(value, {
      markerDigest: digest(markerBytes),
      root: workspace,
      rootStat,
      restored: frozenRestored,
    });
    return value;
  };
  try {
    await mkdir(reservation, { mode: 0o700 });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    await safeDir(reservation);
    const marker = await lstat(completion).catch(() => undefined);
    if (!marker?.isFile() || marker.isSymbolicLink())
      throw new Error("destination reservation is incomplete or held");
    const prior = await readRegular(
      reservation,
      completion,
      MAX_METADATA,
      until,
    );
    const data = plain(json(prior, "import receipt"), "import receipt");
    if (
      data.bundleDigest !== req.expectedReceiptDigest ||
      data.manifestDigest !== envelope.manifestDigest ||
      data.ownerNamespace !== manifest.ownerNamespace ||
      data.freshnessMode !== (req.freshnessMode ?? "HISTORICAL_SNAPSHOT") ||
      data.localBranchId !== (req.localBranchId ?? null) ||
      data.schema !== PORTABLE_TRANSFER_IMPORT_SCHEMA ||
      JSON.stringify(data.files) !== JSON.stringify(frozenRestored) ||
      data.operations !== "HISTORICAL_UNRECONCILED" ||
      data.executionCalls !== 0
    )
      throw new Error(
        "existing destination belongs to a different import identity",
      );
    await safeDir(workspace);
    await exactTree(workspace, restores, until);
    for (const f of files) {
      const h = await hashFile(
        workspace,
        resolve(workspace, f.sourcePath),
        f.expectedByteLength,
        until,
      );
      if (
        h.byteDigest !== f.expectedByteDigest ||
        h.byteLength !== f.expectedByteLength
      )
        throw new Error("existing destination bytes no longer verify");
    }
    return result(true, prior);
  }
  const stage = resolve(reservation, ".staging");
  let completionBytes: Buffer;
  try {
    await mkdir(stage, { mode: 0o700 });
    for (const f of files) {
      await components(
        bundle,
        resolve(bundle, "payload-bundle", "payload", f.payloadPath),
      );
      await copyFile(
        resolve(bundle, "payload-bundle", "payload", f.payloadPath),
        resolve(stage, f.sourcePath),
        { byteLength: f.expectedByteLength, byteDigest: f.expectedByteDigest },
        until,
      );
    }
    await exactTree(stage, restores, until);
    for (const f of files) {
      const h = await hashFile(
        stage,
        resolve(stage, f.sourcePath),
        f.expectedByteLength,
        until,
      );
      if (
        h.byteDigest !== f.expectedByteDigest ||
        h.byteLength !== f.expectedByteLength
      )
        throw new Error("staged restore verification failed");
    }
    const current = await safeDir(parent);
    if (current.dev !== parentRoot.dev || current.ino !== parentRoot.ino)
      throw new Error("destination parent changed");
    deadline(until);
    await rename(stage, workspace);
    completionBytes = Buffer.from(
      JSON.stringify({
        schema: PORTABLE_TRANSFER_IMPORT_SCHEMA,
        bundleDigest: req.expectedReceiptDigest,
        manifestDigest: envelope.manifestDigest,
        ownerNamespace: manifest.ownerNamespace,
        files: restored,
        freshnessMode: req.freshnessMode ?? "HISTORICAL_SNAPSHOT",
        localBranchId: req.localBranchId ?? null,
        operations: "HISTORICAL_UNRECONCILED",
        executionCalls: 0,
      }) + "\n",
    );
    const temp = resolve(reservation, ".import-receipt-staging");
    deadline(until);
    await writeFile(temp, completionBytes, { mode: 0o600, flag: "wx" });
    deadline(until);
    await rename(temp, completion);
  } catch (error) {
    throw error;
  }
  return result(false, completionBytes);
}

/** Process-local handle check.  Serialized JSON is never accepted as verification. */
export const isVerifiedPortableRestore = (
  value: unknown,
): value is PortableTransferImportResult =>
  !!value && typeof value === "object" && verifiedRestores.has(value as object);
/** Rehashes the published workspace and validates its completion marker before rebinding. */
export async function recheckPortableRestore(
  value: PortableTransferImportResult,
): Promise<void> {
  const saved = verifiedRestores.get(value as object);
  if (!saved)
    throw new Error("restore result was not verified by this process");
  const root = resolve(value.destinationPath),
    receipt = resolve(dirname(root), "import-receipt.json"),
    until = Date.now() + MAX_DURATION;
  if (root !== saved.root || !same(saved.rootStat, await safeDir(root)))
    throw new Error("published restore root differs");
  const markerBytes = await readRegular(
    dirname(root),
    receipt,
    MAX_METADATA,
    until,
  );
  const marker = plain(json(markerBytes, "import receipt"), "import receipt");
  if (
    digest(markerBytes) !== saved.markerDigest ||
    marker.bundleDigest !== value.bundleDigest ||
    marker.manifestDigest !== value.manifestDigest ||
    marker.ownerNamespace !== value.ownerNamespace ||
    marker.schema !== PORTABLE_TRANSFER_IMPORT_SCHEMA ||
    JSON.stringify(marker.files) !== JSON.stringify(saved.restored) ||
    marker.freshnessMode !== value.freshnessMode ||
    marker.localBranchId !== (value.localBranchId ?? null) ||
    marker.operations !== "HISTORICAL_UNRECONCILED" ||
    marker.executionCalls !== 0
  )
    throw new Error("published restore marker differs");
  await exactTree(
    root,
    value.restored.map((x) => x.restorePath),
    until,
  );
  const reps = new Map(value.manifest.representations.map((x) => [x.id, x]));
  for (const file of saved.restored) {
    const rep = reps.get(file.representationId);
    if (!rep) throw new Error("verified restore representation missing");
    const actual = await hashFile(
      root,
      resolve(root, file.restorePath),
      rep.byteLength,
      until,
    );
    if (
      actual.byteDigest !== rep.byteDigest ||
      actual.byteLength !== rep.byteLength
    )
      throw new Error("published restore bytes differ");
  }
}
