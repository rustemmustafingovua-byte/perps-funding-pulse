import { readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

function files(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path))
    else if (name.endsWith(".js")) out.push(path)
  }
  return out
}

const targets = [...files("src"), ...files("test"), ...files("scripts")].filter((file) => file !== "scripts/check-syntax.js")
targets.push("scripts/check-syntax.js")
let failed = false
for (const file of targets) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" })
  if (result.status !== 0) failed = true
}
if (failed) process.exit(1)
console.log(`syntax ok (${targets.length} files)`)
