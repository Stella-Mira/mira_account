/**
 * mira_* 插件共享小工具（**规范源**）
 *
 * 用法：本文件是唯一真身；各插件里 `<plugin>/lib/kit.mjs` 是它的**逐字节副本**。
 *   改这里 → 复制到各插件 → 跑 `node tool_shared/tools/check-kit.mjs` 确认无漂移。
 *
 * 为什么是复制而不是共享包：
 *   插件以 `link:` 方式装进 profile，跨包相对 import（`../kit/...`）在链接场景下会指向
 *   包外路径，随安装方式不同而失效。复制 100 行换来「每个插件可独立装入」，
 *   代价用哈希检查兜住。零第三方依赖：只用 node: 内置。
 */

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 协议版本：不兼容改动时 +1（同时要更新 check-kit 的期望值）。 */
export const KIT_VERSION = 1

/* ── 路径 ───────────────────────────────────────────────────── */

/**
 * DSH 数据根目录，与宿主自己的规则一致：`$DSH_HOME`（trim 后非空）> `~/.dsh`。
 * 任务书约定1：配置与状态一律放 `$DSH_HOME/mira_config/<plugin>/`。
 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/** `<DSH_HOME>/mira_config/<plugin>`（不创建，只算路径）。 */
export function miraConfigDir(plugin) {
  return join(dshHome(), 'mira_config', plugin)
}

/** 建目录（递归），返回该目录。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ── JSON 落盘（原子写 + 可选 600） ─────────────────────────── */

/**
 * 原子写 JSON：先写 `<file>.tmp` 再 rename。落盘失败不抛（调用方决定怎么记日志），
 * 返回 true/false，避免「写盘失败把整个插件带崩」。
 */
export function writeJsonAtomic(file, value, options = {}) {
  // tmp 名必须唯一：固定 `file + '.tmp'` 时，两个进程/两个实例同时写会互相撕坏，
  // 读方就可能读到半截 JSON（rename 把一个写了一半的 tmp 搬上位）。
  const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8)
  try {
    ensureDir(dirname(file))
    const text = JSON.stringify(value, null, 2) + '\n'
    // 写 → fsync → rename → fsync 目录。
    // 只 rename 不 fsync 时，断电可能留下"文件名换了、内容是空的/半截"；目录不 fsync，rename 本身也可能丢。
    const mode = options.mode || 0o644
    const fd = openSync(tmp, 'w', mode)
    try {
      writeSync(fd, text, null, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (options.mode) {
      try { chmodSync(tmp, options.mode) } catch { /* 平台不支持就交给 umask */ }
    }
    renameSync(tmp, file)
    try {
      const dfd = openSync(dirname(file), 'r')
      try { fsyncSync(dfd) } finally { closeSync(dfd) }
    } catch { /* 有的平台不支持对目录 fsync：忽略 */ }
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* 没写出来就没得删 */ }
    return false
  }
}

/** 凭据类文件：内容 600 落地（约定8）。 */
export function writeJsonSecure(file, value) {
  return writeJsonAtomic(file, value, { mode: 0o600 })
}

/** 宽松读：文件坏/缺都返回 fallback，只在调用方明确能容错时用。 */
export function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw ?? fallback
  } catch {
    return fallback
  }
}

/** 严格读：区分「没有」与「坏了」，供 schemaVersion 校验用。 */
export function readJsonStrict(file) {
  if (!existsSync(file)) return { ok: false, reason: 'missing' }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, reason: 'corrupt', detail: error?.message ?? String(error) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-object' }
  }
  return { ok: true, value: raw }
}

/** 文件权限位（八进制），取不到返回 -1。 */
export function fileMode(file) {
  try { return statSync(file).mode & 0o777 } catch { return -1 }
}

/**
 * schemaVersion 校验（约定7：不匹配拒绝启动并给迁移提示，不静默兼容）。
 * 返回 { ok:true, value } 或 { ok:false, error:{code,message,hint} }。
 */
