/**
 * mira_account / dedup.js —— 跨插件统一 message_id 去重（任务书功能点6）
 *
 * 覆盖三种重复来源：
 *   1. **自身 echo**——平台把「自己发出去的消息」也推回来（QQ 双连接、网易云信等）
 *      → send() 时记住返回的 message_id，入站见到同一个 id 就按 echo 丢掉
 *   2. **平台重发**——同一事件因 reconnection / 双连接推两次
 *   3. **同一 id 多次投递**——上层重复交给路由（agent 重试、补投）
 *
 * 落盘：`seen/<platform>.json` = { schemaVersion, entries:{ "<id>": ts }, self:{ "<id>": ts } }
 * TTL 到期清理；单平台条数上限兜底（防止长期运行把文件撑大）。
 * 写盘是节流的（默认 2s 一次 + dispose 时强制 flush），避免每条消息都打一次盘。
 */

import { appendFileSync, readFileSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './kit.mjs'

export const SEEN_SCHEMA = 1

const DEFAULTS = {
  ttlMs: 30 * 60 * 1000,
  maxEntries: 5000,
  saveThrottleMs: 2000,
}

/**
 * 去重键：`账号id|消息id`。
 * 只按 message_id 的话，同一平台两个账号（qq-main / qq-backup）撞号时，后到的**真实消息**
 * 会被判成 dup 静默丢掉；self 表同理会把别的账号的入站误判成自己的 echo。
 */
export function seenKey(accountId, messageId) {
  const id = messageId === undefined || messageId === null ? '' : String(messageId).trim()
  if (!id) return ''
  const who = String(accountId ?? '').trim()
  return who ? who + '|' + id : id
}

export class Dedup {
  constructor(baseDir, options = {}) {
    this.dir = join(baseDir, 'seen')
    this.options = { ...DEFAULTS, ...options }
    /** platform -> Map<id, ts> */
    this.entries = new Map()
    /** platform -> Map<id, ts>（自己发出去的） */
    this.self = new Map()
    this.dirty = new Set()
    /**
     * 正在投递中的 id（占位）。verdict() 命中就占位、record()/release() 释放。
     * 没有它：两条**同 id 并发**消息都会看到 duplicate:false，各投一遍（重复回复）。
     * 占位带 TTL，避免调用方两个都没走到时永久卡住某条 id。
     */
    this.inflight = new Map()
    this.inflightTtlMs = 60 * 1000
    /**
     * 追加日志（每条投递成功一行）。整张表有 TTL/上限、体积不小，每条都重写太贵；
     * 但只在内存里记「已投递」意味着**进程骤崩会丢掉最近最多 2 秒的记录**，平台重推就会重复回复。
     * 追加一行 ~80 字节、重启时回放，把重复窗口从"最多 2 秒"缩到"最多一条"。
     */
    this.recentFile = join(this.dir, 'recent.ndjson')
    this.recentLines = 0
    this.recentLimit = 2000
    this.#replayRecent()
    this.saveTimer = null
    this.lastSaveAt = 0
  }

  fileFor(platform) {
    // 纵深防御：platform 来自 accounts.json（手填）。不管上游怎么校验，这里都不允许拼出路径
    const safe = String(platform || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'
    return join(this.dir, safe + '.json')
  }

  load(platform) {
    const raw = readJson(this.fileFor(platform), null)
    const entries = new Map()
    const self = new Map()
    if (raw && raw.schemaVersion === SEEN_SCHEMA) {
      for (const [id, ts] of Object.entries(raw.entries ?? {})) {
        if (typeof ts === 'number') entries.set(id, ts)
      }
      for (const [id, ts] of Object.entries(raw.self ?? {})) {
        if (typeof ts === 'number') self.set(id, ts)
      }
    }
    // 合并而不是覆盖：回放日志时已经往 entries 里放过记录，这里不能把它们冲掉
    const bucketEntries = this.#bucket(this.entries, platform)
    for (const [id, ts] of entries) bucketEntries.set(id, ts)
    const bucketSelf = this.#bucket(this.self, platform)
    for (const [id, ts] of self) bucketSelf.set(id, ts)
    this.#prune(platform)
    return this
  }

  #bucket(map, platform) {
    if (!map.has(platform)) map.set(platform, new Map())
    return map.get(platform)
  }

  #prune(platform) {
    const cutoff = Date.now() - this.options.ttlMs
    for (const map of [this.#bucket(this.entries, platform), this.#bucket(this.self, platform)]) {
      for (const [id, ts] of map) if (ts < cutoff) map.delete(id)
      // 超上限：按插入序丢掉最老的（Map 保序）
      while (map.size > this.options.maxEntries) {
        const first = map.keys().next()
        if (first.done) break
        map.delete(first.value)
      }
    }
  }

  /** 追加一行"已投递"记录（失败不影响内存去重）。 */
  #appendRecent(platform, id, ts) {
    try {
      appendFileSync(this.recentFile, JSON.stringify({ p: platform, k: id, t: ts }) + '\n', 'utf8')
      this.recentLines += 1
      if (this.recentLines > this.recentLimit) this.#compactRecent()
    } catch { /* 磁盘满/权限：内存去重照常工作 */ }
  }

  /** 回放追加日志（重启后补齐最近的成功记录，显著缩小重复投递窗口）。 */
  #replayRecent() {
    let text = ''
    try { text = readFileSync(this.recentFile, 'utf8') } catch { return }
    const cutoff = Date.now() - this.options.ttlMs
    let lines = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      lines += 1
      let row = null
      try { row = JSON.parse(line) } catch { continue }
      if (!row || typeof row.t !== 'number' || row.t < cutoff) continue
      const platform = String(row.p || 'unknown')
      this.#bucket(this.entries, platform).set(String(row.k || ''), row.t)
      this.dirty.add(platform)
    }
    this.recentLines = lines
  }

  /** 日志太长：先把内存写进正式表，再清空日志。 */
  #compactRecent() {
    try { this.flush() } catch { return }
    // flush 失败时绝不能清日志：否则记录既没进正式表、又丢了追加日志 ——
    // 等于把"已投递"的证据销毁掉（重启后平台重推就会重复回复）。
    // 只看 writeFailed：dirty 在"某个平台持续写失败"时会永远非空（已成功的平台也跟着不清），
    // 用它当条件会让 recent.ndjson 永不压缩（长期无界增长 + 每轮都重写所有 dirty 平台）。
    if (this.writeFailed) return
    try {
      truncateSync(this.recentFile, 0)
      this.recentLines = 0
    } catch { /* 压缩失败：下次再试 */ }
  }

  /** 对一张表按 TTL + 条数上限裁剪（并盘之后也要用它，否则磁盘只增不减）。 */
  #bound(map) {
    const now = Date.now()
    const ttl = Math.max(0, Number(this.options.ttlMs) || 0)
    const cap = Math.max(0, Math.floor(Number(this.options.maxEntries) || 0))
    const kept = new Map()
    for (const [id, ts] of map) {
      if (typeof ts !== 'number') continue
      if (ttl > 0 && now - ts > ttl) continue
      kept.set(id, ts)
    }
    if (cap > 0 && kept.size > cap) {
      const newest = [...kept.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap)
      return new Map(newest)
    }
    return kept
  }

  /**
   * 只查不记（verdict）。返回 { duplicate:true, echo:true|false } 或 { duplicate:false, id }。
   *
   * **为什么必须能「只查」**：记账应该发生在**投递成功之后**。如果先记账再投递，
   * 投递失败（agent 超时 / 会话不存在 / createSession 炸）时这条 message_id 已经进了表，
   * 平台重推同一条就会被当成重复直接丢掉 —— 表现是「消息已读、bot 永远不回，且没有任何记录」。
   */
  verdict(platform, messageId) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId).trim()
    if (!id) return { duplicate: false, id: '', reserved: false } // 平台没给 id：不去重，交给调用方
    this.#prune(platform)
    const self = this.#bucket(this.self, platform)
    const entries = this.#bucket(this.entries, platform)
    const now = Date.now()
    const inkey = platform + '\u0000' + id
    this.#pruneInflight(now)
    if (self.has(id)) {
      self.set(id, now) // 自己的 echo 继续刷新，别在反复推送中过期
      return { duplicate: true, echo: true, id, reserved: false }
    }
    if (entries.has(id)) {
      entries.set(id, now) // 刷新 TTL：还在重复就别急着忘
      return { duplicate: true, echo: false, id, reserved: false }
    }
    // 有人正在投递同一条：也算重复（这是「占位」的真正作用）
    if (this.inflight.has(inkey)) return { duplicate: true, echo: false, id, inflight: true, reserved: false }
    // 占位成功（同步完成，JS 单线程下两次并发调用不会同时通过）
    this.inflight.set(inkey, now)
    return { duplicate: false, echo: false, id, reserved: true }
  }

  /** 撤销占位（投递失败/放弃时调；之后同 id 还能再试）。 */
  release(platform, messageId) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId).trim()
    if (!id) return false
    return this.inflight.delete(platform + '\u0000' + id)
  }

  /** 到所有平台的占位表里撤销同一个键（账号被删、平台未知时用）。 */
  releaseAny(id) {
    if (!id) return false
    let hit = false
    for (const key of [...this.inflight.keys()]) {
      if (key.endsWith('\u0000' + id)) {
        this.inflight.delete(key)
        hit = true
      }
    }
    return hit
  }

  /** 清过期占位（调用方两个分支都没走到时兜底）。 */
  #pruneInflight(now) {
    if (this.inflight.size === 0) return
    const cutoff = now - this.inflightTtlMs
    for (const [key, at] of this.inflight) if (at < cutoff) this.inflight.delete(key)
  }

  /** 投递成功后登记（record）。已存在则只刷新时间戳。 */
  record(platform, messageId) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId).trim()
    if (!id) return false
    this.#prune(platform)
    this.inflight.delete(platform + '\u0000' + id) // 投递成功：占位转为正式记录
    const now = Date.now()
    this.#bucket(this.entries, platform).set(id, now)
    this.#appendRecent(platform, id, now)
    this.dirty.add(platform)
    this.#scheduleSave()
    return true
  }

  /** 兼容旧调用：查 + 记一步完成（**不要**用在"查了之后还要投递"的路径上，用 verdict/record）。 */
  check(platform, messageId) {
    const out = this.verdict(platform, messageId)
    if (!out.duplicate) this.record(platform, messageId)
    return out
  }

  /** 标记「这条是我自己发的」：入站再见到同一个 id 就是 echo。 */
  markSelf(platform, messageId) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId).trim()
    if (!id) return
    this.#bucket(this.self, platform).set(id, Date.now())
    this.dirty.add(platform)
    this.#scheduleSave()
  }

  /** 主动登记已见（例如回放积压时先把一批 id 记下来）。 */
  markSeen(platform, messageId) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId).trim()
    if (!id) return
    this.#bucket(this.entries, platform).set(id, Date.now())
    this.dirty.add(platform)
    this.#scheduleSave()
  }

  size(platform) {
    if (platform) return this.#bucket(this.entries, platform).size
    let total = 0
    for (const map of this.entries.values()) total += map.size
    return total
  }

  selfSize(platform) {
    if (platform) return this.#bucket(this.self, platform).size
    let total = 0
    for (const map of this.self.values()) total += map.size
    return total
  }

  #scheduleSave() {
    if (this.saveTimer) return
    const wait = Math.max(0, this.options.saveThrottleMs - (Date.now() - this.lastSaveAt))
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, wait)
    if (this.saveTimer && typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  /**
   * 立即落盘（dispose / 状态查询时也可调）。
   *
   * **写前先并盘**：先把磁盘上已有的 id 读进来做并集（同 id 取更新的时间戳），再整体写回。
   * 为什么必须这样：进程里可能同时存在两个 Dedup 实例（热重载时旧实例还没 dispose 完，
   * 或者同一进程里既跑插件又跑一段运维脚本）。各自的内存快照都不全，
   * 谁后写谁就会把对方刚记下的 id 冲掉 —— 表现是「重启后同一条消息又被投递一次」。
   * 并集写入牺牲一点「删除」语义（内存里删掉的 id 会被磁盘上的旧记录带回来），
   * 但去重表本来就是 TTL 缓存：多记一条无害，少记一条会重复投递。
   */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const platforms = new Set([...this.dirty, ...this.entries.keys(), ...this.self.keys()])
    let wrote = 0
    let failed = false
    ensureDir(this.dir)
    for (const platform of platforms) {
      if (!this.dirty.has(platform)) continue
      const disk = readJson(this.fileFor(platform), null)
      const onDisk = disk && disk.schemaVersion === SEEN_SCHEMA ? disk : null
      const entries = this.#bucket(this.entries, platform)
      const self = this.#bucket(this.self, platform)
      const merge = (map, fromDisk) => {
        const out = new Map(map)
        for (const [id, ts] of Object.entries(fromDisk ?? {})) {
          if (typeof ts !== 'number') continue
          if (!out.has(id) || out.get(id) < ts) out.set(id, ts)
        }
        return out
      }
      // 并盘会**复活**已过期的条目，也会把条数上限冲掉（盘上只增不减）。
      // 所以并完必须按 TTL 与 maxEntries 再剪一次 —— 否则"写前并盘"等于把这两个约束废掉。
      const mergedEntries = this.#bound(merge(entries, onDisk?.entries))
      const mergedSelf = this.#bound(merge(self, onDisk?.self))
      const ok = writeJsonAtomic(this.fileFor(platform), {
        schemaVersion: SEEN_SCHEMA,
        entries: Object.fromEntries(mergedEntries),
        self: Object.fromEntries(mergedSelf),
      })
      if (ok) wrote++
      else failed = true
      // 内存也跟着并一下：不然下一次 flush 又会把磁盘上的记录当「别人的」
      this.entries.set(platform, mergedEntries)
      this.self.set(platform, mergedSelf)
    }
    // 只有真的全写成功才清 dirty；失败时保留 dirty，下一次 flush 还会重试
    if (!failed) this.dirty.clear()
    this.lastSaveAt = Date.now()
    this.writeFailed = failed
    return wrote
  }

  dispose() {
    try { this.flush() } catch { /* 退场不抛 */ }
  }
}
