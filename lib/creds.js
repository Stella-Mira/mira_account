/**
 * mira_account / creds.js —— 凭据本体（约定8）
 *
 * 落盘：`$DSH_HOME/mira_config/mira_account/creds/<accountId>.json`，权限 600。
 * 形态（任务书功能点8）：cookie / token / qrcode 三种，字段名由平台适配器自己定，
 * mira_account 只负责**存、取、校验权限**，不理解内容。
 *
 * 铁律：
 *   · 永不回显 —— 对外只给 credsStatus()（有无、权限、kind、更新时间），不给值
 *   · 不进日志 —— 任何日志只写 accountId 与错误码，不拼 secret
 *   · 目录/文件名只允许安全字符，挡 ../ 越界
 */

import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureDir, fileMode, nowIso, readJsonStrict, writeJsonSecure,
} from './kit.mjs'
import { isValidId } from './store.js'

export const CREDS_SCHEMA = 1
export const CRED_KINDS = ['cookie', 'token', 'qrcode']

const SECRET_HINT = '凭据要手填（本插件不提供写凭据的工具，避免凭据经过会话记录）'

export function credsDir(baseDir) {
  return join(baseDir, 'creds')
}

export function credsFile(baseDir, accountId) {
  if (!isValidId(accountId)) throw Object.assign(new Error('账号 id 非法：' + JSON.stringify(accountId)), { code: 'account/invalid' })
  return join(credsDir(baseDir), accountId + '.json')
}

/**
 * 读凭据。返回 { ok:true, value:{ platform, kind, fields, updatedAt } }
 * 或 { ok:false, error:{code,message,hint} }（creds/missing、creds/invalid）。
 */
export function readCreds(baseDir, accountId, expectedPlatform) {
  let file
  try {
    file = credsFile(baseDir, accountId)
  } catch (error) {
    return { ok: false, error: { code: error.code ?? 'account/invalid', message: error.message } }
  }
  const read = readJsonStrict(file)
  if (!read.ok) {
    return {
      ok: false,
      error: {
        code: 'creds/missing',
        message: read.reason === 'missing'
          ? '凭据文件不存在：' + file
          : '凭据文件无法解析（' + read.reason + '）：' + file,
        hint: SECRET_HINT,
      },
    }
  }
  const value = read.value
  if (value.schemaVersion !== CREDS_SCHEMA) {
    return {
      ok: false,
      error: {
        code: 'config/schema',
        message: '凭据文件版本不匹配：' + file + ' 的 schemaVersion=' + JSON.stringify(value.schemaVersion) + '，要求 ' + CREDS_SCHEMA,
        hint: '按 README 重新写一份凭据文件' + '（' + SECRET_HINT + '）',
      },
    }
  }
  if (expectedPlatform && value.platform && value.platform !== expectedPlatform) {
    return {
      ok: false,
      error: {
        code: 'creds/invalid',
        message: '凭据文件平台不符：' + file + ' 是 ' + value.platform + '，账号是 ' + expectedPlatform,
        hint: SECRET_HINT,
      },
    }
  }
  if (!value.fields || typeof value.fields !== 'object' || Object.keys(value.fields).length === 0) {
    return {
      ok: false,
      error: { code: 'creds/missing', message: '凭据文件里没有 fields：' + file, hint: SECRET_HINT },
    }
  }
  return { ok: true, value }
}

/**
 * 写凭据（供迁移脚本 / 运维脚本用，不是工具）。
 * 600 落地；内容里的任何字段都不会被本模块打日志。
 */
export function writeCreds(baseDir, accountId, { platform, kind, fields, updatedAt }) {
  const file = credsFile(baseDir, accountId)
  ensureDir(credsDir(baseDir))
  const payload = {
    schemaVersion: CREDS_SCHEMA,
    platform: String(platform ?? ''),
    kind: CRED_KINDS.includes(kind) ? kind : 'token',
    fields: { ...(fields ?? {}) },
    updatedAt: updatedAt || nowIso(),
  }
  const wrote = writeJsonSecure(file, payload)
  if (!wrote) throw Object.assign(new Error('凭据写盘失败：' + file), { code: 'creds/write-failed' })
  try { chmodSync(file, 0o600) } catch { /* 平台不支持就交给 umask */ }
  return { file, mode: fileMode(file) }
}

/**
 * 凭据状态（**不含任何值**）：有没有、权限对不对、什么形态、什么时候改的。
 * 权限不是 600 时顺手修回去并回报 repaired:true（约定8 的自愈）。
 */
export function credsStatus(baseDir, accountId) {
  let file
  try {
    file = credsFile(baseDir, accountId)
  } catch {
    return { present: false, mode: -1, modeOk: false, repairFailed: true }
  }
  const read = readJsonStrict(file)
  if (!read.ok) return { present: false, mode: -1, modeOk: false, reason: read.reason }
  const mode = fileMode(file)
  const modeOk = mode === 0o600
  let repaired = false
  if (!modeOk) {
    try { chmodSync(file, 0o600); repaired = true } catch { /* 记在 repaired 之外 */ }
  }
  const value = read.value
  return {
    present: true,
    kind: value.kind ?? 'unknown',
    // 只报字段名，不报值
    fieldNames: Object.keys(value.fields ?? {}),
    updatedAt: value.updatedAt ?? null,
    mode: '0o' + (mode > 0 ? mode.toString(8) : '---'),
    modeOk: modeOk || repaired,
    repaired,
  }
}

/** 打日志前把疑似凭据抹掉（兜底，正常路径不应走到）。 */
export function redact(text) {
  return String(text ?? '')
    .replace(/(SESSDATA|bili_jct|buvid3|access[_-]?token|token|cookie|secret|password)(["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi,
      (_m, key, sep) => key + sep + '***')
}
