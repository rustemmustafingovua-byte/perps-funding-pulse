/**
 * Process state. With DATA_FILE unset, everything stays in memory.
 * With DATA_FILE set, keys, quotas, webhooks, and spent payment ids are
 * written atomically so a restart cannot resell a transaction.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

function empty() {
  return {
    keys: [],
    usage: [],
    ipUsage: [],
    webhooks: [],
    payments: [],
    quotas: [],
  }
}

let data = empty()
let file = null
let ready = false
let spent = new Set()

function adopt(next, nextFile) {
  data = next
  file = nextFile
  ready = true
  spent = new Set((data.payments || []).map((id) => String(id).toLowerCase()))
}

export function resetStore() {
  ready = false
  file = null
  data = empty()
  spent = new Set()
}

export function initStore(nextFile = process.env.DATA_FILE || "") {
  if (ready && nextFile === file) return data
  const next = empty()
  if (nextFile) {
    try {
      const parsed = JSON.parse(readFileSync(nextFile, "utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("state file is not an object")
      }
      for (const key of Object.keys(next)) {
        if (parsed[key] != null && !Array.isArray(parsed[key])) {
          throw new Error(`state file field ${key} is not an array`)
        }
        if (Array.isArray(parsed[key])) next[key] = parsed[key]
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`cannot read state file ${nextFile}: ${error.message}`)
      }
    }
  }
  adopt(next, nextFile)
  return data
}

export function snapshot() {
  return initStore()
}

export function save() {
  initStore()
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

export function hasPayment(id) {
  initStore()
  return spent.has(String(id).toLowerCase())
}

/** Record a payment id. Returns false when that id was already spent. */
export function claimPayment(id) {
  initStore()
  const key = String(id).toLowerCase()
  if (!key || spent.has(key)) return false
  spent.add(key)
  data.payments.push(key)
  save()
  return true
}
