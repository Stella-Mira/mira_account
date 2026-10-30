/**
 * mira_account / store.js —— 账号池 + 绑定表的落盘与内存镜像
 *
 * 落盘（任务书 §mira_account）：
 *   accounts.json  { schemaVersion, accounts:[account...] }
 *   bindings.json  { schemaVersion, bindings:[binding...] }
 *
 * 容错口径（刻意不对称，理由见 README「已知取舍」）：
 *   · accounts.json 坏 / 版本不符 → **致命**：不静默清空账号池（清了就等于把所有绑定一起废掉）
 *   · bindings.json 坏 / 版本不符 → 丢弃重建并 warn：任务书写明「绑定表可从 accounts 重建，坏了不致命」
 */

import { renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkSchema, fail, nowIso, readJsonStrict, writeJsonAtomic,
} from './kit.mjs'

export const ACCOUNTS_SCHEMA = 1
export const BINDINGS_SCHEMA = 1

export const PLATFORMS = ['qq', 'wx', 'bilibili', 'vtuber']
export const KINDS = ['user', 'group', 'channel', 'room', 'avatar']
/**
 * 每个平台真正会出现的 peer 类型。
 * 没有它的后果：给 bilibili 绑一个 `group` 也返回 ok，但那条线永远不会有入站（也没人告诉调用方绑错了）。
 */
export const PLATFORM_KINDS = {
  qq: ['user', 'group', 'channel'],
  wx: ['user', 'group'],
  bilibili: ['user', 'room'],
  // vtuber：peer = 形象本身（avatar，通常 peerId='main'）。
  // 会话是**绑定的主体**（sessionId），不是 peer —— 否则每个会话都是自己 peer 的 taker，
  // 永远不会冲突，权限模型就废了。
  vtuber: ['avatar'],
}
/**
 * 本地虚拟平台：账号存在、但没有对外连接（也不需要适配器去 connect）。
 * 判断用途例如"要不要在 addAccount 后去连"、"state 该不该是 online"。
 */
export const VIRTUAL_PLATFORMS = ['vtuber']
export const isVirtualPlatform = (platform) => VIRTUAL_PLATFORMS.includes(String(platform ?? '').trim())
export const BINDING_MODES = ['taker', 'observer']
export const INBOUND_POLICIES = ['create', 'default', 'drop']
export const ACCOUNT_STATES = ['online', 'offline', 'error']

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/** peerId / accountId 一律按字符串比：QQ 号是数字，B 站 mid 是数字，群号是数字，房间号是数字。 */
/** kind 归一：入站可能给 'Group'、工具走小写化；不归一会出现同 peer 两行、绕过单 taker 约束。 */
export function normKind(kind) {
  return String(kind ?? '').trim().toLowerCase()
}

export function normPeerId(peerId) {
  if (peerId === undefined || peerId === null) return ''
  return String(peerId).trim()
}

/** 绑定唯一键（accountId + kind + peerId 三者定一个 peer）。 */
export function peerKey(accountId, kind, peerId) {
  return String(accountId) + '|' + String(kind) + '|' + normPeerId(peerId)
}

export class Store {
  constructor(baseDir) {
    this.base = baseDir
    this.accountsFile = join(baseDir, 'accounts.json')
    this.bindingsFile = join(baseDir, 'bindings.json')
    /** accounts.json 的加载错误（致命，由 index.js 决定降级方式） */
    this.fatalError = null
    /** bindings.json 的加载问题（非致命，只记录） */
    this.bindingWarning = null
    /** 最近一次写盘失败（工具/status 要能看见；内存里的改动此时还没落盘） */
    this.writeError = null
    this.logger = null
    this.accounts = []
    this.bindings = []
  }

  /* ── 加载 ─────────────────────────────────────────────── */

