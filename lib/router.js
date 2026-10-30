/**
 * mira_account / router.js —— 入站路由（任务书功能点5）
 *
 * 收到消息 → resolve 出绑定：
 *   · 有 taker    → steer 投递给它（会话忙也插话，不排队）
 *   · 只有 observer → 只投 observer，不自动应答
 *   · 无绑定      → 按该账号 inboundPolicy 处理：
 *       "create"  新建会话（标题=peername），并把它自动登记成 taker
 *       "default" 投默认会话（账号必须有 defaultSessionId，缺了报错不猜）
 *       "drop"    丢弃并计数
 *
 * 本模块只管「往哪个会话投」，投递动作由 service 注入的 deliver 完成（便于测试替换）。
 */

import { MiraError, nowIso } from './kit.mjs'
import { seenKey } from './dedup.js'
import { normPeerId, peerKey } from './store.js'

const TEXT_LIMIT = 200

export class Router {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {import('./dedup.js').Dedup} deps.dedup
   * @param {(sessionId:string, text:string, meta:object)=>Promise<void>} deps.deliver
   * @param {(info:object)=>Promise<string>} deps.createSession
   * @param {{bump:(k:string,d?:number)=>number}} deps.counters
   */
  constructor({ store, dedup, deliver, createSession, counters, logger }) {
    this.store = store
    this.dedup = dedup
    this.deliver = deliver
    this.counters = counters
    this.logger = logger
    /**
     * per-peer 的「正在建会话」锁：同一个 peer 的并发首条消息必须共用一次 createSession，
     * 否则会各建一个会话、各登记一个 taker（影子 taker 只在下次重启才被降级）。
     */
    this.creating = new Map()
    /** platform -> createSession（每个平台用自己的；以前是全局单槽，双 bot 并存时会互相顶掉） */
    this.createSessions = new Map()
    /** peer -> 连续投递失败次数（taker 可能已失效时，status 里要能看见） */
    this.peerFailures = new Map()
    /**
     * accountId -> 路由/投递统计。运维只看 status 时，要能分清「没人发消息」「发了但绑定错」
     * 「投递失败」—— 只有全局 counters 是分不清的（多账号混在一起）。
     */
    this.stats = new Map()
    /** 旧的单槽兜底（不按平台注册时用） */
    this.createSession = createSession ?? null
  }

  /**
   * 注册/清除某个平台的 createSession。
   * 两个参数 = 按平台（推荐）；一个函数 = 旧的全局兜底（不区分平台，仅为兼容保留）。
   */
  setCreateSession(platform, fn) {
    if (typeof platform === 'function') {
      this.createSession = platform
      return
    }
    const key = String(platform ?? '')
    if (typeof fn === 'function') this.createSessions.set(key, fn)
    else this.createSessions.delete(key)
  }

  /** 取该平台的 createSession（按平台优先，其次全局兜底）。 */
  createSessionFor(platform) {
    return this.createSessions.get(String(platform ?? '')) || this.createSession || null
  }

