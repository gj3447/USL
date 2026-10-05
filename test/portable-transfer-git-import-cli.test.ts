import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { cleanGitFixture, gitFixtureCommand as git } from "./clean-git-fixture.js"
const execFile = promisify(execFileCallback)
const cli = (...args: string[]) => execFile(process.execPath, ["--import", "tsx", "scripts/usl-git-import.ts", ...args], { cwd: resolve(import.meta.dirname, ".."), timeout: 30_000 })

test("CP02-1: standalone import CLI restores native Git data without source or original backup", async t => {
  const fx = await cleanGitFixture(t)
  const specPath = join(fx.root, "import.json")
  const { destinationParent, destinationName, ...spec } = fx.request
  await writeFile(specPath, JSON.stringify(spec))
  await rm(fx.source, { recursive: true })
  const response = await cli("--spec", specPath, "--destination-parent", destinationParent, "--destination-name", destinationName)
  const result = JSON.parse(response.stdout)
  await rm(fx.backup, { recursive: true })
  assert.equal(response.stderr, "")
  assert.equal(git(join(result.destinationPath, "worktrees/main"), "rev-parse", "HEAD"), fx.head)
  assert.equal(await readFile(join(result.destinationPath, "worktrees/main/note.txt"), "utf8"), "memory\n")
  assert.equal(result.execution, "NOT_REQUESTED")
  assert.equal(result.authority, "NOT_GRANTED")
})

test("CP02-2: import CLI refuses spec-selected destinations, unsafe spec files and unknown flags", async t => {
  assert.match((await cli("--help")).stdout, /--destination-name NAME/)
  await assert.rejects(cli("--whatever"), /usage/)
  const fx = await cleanGitFixture(t), path = join(fx.root, "import.json")
  const run = (spec: string) => cli("--spec", spec, "--destination-parent", fx.output, "--destination-name", "restored")
  await writeFile(path, JSON.stringify(fx.request))
  await assert.rejects(run(path), /caller flag/)
  const linked = join(fx.root, "linked.json")
  await symlink(path, linked)
  await assert.rejects(run(linked), /regular non-symlink/)
  const fifo = join(fx.root, "fifo")
  await execFile("mkfifo", [fifo])
  await assert.rejects(run(fifo), /regular non-symlink/)
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1))
  await assert.rejects(run(path), /2 MiB/)
  await writeFile(path, Buffer.from([0xff]))
  await assert.rejects(run(path), /encoded data|encoding/i)
  assert.deepEqual(await readdir(fx.output), [])
})
