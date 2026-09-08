import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"

const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const manifest = JSON.parse(await fs.readFile("audit/source-manifest.json", "utf8")) as {
  sourceDigest: string; files: Array<{ file: string; digest: string }>
}
const paths = (await fs.readdir("src", { recursive: true }))
  .filter((name) => name.endsWith(".ts")).map((name) => path.join("src", name))
paths.push("package.json", "package-lock.json", "tsconfig.json")
const files = await Promise.all(paths.sort().map(async (file) => ({ file, digest: hash(await fs.readFile(file)) })))
const currentDigest = hash(JSON.stringify(files))
const result = {
  verifiedAt: new Date().toISOString(), expectedDigest: manifest.sourceDigest, currentDigest,
  files: files.length,
  matches: currentDigest === manifest.sourceDigest && JSON.stringify(files) === JSON.stringify(manifest.files),
}
await fs.writeFile("audit/source-verification.json", JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
if (!result.matches) process.exitCode = 1
