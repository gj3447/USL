import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const files = (await fs.readdir("src", { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => path.join("src", name))
files.push("package.json", "package-lock.json", "tsconfig.json")
const entries = await Promise.all(files.sort().map(async (file) => ({ file, digest: hash(await fs.readFile(file)) })))
const manifest = { schema: "usl-adversarial-source-manifest/v1", capturedAt: new Date().toISOString(), sourceDigest: hash(JSON.stringify(entries)), files: entries }
await fs.writeFile("audit/source-manifest.json", JSON.stringify(manifest, null, 2) + "\n")
console.log(JSON.stringify({ sourceDigest: manifest.sourceDigest, files: entries.length }))