  async route({ accountId, kind, peerId, message = {}, display = '', source = null }) {
    const account = this.store.getAccount(accountId)
    if (!account) {
      return { routed: 'dropped', reason: 'account/not-found', error: { code: 'account/not-found', message: '账号不存在：' + accountId } }
    }
    if (!account.enabled) {
      this.#statsFor(account.id).dropped += 1
      this.counters?.bump('inbound.dropped.accountDisabled')
      return { routed: 'dropped', reason: 'account/disabled', error: { code: 'account/disabled', message: '账号已停用：' + accountId } }
    }

    const st = this.#statsFor(account.id)
    st.inbound += 1
    st.lastInboundAt = nowIso()

    // 1. 去重：**只查不记**。记账放到投递成功之后（见 recordSeen）——
    //    先记后投等于「投递失败 = 这条消息永久消失」，平台重推会被当成重复直接丢掉。
    const dedupId = seenKey(account.id, message.id)
    const verdict = this.dedup.verdict(account.platform, dedupId)
    if (verdict.duplicate) {
      st.dup += 1
      this.counters?.bump(verdict.echo ? 'inbound.echo' : 'inbound.duplicate')
      return { routed: 'dup', duplicate: true, echo: !!verdict.echo }
    }
    // 投递（或有意丢弃）成功才登记；抛错路径不登记，重推还能再试一次
    const recordSeen = () => {
      try { this.dedup.record(account.platform, dedupId) } catch { /* 记账失败不影响本次投递，TTL 缓存 */ }
    }
    // 投递抛错时必须撤销占位，否则同一条消息在占位 TTL 内都重试不了
    const releaseSeen = () => {
      try { this.dedup.release(account.platform, dedupId) } catch { /* 同上 */ }
    }

    const text = String(message.text ?? '')
    const meta = {
      accountId,
      platform: account.platform,
      kind,
      peerId: normPeerId(peerId),
      messageId: message.id === undefined ? null : String(message.id),
      sender: message.sender ?? null,
      // bot 插件可以指定消息来源（source.kind），例如 mira_bilibili → 'mira_bilibili'。
      // 不给就保持旧的 'user'（宿主 RuntimeContextProjection 只认 kind）。
      source: source && typeof source.kind === 'string' && source.kind.trim() !== ''
        ? { kind: source.kind.trim() }
        : null,
    }

    // 投递包装（要在 meta 之后定义：peer 标签与投递都依赖它）
    const peerLabel = meta.kind + ':' + meta.peerId
    const deliverOrRelease = async (sessionId, body, mode) => {
      try {
        const out = await this.deliver(sessionId, body, { ...meta, mode })
        this.peerFailures.delete(peerLabel)
        return out
      } catch (error) {
        this.#notePeerFailure(peerLabel)
        releaseSeen() // 投递失败：撤销占位，平台重推还能再试
        throw error
      }
    }

    // 2. 绑定解析
    const { taker, observers } = this.store.resolve(accountId, kind, peerId)

    if (taker) {
      // meta.mode 是给 bot 插件看的：收到消息的会话是「应答方」，该回就回
      await deliverOrRelease(taker.sessionId, text, 'taker')
      recordSeen()
      st.delivered += 1
      st.lastDeliveryAt = nowIso()
      this.counters?.bump('inbound.taker')
      this.#log('taker', accountId, kind, peerId, taker.sessionId, text)
      return { routed: 'taker', sessionId: taker.sessionId, mode: 'taker' }
    }

    if (observers.length > 0) {
      const failed = []
      for (const observer of observers) {
        try {
          // 旁听分支单独处理：单个 observer 失败不能释放占位 ——
          // 否则同一 id 的并发消息会在"释放到记账"之间挤进来，把第二个 observer 投两遍。
          // 只有**全部**失败才释放（见下面的 failed.length === observers.length）。
          await this.deliver(observer.sessionId, text, { ...meta, mode: 'observer' })
        } catch (error) {
          failed.push({ sessionId: observer.sessionId, error: { code: error?.code ?? 'delivery/failed', message: error?.message ?? String(error) } })
        }
      }
      this.counters?.bump('inbound.observer')
      this.#log('observer', accountId, kind, peerId, observers.map((o) => o.sessionId).join(','), text)
      if (failed.length === observers.length) {
        // 全部失败：撤销占位并且不记账，让平台重推时还有机会
        this.#notePeerFailure(peerLabel)
        releaseSeen()
        return { routed: 'observer', failed, reason: 'delivery/failed' }
      }
      recordSeen()
      st.delivered += 1
      st.lastDeliveryAt = nowIso()
      return { routed: 'observer', sessionIds: observers.map((o) => o.sessionId), failed }
    }

    // 3. 无绑定 → 按 inboundPolicy
    const policy = account.inboundPolicy || 'create'

    if (policy === 'drop') {
      st.dropped += 1
      recordSeen() // 有意丢弃：记账，免得平台重推时把计数刷两遍（没有"重试"的语义）
      this.counters?.bump('inbound.dropped.noBinding')
      this.#log('drop', accountId, kind, peerId, '-', text)
      return { routed: 'dropped', reason: 'no-binding' }
    }

    if (policy === 'default') {
      const sessionId = account.defaultSessionId
      if (!sessionId) {
        throw new MiraError('binding/not-found',
          '账号 ' + accountId + ' 的 inboundPolicy=default，但没有配 defaultSessionId',
          '在 accounts.json 里给该账号填 defaultSessionId，或把 inboundPolicy 改成 create/drop')
      }
      await deliverOrRelease(sessionId, text, 'default')
      recordSeen()
      st.delivered += 1
      st.lastDeliveryAt = nowIso()
      this.counters?.bump('inbound.default')
      this.#log('default', accountId, kind, peerId, sessionId, text)
      return { routed: 'default', sessionId }
    }

    if (policy === 'create') {
      const sessionId = await this.#ensureCreatedSession({ account, kind, peerId, display, text })
      await deliverOrRelease(sessionId, text, 'taker')
      recordSeen()
      st.delivered += 1
      st.lastDeliveryAt = nowIso()
      this.counters?.bump('inbound.created')
      this.#log('create', accountId, kind, peerId, sessionId, text)
      return { routed: 'created', sessionId, binding: { mode: 'taker' } }
    }

    throw new MiraError('account/invalid',
      '账号 ' + accountId + ' 的 inboundPolicy 非法：' + JSON.stringify(policy),
      '可选 create / default / drop')
  }

