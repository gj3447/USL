import { test } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

const cli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, USL_HOSTNAME: os.hostname(), USL_GIT_REPOS: "{}", USL_KG_SOURCES: "{}" },
    timeout: 15_000
  }, (error, stdout, stderr) => resolve({
    code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
    stdout,
    stderr
  }))
})

test("root help exposes every command family on stdout", async () => {
  const result = await cli(["--help"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.match(result.stdout, /USL/)
  for (const family of ["core", "platform", "adapter", "capability", "host", "legacy"]) {
    assert.match(result.stdout, new RegExp(`\\b${family}\\b`))
  }
})

test("family help lists only its registered commands and needs no input", async () => {
  const core = await cli(["help", "core"])
  assert.equal(core.code, 0, core.stderr)
  assert.equal(core.stderr, "")
  for (const command of ["check", "compile", "context", "observe", "project"]) {
    assert.match(core.stdout, new RegExp(`\\busl ${command}\\b`))
  }
  assert.doesNotMatch(core.stdout, /\busl init\b/)

  const platform = await cli(["help", "platform"])
  assert.equal(platform.code, 0, platform.stderr)
  assert.match(platform.stdout, /\busl init\b/)
  assert.match(platform.stdout, /\busl mcp\b/)
  assert.doesNotMatch(platform.stdout, /\busl capability-discover\b/)

  const host = await cli(["help", "host"])
  assert.equal(host.code, 0, host.stderr)
  assert.match(host.stdout, /\busl cli-run\b/)

  const adapter = await cli(["help", "adapter"])
  assert.equal(adapter.code, 0, adapter.stderr)
  assert.match(adapter.stdout, /\busl adapt\b/)

  const capability = await cli(["help", "capability"])
  assert.equal(capability.code, 0, capability.stderr)
  assert.match(capability.stdout, /\busl capability-discover\b/)

  const legacy = await cli(["help", "legacy"])
  assert.equal(legacy.code, 0, legacy.stderr)
  assert.match(legacy.stdout, /\busl pierce\b/)
  assert.match(legacy.stdout, /\busl audit\b/)
})

test("command help is shared by help topic and --help, including project forms", async () => {
  const topic = await cli(["help", "project"])
  const flag = await cli(["project", "--help"])
  assert.equal(topic.code, 0, topic.stderr)
  assert.equal(flag.code, 0, flag.stderr)
  assert.equal(topic.stderr, "")
  assert.equal(flag.stderr, "")
  assert.equal(topic.stdout, flag.stdout)
  assert.match(topic.stdout, /--source FILE\.usl/)
  assert.match(topic.stdout, /--records FILE/)
  assert.match(topic.stdout, /--bundle-uid UID/)
  assert.match(topic.stdout, /--utterance-file FILE/)
})

test("representative commands in every family use their shared command contract", async () => {
  for (const command of ["context", "init", "adapt", "capability-discover", "cli-run", "audit"]) {
    const topic = await cli(["help", command])
    const flag = await cli([command, "--help"])
    assert.equal(topic.code, 0, `${command}: ${topic.stderr}`)
    assert.equal(flag.code, 0, `${command}: ${flag.stderr}`)
    assert.equal(topic.stdout, flag.stdout, command)
    assert.match(topic.stdout, new RegExp(`usl ${command}\\b`))
  }
})

test("help short-circuits command input and process-starting families", async () => {
  const checks = [
    ["check", "--source", "/definitely/missing.usl", "--help"],
    ["watch", "--source", "/definitely/missing.usl", "--help"],
    ["mcp", "--help"],
    ["cli-run", "--help"]
  ]
  for (const args of checks) {
    const result = await cli(args)
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`)
    assert.equal(result.stderr, "")
    assert.match(result.stdout, /Usage:|usl /)
  }
})

test("invalid help topics and arity remain usage errors", async () => {
  for (const args of [["help", "missing"], ["help", "core", "extra"], ["--help", "core"], ["missing", "--help"], []]) {
    const result = await cli(args)
    assert.equal(result.code, 64, `${args.join(" ")}: ${result.stderr}`)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /Usage|Unknown|help/i)
  }
})