  load(logger) {
    this.logger = logger ?? null
    this.writeError = null
    this.accounts = []
    this.bindings = []
    this.fatalError = null
    this.bindingWarning = null

    let accountsFileUsable = false // 账号池是否可信（决定能不能用它来清理绑定）
    const accountsRead = readJsonStrict(this.accountsFile)
    if (!accountsRead.ok) {
      if (accountsRead.reason === 'missing') {
        // 首次加载：文件不存在是正常起点（约定2 的空配置口径），不是错误
        this.accounts = []
      } else {
        this.fatalError = fail('config/schema',
          'accounts.json 无法解析（' + accountsRead.reason + '）：' + this.accountsFile,
          '先备份该文件，按 README 修复或删除后重新登记账号；不会静默清空账号池')
        logger?.warn?.('[mira_account] ' + this.fatalError.error.message)
      }
    } else {
      const check = checkSchema(accountsRead.value, ACCOUNTS_SCHEMA, this.accountsFile)
      if (!check.ok) {
        this.fatalError = check.error
        logger?.warn?.('[mira_account] ' + check.error.error.message)
      } else {
        accountsFileUsable = true
        const rows = (accountsRead.value.accounts ?? []).filter((a) => a && isValidId(a.id))
        // 平台必须在白名单里：platform 会被拼进去重表文件名，且决定用哪个 adapter
        const kept = []
        for (const row of rows) {
          if (!PLATFORMS.includes(row.platform)) {
            this.bindingWarning = (this.bindingWarning ? this.bindingWarning + '；' : '')
              + '账号 ' + row.id + ' 的 platform=' + JSON.stringify(row.platform) + ' 不在 ' + PLATFORMS.join('/') + '，已跳过'
            logger?.warn?.('[mira_account] ' + this.bindingWarning)
            continue
          }
          kept.push(this.#normalizeAccount(row))
        }
        this.accounts = kept
      }
    }

    const bindingsRead = readJsonStrict(this.bindingsFile)
    if (bindingsRead.ok) {
      const check = checkSchema(bindingsRead.value, BINDINGS_SCHEMA, this.bindingsFile)
      if (check.ok) {
        this.bindings = (bindingsRead.value.bindings ?? [])
          .filter((b) => b && b.sessionId && isValidId(b.accountId))
          .map((b) => ({ ...b, kind: normKind(b.kind) }))
      } else {
        this.bindingWarning = check.error.error.message + '（已丢弃并按空表重建；坏文件已改名保留）'
        this.#quarantine(this.bindingsFile)
      }
    } else if (bindingsRead.reason !== 'missing') {
      this.bindingWarning = 'bindings.json 无法解析（' + bindingsRead.reason + '），已丢弃并按空表重建（坏文件已改名保留）'
      this.#quarantine(this.bindingsFile)
    }
    if (this.bindingWarning) logger?.warn?.('[mira_account] ' + this.bindingWarning)

    // 悬空绑定：账号已不存在的行（旧版本删账号没级联 / 手改文件 / 在途 createSession 赛跑）
    // 留着会在"用同一个 id 重新登记账号"时立刻复活，把新账号的入站路由到旧会话（跨身份串线）。
    //
    // **但**：只有账号池本身可信时才清理。accounts.json 坏掉/版本不符时 this.accounts 是空的，
    // 照空池清理会把 bindings.json 全删并落盘 —— 那等于用一个坏文件的错误去毁掉另一个好文件。
    const accountsTrusted = !this.fatalError && accountsFileUsable
    const knownAccounts = new Set(this.accounts.map((a) => a.id))
    const before = this.bindings.length
    if (accountsTrusted) {
      this.bindings = this.bindings.filter((b) => knownAccounts.has(b.accountId))
      if (this.bindings.length !== before) {
        const dropped = before - this.bindings.length
        this.bindingWarning = (this.bindingWarning ? this.bindingWarning + '；' : '')
          + '丢弃 ' + dropped + ' 条指向已不存在账号的绑定'
        logger?.warn?.('[mira_account] ' + this.bindingWarning)
        try { this.saveBindings() } catch { /* writeError 已记 */ }
      }
    } else if (this.bindings.length > 0) {
      this.bindingWarning = (this.bindingWarning ? this.bindingWarning + '；' : '')
        + '账号池当前不可用，**未**清理绑定表（共 ' + this.bindings.length + ' 条，原样保留）'
      logger?.warn?.('[mira_account] ' + this.bindingWarning)
    }

    this.#enforceSingleTaker(logger)
    return this
  }

  #normalizeAccount(raw) {
    const now = nowIso()
    return {
      id: raw.id,
      platform: PLATFORMS.includes(raw.platform) ? raw.platform : String(raw.platform ?? ''),
      label: typeof raw.label === 'string' ? raw.label : raw.id,
      enabled: raw.enabled !== false,
      state: ACCOUNT_STATES.includes(raw.state) ? raw.state : 'offline',
      error: raw.error ?? null,
      // 任务书功能点5：无绑定时按账号 inboundPolicy 处理
      inboundPolicy: INBOUND_POLICIES.includes(raw.inboundPolicy) ? raw.inboundPolicy : 'create',
      defaultSessionId: typeof raw.defaultSessionId === 'string' ? raw.defaultSessionId : '',
      createdAt: raw.createdAt || now,
      lastLoginAt: raw.lastLoginAt ?? null,
    }
  }