export function checkSchema(raw, expected, file) {
  const found = raw && raw.schemaVersion
  if (found === expected) return { ok: true, value: raw }
  return {
    ok: false,
    error: fail(
      'config/schema',
      '配置文件版本不匹配：' + file + ' 里 schemaVersion=' + JSON.stringify(found) + '，本代码要求 ' + expected,
      '按 README「迁移」一节转换后重试；旧文件先备份。不会静默兼容。',
    ),
  }
}

/* ── 错误与返回值（约定4） ─────────────────────────────────── */

/** 带归一错误码的异常：工具层统一转成 { ok:false, error:{code,message,hint} }。 */
export class MiraError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'MiraError'
    this.code = code
    this.hint = hint
  }
}

/** 造一个错误对象（不是抛出）。 */
export function fail(code, message, hint) {
  const error = { code: String(code), message: String(message ?? '') }
  if (hint) error.hint = String(hint)
  return { ok: false, error }
}

export function okObj(extra) {
  return { ok: true, ...(extra ?? {}) }
}

/** 把异常归一成错误对象：MiraError 保留 code/hint，其余按 unknown/ 兜底。 */
export function toError(error, fallbackCode = 'unknown/error', fallbackHint = '') {
  if (error instanceof MiraError) return fail(error.code, error.message, error.hint)
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return fail(error.code, error.message, error.hint)
  }
  return fail(fallbackCode, error && error.message ? error.message : String(error), fallbackHint)
}

/** 供工具 execute 用：同步/异步皆可，永远返回 JSON 文本（不抛）。 */
export function runTool(fn) {
  return async (args, exec) => {
    try {
      const value = await fn(args ?? {}, exec)
      if (typeof value === 'string') return value
      return JSON.stringify(value ?? okObj(), null, 2)
    } catch (error) {
      return JSON.stringify(toError(error), null, 2)
    }
  }
}

/** 统一形状的工具定义（text 输出，JSON 文本）。 */
export function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: runTool(execute),
  }
}

/* ── 小工具 ─────────────────────────────────────────────────── */

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export function isEmptyValue(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** 必备配置项校验（约定2）：空 → config/missing，禁止自动探测。 */
export function requireConfig(value, key, fileHint) {
  if (!isEmptyValue(value)) return { ok: true, value }
  throw new MiraError('config/missing', '必备配置项为空：' + key,
    '在 ' + fileHint + ' 里手填 ' + key + '（本插件不自动探测）')
}

export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString()
}

/** 本地 HH:MM。 */
export function fmtLocalHHMM(ts = Date.now()) {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/* ── 单实例保护（约定6） ─────────────────────────────────────── */

const INSTANCE_KEY = Symbol.for('mira.plugin.instances.v1')

function instanceRegistry() {
  const g = globalThis
  if (!Object.prototype.hasOwnProperty.call(g, INSTANCE_KEY)) {
    Object.defineProperty(g, INSTANCE_KEY, { value: new Map(), enumerable: false, configurable: false, writable: false })
  }
  return g[INSTANCE_KEY]
}

/**
 * 认领唯一实例：同 id 已在跑 → { ok:false, holder }；成功 → { ok:true, release() }。
 * 用 globalThis 上的 Symbol 注册表，模块被重复求值时也挡得住。
 */
export function claimInstance(name) {
  const registry = instanceRegistry()
  const holder = registry.get(name)
  if (holder) return { ok: false, holder }
  const token = randomUUID()
  registry.set(name, { token, at: Date.now(), pid: process.pid })
  return {
    ok: true,
    token,
    release() {
      const current = registry.get(name)
      if (current && current.token === token) registry.delete(name)
    },
  }
}

/* ── 计数与日志（约定5） ─────────────────────────────────────── */

/** 极简计数器：错误按 code 计数，status 里可见。 */
export function makeCounters() {
  const map = new Map()
  return {
    bump(key, delta = 1) {
      map.set(key, (map.get(key) || 0) + delta)
      return map.get(key)
    },
    get(key) {
      return map.get(key) || 0
    },
    snapshot() {
      return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    },
    reset() {
      map.clear()
    },
  }
}

/** 打一行 warn 并计数。 */
export function warnCount(logger, counters, code, message) {
  counters?.bump(code)
  logger?.warn?.('[' + (counters?.pluginName || 'mira') + '] ' + code + '：' + message)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