  #statsFor(accountId) {
    const key = String(accountId ?? '')
    let st = this.stats.get(key)
    if (!st) {
      st = {
        inbound: 0, dup: 0, delivered: 0, dropped: 0, failed: 0,
        lastInboundAt: null, lastDeliveryAt: null, lastDeliveryError: null,
      }
      this.stats.set(key, st)
    }
    return st
  }

  /** 供 service 在 catch 里记一笔（路由抛错时它才是知道 accountId 的那一层）。 */
  noteFailure(accountId, error) {
    const st = this.#statsFor(accountId)
    st.failed += 1
    st.lastDeliveryError = {
      code: String(error?.code ?? error?.error?.code ?? 'unknown/error'),
      message: String(error?.message ?? error?.error?.message ?? error).slice(0, 200),
      at: nowIso(),
    }
    return st
  }

  /**
   * 记录某个 peer 的连续投递失败。
   * 为什么要有：绑定的会话如果被删了，这个 peer 的每条消息都会 `delivery/failed`，
   * 而绑定点不动 —— 表现是"这个人的消息永远不回，也没有任何提示"（死 taker 黑洞）。
   * 不自动解绑（可能只是临时故障），但连续 3 次要在日志与 status 里露出来。
   */
  #notePeerFailure(label) {
    const count = (this.peerFailures.get(label) || 0) + 1
    this.peerFailures.set(label, count)
    this.counters?.bump('delivery.peerFailed')
    if (count === 3) {
      this.logger?.warn?.('[mira_account] ' + label + ' 连续 ' + count + ' 次投递失败：该 peer 的会话可能已失效。'
        + '用 mira_account_bindings 看一眼，必要时 mira_account_unbind 后让对方重发（或发 /new 重建）')
    }
    return count
  }

  /**
   * 给一个「无绑定」的 peer 建会话并登记成 taker。**同一 peer 并发只建一次**。
   *
   * 为什么必须有锁：createSession 要走 agents.create（可能几秒），这期间同 peer 的第二条消息
   * 看到的仍然是「无绑定」，于是再建一个会话、再登记一个 taker —— 两条消息分别投进两个会话，
   * 两个 agent 都以为自己在应答（并且文件里留下两个 taker）。
   */
  async #ensureCreatedSession({ account, kind, peerId, display, text }) {
    const key = peerKey(account.id, kind, peerId)
    const inflight = this.creating.get(key)
    if (inflight) return inflight

    const task = (async () => {
      // 锁内复查：等锁期间可能已经有 taker 了（别人建完 / 人手绑的）
      const again = this.store.resolve(account.id, kind, peerId)
      if (again.taker) return again.taker.sessionId

      const createFn = this.createSessionFor(account.platform)
      if (typeof createFn !== 'function') {
        throw new MiraError('session/create-unsupported',
          '账号 ' + account.id + '（' + account.platform + '）的 inboundPolicy=create，但没有该平台的 createSession',
          '让适配器实现 createSession({account, kind, peerId, display, text})，或把 inboundPolicy 改成 default/drop')
      }
      const sessionId = await createFn({
        account, kind, peerId: normPeerId(peerId), display: display || normPeerId(peerId), text,
      })
      if (!sessionId) {
        throw new MiraError('session/create-failed', '适配器 createSession 没有返回 sessionId',
          '检查 mira_qqbot/mira_bilibili 的 agentCwd / agentPreset 配置与日志')
      }
      try {
        this.store.upsertBinding({ sessionId, accountId: account.id, kind, peerId: normPeerId(peerId), mode: 'taker' })
      } catch (error) {
        // 会话已经建好了：绑定写不进去（别人这期间 force 抢答 / 账号刚被删 / 写盘失败）也要把这条消息投出去，
        // 否则会话变孤儿、消息被丢掉，而且每次重推都会再建一个会话。
        this.counters?.bump('binding.writeFailed')
        this.logger?.warn?.('[mira_account] 会话 ' + sessionId + ' 已创建但绑定写入失败（'
          + (error?.code ?? 'unknown') + '）：仍投递本条，绑定留给下次入站处理')
        this.noteError?.(error)
      }
      return sessionId
    })()

    this.creating.set(key, task)
    try {
      return await task
    } finally {
      this.creating.delete(key)
    }
  }

  #log(outcome, accountId, kind, peerId, sessionId, text) {
    this.logger?.info?.('[mira_account] 入站 ' + outcome + ' ' + accountId + ' ' + kind + ':' + peerKey(accountId, kind, peerId).split('|')[2]
      + ' → ' + sessionId + '  「' + String(text).slice(0, TEXT_LIMIT) + '」')
  }
}