  /** 同 peer 出现多个 taker（手改文件 / 旧数据）：保留 updatedAt 最新的那个，其余降级 observer。 */
  #enforceSingleTaker(logger) {
    let changed = false
    const seen = new Map()
    for (const binding of this.bindings) {
      if (binding.mode !== 'taker') continue
      const key = peerKey(binding.accountId, binding.kind, binding.peerId)
      const prev = seen.get(key)
      if (!prev) {
        seen.set(key, binding)
        continue
      }
      const prevAt = Date.parse(prev.updatedAt || prev.createdAt || 0) || 0
      const curAt = Date.parse(binding.updatedAt || binding.createdAt || 0) || 0
      const loser = curAt >= prevAt ? prev : binding
      const winner = loser === prev ? binding : prev
      loser.mode = 'observer'
      loser.updatedAt = nowIso()
      seen.set(key, winner)
      logger?.warn?.('[mira_account] 同一 peer 出现多个 taker，已把 ' + loser.sessionId + ' 降级为 observer（' + winner.sessionId + ' 保留 taker）')
      changed = true
    }
    if (changed) {
      try { this.saveBindings() } catch { /* 落盘失败已记 writeError，下次改动会再试 */ }
    }
  }

  /** 坏文件改名保留（绝不直接覆盖：那等于把用户的数据当垃圾丢掉）。 */
  #quarantine(file) {
    try {
      renameSync(file, file + '.corrupt.' + new Date().toISOString().replace(/[:.]/g, '-'))
    } catch (error) {
      this.logger?.warn?.('[mira_account] 坏文件改名失败：' + file + '（' + (error?.message ?? error) + '）')
    }
  }

  /* ── 保存 ─────────────────────────────────────────────── */

  /**
   * 落盘。**失败必须可见**：以前这里返回布尔、调用方全部忽略，
   * 结果是一次失败只留下一句日志，工具仍报 ok:true，重启后"刚做的绑定没了"。
   * 现在：失败记 `writeError` 并抛（setState 这种不该打断流程的地方自己 catch）。
   */
  #persist(file, payload) {
    const ok = writeJsonAtomic(file, payload)
    if (ok) {
      this.writeError = null
      return true
    }
    this.writeError = {
      code: 'config/write-failed',
      message: '写盘失败：' + file,
      hint: '检查目录权限与磁盘空间。这次改动**只在内存里**，重启会丢；修好后随便做一次改动就会重新落盘',
      at: nowIso(),
    }
    this.logger?.warn?.('[mira_account] ' + this.writeError.message)
    throw Object.assign(new Error(this.writeError.message), { code: 'config/write-failed', hint: this.writeError.hint })
  }

  saveAccounts() {
    return this.#persist(this.accountsFile, { schemaVersion: ACCOUNTS_SCHEMA, accounts: this.accounts })
  }

  saveBindings() {
    return this.#persist(this.bindingsFile, { schemaVersion: BINDINGS_SCHEMA, bindings: this.bindings })
  }

  /* ── 账号池 ───────────────────────────────────────────── */

  listAccounts() {
    return this.accounts.map((a) => ({ ...a }))
  }

  getAccount(id) {
    return this.accounts.find((a) => a.id === id) ?? null
  }

  hasAccount(id) {
    return this.accounts.some((a) => a.id === id)
  }

  addAccount(input) {
    const id = String(input?.id ?? '').trim()
    if (!isValidId(id)) {
      throw Object.assign(new Error('账号 id 非法：' + JSON.stringify(input?.id)), {
        code: 'account/invalid', hint: 'id 只允许字母数字与 . _ -，长度 1–64，例如 qq-main',
      })
    }
    if (this.hasAccount(id)) {
      throw Object.assign(new Error('账号已存在：' + id), { code: 'account/exists', hint: '换一个 id，或先删除旧账号' })
    }
    const platform = String(input?.platform ?? '').trim()
    if (!PLATFORMS.includes(platform)) {
      throw Object.assign(new Error('平台不支持：' + JSON.stringify(input?.platform)), {
        code: 'platform/unsupported', hint: '当前支持 ' + PLATFORMS.join(' / '),
      })
    }
    const policy = input?.inboundPolicy ?? 'create'
    if (!INBOUND_POLICIES.includes(policy)) {
      throw Object.assign(new Error('inboundPolicy 非法：' + JSON.stringify(policy)), {
        code: 'account/invalid', hint: '可选 ' + INBOUND_POLICIES.join(' / '),
      })
    }
    const account = this.#normalizeAccount({
      id,
      platform,
      label: input?.label,
      enabled: input?.enabled !== false,
      state: 'error',
      error: { code: 'creds/missing', message: '账号刚登记，凭据文件还没有' },
      inboundPolicy: policy,
      defaultSessionId: input?.defaultSessionId,
      createdAt: nowIso(),
      lastLoginAt: null,
    })
    this.accounts.push(account)
    this.saveAccounts()
    return { ...account }
  }

  removeAccount(id) {
    const account = this.getAccount(id)
    if (!account) return { ok: false, code: 'account/not-found' }
    this.accounts = this.accounts.filter((a) => a.id !== id)
    const removedBindings = this.bindings.filter((b) => b.accountId === id).length
    this.bindings = this.bindings.filter((b) => b.accountId !== id)
    this.saveAccounts()
    this.saveBindings()
    return { ok: true, removedBindings }
  }

  setEnabled(id, enabled) {
    const account = this.getAccount(id)
    if (!account) throw Object.assign(new Error('账号不存在：' + id), { code: 'account/not-found', hint: '先 mira_account_list 看有哪些账号' })
    account.enabled = !!enabled
    this.saveAccounts()
    return { ...account }
  }

  /** 适配器回报的状态（online/offline/error + 错误对象）。 */
  setState(id, state, error = null) {
    const account = this.getAccount(id)
    if (!account) return null
    account.state = ACCOUNT_STATES.includes(state) ? state : 'error'
    account.error = error
    if (state === 'online') account.lastLoginAt = nowIso()
    // 连上/断开是适配器回报的，不该因为一次写盘失败把连接流程打断；失败会记在 writeError 里
    try { this.saveAccounts() } catch { /* writeError 已记 */ }
    return { ...account }
  }

  /* ── 绑定表 ───────────────────────────────────────────── */

  findBindings(query = {}) {
    return this.bindings.filter((b) => {
      if (query.sessionId !== undefined && b.sessionId !== query.sessionId) return false
      if (query.accountId !== undefined && b.accountId !== query.accountId) return false
      if (query.kind !== undefined && normKind(b.kind) !== normKind(query.kind)) return false
      if (query.peerId !== undefined && normPeerId(b.peerId) !== normPeerId(query.peerId)) return false
      if (query.mode !== undefined && b.mode !== query.mode) return false
      return true
    })
  }

  /** 双向可查：resolve(accountId, kind, peerId) → { taker, observers }。 */
  resolve(accountId, kind, peerId) {
    const rows = this.findBindings({ accountId, kind, peerId })
    return {
      taker: rows.find((b) => b.mode === 'taker') ?? null,
      observers: rows.filter((b) => b.mode === 'observer'),
    }
  }

  upsertBinding({ sessionId, accountId, kind, peerId, mode, boundBy = '' }) {
    kind = normKind(kind)
    // 账号不存在就别写绑定：删除账号与在途 createSession 赛跑时，否则会留下悬空绑定，
    // 以后用同一个 id 重新登记账号时旧绑定立刻"复活"（跨身份串线）
    if (!this.getAccount(accountId)) {
      throw Object.assign(new Error('账号不存在：' + accountId), {
        code: 'account/not-found',
        hint: '账号可能刚被删除；先 mira_account_list 确认，再决定是否重建',
      })
    }
    // 不变式：同一 peer 只允许一个 taker。以前只在**加载时**修补（#enforceSingleTaker），
    // 于是并发建会话会在内存里留下两个 taker、只有下次重启才被降级。这里在写入处直接拒绝。
    if (mode === 'taker') {
      const other = this.bindings.find((b) => b.mode === 'taker'
        && b.accountId === accountId
        && normKind(b.kind) === normKind(kind)
        && normPeerId(b.peerId) === normPeerId(peerId)
        && b.sessionId !== sessionId)
      if (other) {
        throw Object.assign(new Error('该 peer 已有 taker：' + other.sessionId), {
          code: 'binding/conflict',
          hint: '先 mira_account_bindings 确认这条线是不是该由你接管。确实要接管才用 force:true'
            + '（旧 taker 会降级成旁听、不再自动回复）；只想跟着看用 observer:true',
        })
      }
    }
    const now = nowIso()
    const existing = this.bindings.find((b) => b.sessionId === sessionId
      && b.accountId === accountId
      && normKind(b.kind) === normKind(kind)
      && normPeerId(b.peerId) === normPeerId(peerId))
    if (existing) {
      existing.mode = mode
      existing.updatedAt = now
      if (boundBy) existing.boundBy = String(boundBy)
      this.saveBindings()
      return { binding: { ...existing }, created: false }
    }
    const binding = {
      sessionId, accountId, kind, peerId: normPeerId(peerId), mode, createdAt: now, updatedAt: now,
      // 审计：谁发起的这条绑定（工具调用方会话；入站自动登记时为空）
      ...(boundBy ? { boundBy: String(boundBy) } : {}),
    }
    this.bindings.push(binding)
    this.saveBindings()
    return { binding: { ...binding }, created: true }
  }

  /**
   * 原子地把 peer 的 taker 换成 sessionId（force 时旧 taker 降级 observer）。
   * 以前是 overrideTaker + upsertBinding **两次写盘**：中间崩掉会留下"没有 taker"的哑火状态
   * （内存里已降级、磁盘上只写了降级），而且第二次写失败时内存与磁盘不一致。
   */
  bindTaker({ sessionId, accountId, kind, peerId, boundBy = '', force = false }) {
    kind = normKind(kind)
    if (!this.getAccount(accountId)) {
      throw Object.assign(new Error('账号不存在：' + accountId), {
        code: 'account/not-found',
        hint: '账号可能刚被删除；先 mira_account_list 确认',
      })
    }
    const now = nowIso()
    const norm = normPeerId(peerId)
    const rows = this.bindings.filter((b) => b.accountId === accountId && normKind(b.kind) === normKind(kind) && normPeerId(b.peerId) === norm)
    const others = rows.filter((b) => b.sessionId !== sessionId && b.mode === 'taker')
    if (others.length > 0 && !force) {
      throw Object.assign(new Error('该 peer 已有 taker：' + others[0].sessionId), {
        code: 'binding/conflict',
        hint: '先 mira_account_bindings 确认这条线是不是该由你接管；确实要接管才用 force:true'
          + '（旧 taker 会降级成旁听、不再自动回复）；只想跟着看用 observer:true',
      })
    }
    const demoted = []
    for (const row of others) {
      row.mode = 'observer'
      row.updatedAt = now
      demoted.push(row.sessionId)
    }
    const own = rows.find((b) => b.sessionId === sessionId)
    if (own) {
      own.mode = 'taker'
      own.updatedAt = now
      if (boundBy) own.boundBy = String(boundBy)
    } else {
      this.bindings.push({
        sessionId, accountId, kind, peerId: norm, mode: 'taker', createdAt: now, updatedAt: now,
        ...(boundBy ? { boundBy: String(boundBy) } : {}),
      })
    }
    this.saveBindings() // 唯一一次写盘
    return { demoted }
  }

  /** 把某个 peer 的 taker 换成指定会话（force 抢答时用）：原 taker 降级 observer 或直接被删。 */
  overrideTaker({ sessionId, accountId, kind, peerId, demote = false }) {
    kind = normKind(kind)
    const now = nowIso()
    const rows = this.findBindings({ accountId, kind, peerId, mode: 'taker' })
    for (const row of rows) {
      if (row.sessionId === sessionId) continue
      if (demote) {
        row.mode = 'observer'
        row.updatedAt = now
      } else {
        this.bindings = this.bindings.filter((b) => b !== row)
      }
    }
    this.saveBindings()
    return rows.length
  }

  /** 某个 peer 的绑定快照（send 失败时回滚用）。 */
  snapshotPeer(accountId, kind, peerId) {
    return this.findBindings({ accountId, kind, peerId }).map((b) => ({ ...b }))
  }

  /**
   * 条件回滚：把该 peer 的绑定恢复成快照，**但只在这期间没有别人接管时**。
   *
   * 为什么不能无条件回滚（评审实测踩到）：A 的 send 还在等适配器时，B 已经 force 抢答成功；
   * A 失败后"删光该 peer 再放回快照"会把 B 刚写的新 taker 一起抹掉 —— 之后入站会重建会话，
   * B 的会话永远收不到消息。所以这里先看有没有"我们没碰过的行"，有就放弃回滚。
   */
  rollbackPeer(accountId, kind, peerId, before, after, { sessionId = '' } = {}) {
    const norm = normPeerId(peerId)
    const mine = (rows) => new Map((rows || []).map((r) => [r.sessionId, r]))
    const sameRow = (a, b) => a && b && a.mode === b.mode && a.updatedAt === b.updatedAt
      && String(a.boundBy || '') === String(b.boundBy || '')
    const beforeMap = mine(before)
    const afterMap = mine(after)
    const current = this.findBindings({ accountId, kind, peerId })

    // 账号已经没了：把该 peer 的行全部清掉（不能把绑定恢复成"悬空"）
    if (!this.getAccount(accountId)) {
      this.bindings = this.bindings.filter((b) => !(b.accountId === accountId && normKind(b.kind) === normKind(kind) && normPeerId(b.peerId) === norm))
      try { this.saveBindings() } catch { /* writeError 已记 */ }
      return { rolledBack: false, reason: 'account-gone' }
    }

    // 三方对比：只有"当前行 === 我们写进去的样子"的行才是我们造成的。
    // 别人这期间 force 抢答（哪怕 sessionId 在快照里）、手动 unbind、或新绑了第三个人 → 一律放弃回滚。
    for (const row of current) {
      const expected = afterMap.get(row.sessionId)
      if (!expected) return { rolledBack: false, reason: 'peer-changed', foreign: [row.sessionId] }
      if (!sameRow(row, expected)) return { rolledBack: false, reason: 'peer-changed', foreign: [row.sessionId] }
    }
    for (const sid of afterMap.keys()) {
      if (!current.some((r) => r.sessionId === sid)) return { rolledBack: false, reason: 'peer-changed', foreign: [sid] }
    }

    // 恢复到 before：删掉我们新加的行，把改过的行改回去，把删掉的行加回来
    this.bindings = this.bindings.filter((b) => !(b.accountId === accountId && normKind(b.kind) === normKind(kind) && normPeerId(b.peerId) === norm))
    for (const [sid, row] of beforeMap) this.bindings.push({ ...row })
    this.saveBindings()
    return { rolledBack: true, restored: beforeMap.size }
  }

  removeBinding(query) {
    const before = this.bindings.length
    this.bindings = this.bindings.filter((b) => {
      if (query.sessionId !== undefined && b.sessionId !== query.sessionId) return true
      if (query.accountId !== undefined && b.accountId !== query.accountId) return true
      if (query.kind !== undefined && normKind(b.kind) !== normKind(query.kind)) return true
      if (query.peerId !== undefined && normPeerId(b.peerId) !== normPeerId(query.peerId)) return true
      return false
    })
    const removed = before - this.bindings.length
    if (removed > 0) this.saveBindings()
    return removed
  }
}
