/**
 * mira_account / service.js —— 装配层：账号池 + 适配器 + 绑定 + 路由 + 去重 + 限流
 *
 * 职责边界（任务书 §mira_account 给 bot 插件的契约 A/B/C）：
 *   · 池、绑定、路由、去重、限流都在本模块；**协议与编解码归 bot 插件**（adapter）。
 *   · 入站消息一律走 inbound()，bot 插件不自己维护 session 映射（契约 A）。
 *   · 出站发送一律走 send()，它负责「先 bind 或复用已有 binding，再 adapter.send」（契约 B）。
 *   · 所有平台的错误都用归一错误码（契约 C）。
 *
 * 为什么不在这里做平台判断：
 *   本模块不认识 OneBot，也不认识 B 站 cookie。它只认 adapter 契约与 peer 三元组
 *   (accountId, kind, peerId)，所以新增平台 = 新增一个 adapter，不改进这里。
 */

import { join } from 'node:path'
import {
  MiraError, fail, makeCounters, nowIso, toError,
} from './kit.mjs'
import {
  KINDS, PLATFORM_KINDS, PLATFORMS, Store, isVirtualPlatform, isValidId, normPeerId, peerKey,
} from './store.js'
import { seenKey } from './dedup.js'
import { Dedup } from './dedup.js'
import { Limiter } from './limiter.js'
import { Router } from './router.js'
import { credsStatus, readCreds, redact } from './creds.js'

/** adapter 必须实现的方法（任务书功能点2 的契约）。 */
const ADAPTER_METHODS = ['connect', 'disconnect', 'send', 'onMessage', 'status']

/** 日志里截断文本，避免一条长消息把日志刷满。 */
function preview(text, limit = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

export class AccountService {
  /**
   * @param {object} options
   * @param {string} options.baseDir                $DSH_HOME/mira_config/mira_account
   * @param {object} [options.config]               插件配置（limits/dedup/...）
   * @param {object} [options.logger]               cordis logger
   * @param {(sessionId:string, text:string, meta:object)=>Promise<void>} [options.deliver]
   *        投递到会话（由 index.js 用 steer 实现；smoke 里替换成假实现）
   */
  constructor({ baseDir, config = {}, logger = null, deliver = null }) {
    this.baseDir = baseDir
    this.config = config && typeof config === 'object' ? config : {}
    this.logger = logger
    this.store = new Store(baseDir)
    this.dedup = new Dedup(baseDir, this.config.dedup || {})
    this.counters = makeCounters()
    /** platform -> adapter */
    this.adapters = new Map()
    /** accountId -> Limiter（按账号维度，读/写分桶） */
    this.limiters = new Map()
    /** 最近一次归一错误（status 里可见，不静默吞掉） */
    this.lastError = null
    /**
     * 健康巡检（P1-7）：
     *   以前 adapter.status() 被 ADAPTER_METHODS 要求实现、却**从未调用**，
     *   于是 state 永远停在 connect 那一刻（"假在线"）；error 账号也没有任何重连。
     */
    this.health = { timer: null, intervalMs: 0, running: false, inProgress: false, lastRunAt: null, checks: 0, errors: 0, reconnects: 0 }
    /** accountId -> { attempts, nextAt }（指数退避重连） */
    this.retry = new Map()
    /** 运行时告警（status.warnings.runtime 可见：同平台多账号、投递连续失败等） */
    this.warnings = []
    /** accountId -> 正在进行的 connect promise（防同账号双连接） */
    this.connecting = new Map()
    this.counters.pluginName = 'mira_account'

    this.router = new Router({
      store: this.store,
      dedup: this.dedup,
      deliver: deliver || (async () => { throw new MiraError('delivery/failed', '投递通道未装配', '插件初始化异常：deliver 必须由 index.js 注入') }),
      createSession: null,
      counters: this.counters,
      logger,
    })
    /** 平台层没提供 createSession 时的兜底（目前恒为 null：创建会话要 cwd/preset，属平台配置） */
    this.defaultCreateSession = null
  }

  /* ── 生命周期 ─────────────────────────────────────────── */

  load() {
    this.store.load(this.logger)
    // 每个平台的去重表都读一遍：没有账号也把历史 seen 读进来，重启后不会把旧消息当新消息
    for (const platform of PLATFORMS) this.dedup.load(platform)
    if (this.store.fatalError) this.noteError(this.store.fatalError.error)
    return this
  }

  /** 挂上默认的会话创建实现（index.js 装配 agents 服务时用）。 */
  setCreateSession(fn) {
    this.defaultCreateSession = typeof fn === 'function' ? fn : null
    if (!this.router.createSession) this.router.createSession = this.defaultCreateSession
  }

  /** 按平台设置/清除 createSession（一般由 adapter.createSession 自动注册）。 */
  setCreateSessionFor(platform, fn) {
    this.router.setCreateSession(platform, fn)
  }

  /**
   * 同步落盘（卸载时**先**调它，再做异步收尾）。
   * 为什么单独一个方法：卸载链里只要有一处 await，调用方忘了 await 就变成"稍后才落盘"，
   * 而「卸载即落盘」是约定9 的硬要求（新实例马上要 load 同一份文件）。
   */
  flush() {
    try { this.dedup.dispose() } catch { /* 退场不抛 */ }
  }

  dispose() {
    try { this.stopHealthLoop() } catch { /* 退场不抛 */ }
    try { this.dedup.dispose() } catch { /* 退场不抛 */ }
    this.adapters.clear()
    this.retry.clear()
  }

  /* ── 适配器注册（任务书功能点2） ───────────────────────── */

  /**
   * 注册平台适配器。同一平台只允许一个实现（两个实现在跑 = 消息会被处理两遍）。
   * 返回 dispose；重复注册抛 platform/duplicate。
   */
  registerAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') {
      throw new MiraError('platform/unsupported', 'adapter 不是一个对象', '按任务书功能点2 的契约实现 adapter')
    }
    const platform = String(adapter.platform ?? '').trim()
    if (!PLATFORMS.includes(platform)) {
      throw new MiraError('platform/unsupported',
        '平台不支持：' + JSON.stringify(adapter.platform),
        '可选 ' + PLATFORMS.join(' / ') + '（新增平台要先在 store.js 的 PLATFORMS 里登记）')
    }
    const missing = ADAPTER_METHODS.filter((m) => typeof adapter[m] !== 'function')
    if (missing.length) {
      throw new MiraError('platform/unsupported',
        '适配器 ' + platform + ' 缺少方法：' + missing.join(', '),
        'adapter = { platform, connect, disconnect, send, onMessage, status }（任务书功能点2）')
    }
    if (this.adapters.has(platform)) {
      throw new MiraError('platform/duplicate',
        '平台 ' + platform + ' 已经有适配器在跑：' + (this.adapters.get(platform).name || '(未命名)'),
        '同一个平台只允许一个适配器；要换实现先卸载旧的（避免同一条消息被处理两遍）')
    }
    this.adapters.set(platform, adapter)
    // 适配器可以自带 createSession（需要自己的 cwd / preset 配置）——**按平台注册**，
    // 否则装了两个 bot 插件时，后注册的会把前一个顶掉（qq 的新 peer 被 bilibili 的 cwd/preset 建会话）。
    if (typeof adapter.createSession === 'function') this.router.setCreateSession(platform, adapter.createSession)
    else if (this.defaultCreateSession) this.router.setCreateSession(platform, this.defaultCreateSession)
    this.counters.bump('adapter.registered')
    this.logger?.info?.('[mira_account] 适配器已注册：' + platform)
    // 冷启动顺序不保证：可能是 mira_account 先 apply（connectAll 时还没有适配器，
    // 账号被记成 platform/unsupported），bot 插件稍后才注册适配器。
    // 所以这里按平台补连一次，否则那些账号要等到下一次重启才会真的连上。
    this.connectPlatform(platform).then((report) => {
      if (report.connected.length > 0) {
        this.logger?.info?.('[mira_account] 适配器 ' + platform + ' 注册后补连账号：' + report.connected.join(', '))
      }
    }).catch((error) => {
      this.logger?.warn?.('[mira_account] 适配器 ' + platform + ' 注册后补连失败：' + (error?.message ?? String(error)))
    })
    return () => {
      if (this.adapters.get(platform) === adapter) {
        this.adapters.delete(platform)
        this.router.setCreateSession(platform, null) // 卸载即失效，别留着已死的闭包
      }
    }
  }

  adapterFor(platform) {
    return this.adapters.get(platform) ?? null
  }

  /* ── 账号池 CRUD（任务书功能点1） ─────────────────────── */

  listAccounts() {
    if (this.store.fatalError) throw new MiraError(this.store.fatalError.error.code, this.store.fatalError.error.message, this.store.fatalError.error.hint)
    return this.store.listAccounts().map((a) => this.#accountView(a))
  }

  #accountView(account) {
    const creds = credsStatus(this.baseDir, account.id)
    return {
      id: account.id,
      platform: account.platform,
      label: account.label,
      enabled: account.enabled,
      state: account.state,
      error: account.error ?? null,
      inboundPolicy: account.inboundPolicy,
      defaultSessionId: account.defaultSessionId || undefined,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      // 只报「有没有 / 权限对不对 / 什么形态 / 字段名」，不报任何值（约定8）
      creds: {
        present: creds.present,
        kind: creds.kind ?? null,
        fieldNames: creds.fieldNames ?? [],
        mode: creds.mode ?? null,
        modeOk: creds.modeOk ?? false,
      },
      adapter: !!this.adapterFor(account.platform),
    }
  }

  addAccount(input) {
    if (input && input.defaultSessionId !== undefined && String(input.defaultSessionId).trim()) {
      this.#requireSessionId(input.defaultSessionId, 'addAccount.defaultSessionId')
    }
    if (this.store.fatalError) throw new MiraError(this.store.fatalError.error.code, this.store.fatalError.error.message, this.store.fatalError.error.hint)
    const account = this.store.addAccount(input)
    this.counters.bump('account.added')
    this.logger?.info?.('[mira_account] 账号已登记：' + account.id + '（' + account.platform + '）')
    // 登记完立刻尝试连接（以前要重启才会连；编排脚本 add 完就能用）
    const samePlatform = this.store.listAccounts()
      .filter((a) => a.platform === account.platform && a.id !== account.id && a.enabled)
    if (samePlatform.length > 0) {
      // 现有适配器（mira_qqbot 一条 ws、mira_bilibili 一份 cookie）都是单连接：
      // 同平台配两个账号时，第二个账号虽然显示 online，实际收发走的是第一个账号的连接。
      const warning = '平台 ' + account.platform + ' 上已有启用账号 ' + samePlatform.map((a) => a.id).join(',')
        + '：当前适配器是单连接，两个账号会共用同一条连接（发送会从另一个账号发出）。'
      this.warnings.push(warning)
      this.logger?.warn?.('[mira_account] ' + warning)
      this.counters.bump('account.sharedPlatform')
    }
    if (account.enabled && this.config.autoConnect !== false) this.#connectInBackground(account.id)
    // 重新读一次：连接/虚拟账号判定会改 state，用登记时那份旧对象会把 state 报成 error
    return this.#accountView(this.store.getAccount(account.id) || account)
  }

  removeAccount(accountId) {
    // 先让适配器断开（别把一个已删账号的连接留在那儿）
    const existing = this.store.getAccount(accountId)
    const adapter = existing ? this.adapterFor(existing.platform) : null
    if (existing && adapter && typeof adapter.disconnect === 'function') {
      Promise.resolve(adapter.disconnect(existing)).catch((error) => {
        this.logger?.warn?.('[mira_account] 删除账号 ' + accountId + ' 时断开失败：' + (error?.message ?? error))
      })
    }
    this.retry.delete(String(accountId))
    const result = this.store.removeAccount(accountId)
    if (!result.ok) {
      throw new MiraError('account/not-found', '账号不存在：' + accountId, '先 mira_account_list 看有哪些账号')
    }
    this.limiters.delete(accountId)
    this.counters.bump('account.removed')
    this.logger?.info?.('[mira_account] 账号已删除：' + accountId + '（同时清掉 ' + result.removedBindings + ' 条绑定）')
    return { accountId, removedBindings: result.removedBindings }
  }

  setAccountEnabled(accountId, enabled) {
    const account = this.store.setEnabled(accountId, enabled)
    this.counters.bump(enabled ? 'account.enabled' : 'account.disabled')
    this.logger?.info?.('[mira_account] 账号 ' + accountId + ' 已' + (enabled ? '启用' : '停用'))
    const adapter = this.adapterFor(account.platform)
    if (!enabled) {
      this.retry.delete(account.id)
      // 停用要真的断开：否则连接还在、入站还会来（只是被路由层丢掉），看起来像"停用了还在线"
      if (adapter && typeof adapter.disconnect === 'function') {
        Promise.resolve(adapter.disconnect(account)).catch((error) => {
          this.logger?.warn?.('[mira_account] 停用 ' + accountId + ' 时断开失败：' + (error?.message ?? error))
        })
      }
      this.store.setState(account.id, 'offline', null)
    } else if (this.config.autoConnect !== false) {
      this.#connectInBackground(account.id)
    }
    return this.#accountView(this.store.getAccount(accountId) ?? account)
  }

  /** 后台连一个账号（不阻塞工具调用；失败写进 state 与 status）。 */
  #connectInBackground(accountId) {
    const account = this.store.getAccount(accountId)
    if (!account) return
    // 本地虚拟账号（如 vtuber 形象本身）：没有对外连接，也不需要适配器。
    // 直接记 online —— 它本来就是"进程活着就算在线"，否则 addAccount 会把它标成 error，
    // 后面按账号查状态的人（权限判断）会以为它挂了。
    if (isVirtualPlatform(account.platform)) {
      this.store.setState(account.id, 'online', null)
      this.logger?.info?.('[mira_account] 账号 ' + accountId + ' 是本地虚拟账号（' + account.platform + '），不需要连接')
      return
    }
    const adapter = this.adapterFor(account.platform)
    if (!adapter) {
      this.store.setState(account.id, 'error', { code: 'platform/unsupported', message: '没有 ' + account.platform + ' 适配器' })
      return
    }
    this.#connectOnce(account, adapter).then((outcome) => {
      if (outcome.ok) this.logger?.info?.('[mira_account] 账号 ' + accountId + ' 已连接')
      else this.logger?.warn?.('[mira_account] 账号 ' + accountId + ' 连接失败：' + (outcome.error?.code ?? ''))
    }).catch((error) => this.noteError(error))
  }

  /**
   * sessionId 格式校验：只挡"明显不可能是会话 id"的输入（空、空白、控制字符、超长）。
   * **不做存在性校验** —— 判定会话是否存在要唤醒 agent（有副作用），代价太大；
   * 这里只把「拼错成带空格/换行」这类最常见的黑洞挡在写入之前。
   */
  #requireSessionId(sessionId, where) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) {
      throw new MiraError('config/missing', where + ' 缺少 sessionId',
        '在会话里调用工具会自动带当前会话；脚本调用请显式传 sessionId')
    }
    // 白名单比黑名单可靠：Control(C1)、DEL、零宽、竖线、斜杠这类一律不收
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sid)) {
      throw new MiraError('config/invalid', where + ' 的 sessionId 不像会话 id：' + JSON.stringify(sid.slice(0, 60)),
        'sessionId 不该含空白或控制字符（例如 session-<uuid> / qq-xxxx-yyyy）')
    }
    return sid
  }

  /** 账号必须存在且启用，否则按归一错误码抛。 */
  requireAccount(accountId) {
    const id = String(accountId ?? '').trim()
    if (!isValidId(id)) {
      throw new MiraError('account/not-found', '账号 id 非法：' + JSON.stringify(accountId), '先 mira_account_list 看有哪些账号')
    }
    const account = this.store.getAccount(id)
    if (!account) {
      throw new MiraError('account/not-found', '账号不存在：' + id, '先 mira_account_list 看有哪些账号')
    }
    if (!account.enabled) {
      throw new MiraError('account/disabled', '账号已停用：' + id, '在 accounts.json 里把 enabled 改成 true，或调 mira_account_toggle')
    }
    return account
  }

  /** 投递前确认平台适配器在（否则 skill/凭据都对了也发不出去）。 */
  requireAdapter(platform) {
    const adapter = this.adapterFor(platform)
    if (!adapter) {
      throw new MiraError('platform/unsupported',
        '平台 ' + platform + ' 的适配器没有装（账号在，但发不出去）',
        '装对应的 bot 插件（qq → mira_qqbot，bilibili → mira_bilibili）后重启 DSH')
    }
    return adapter
  }

  /* ── 绑定（任务书功能点3 / 4） ─────────────────────────── */

  /**
   * 绑定会话 ↔ peer。
   * mode="taker" 时同 peer 只允许一个 taker：冲突要显式 force（抢）或 observer（旁听）才改。
   * 返回 { ok:true, action:'created'|'reused'|'forced'|'observer', binding }
   */
  bind({ sessionId, accountId, kind, peerId, mode = 'taker', force = false, observer = false, boundBy = '' }) {
    const session = this.#requireSessionId(sessionId, 'bind')
    const account = this.requireAccount(accountId)
    const peer = this.#requirePeer(kind, peerId, account.platform)
    const requested = String(mode ?? 'taker').trim().toLowerCase()
    if (!['taker', 'observer'].includes(requested)) {
      throw new MiraError('config/invalid', 'mode 非法：' + JSON.stringify(mode), '可选 taker / observer')
    }
    const wantMode = observer ? 'observer' : requested

    const { taker } = this.store.resolve(account.id, peer.kind, peer.peerId)

    if (wantMode === 'observer') {
      if (taker && taker.sessionId === session) {
        // 自己本来是 taker，要求降级成 observer
        this.store.upsertBinding({ sessionId: session, accountId: account.id, kind: peer.kind, peerId: peer.peerId, mode: 'observer', boundBy })
        this.logger?.info?.('[mira_account] ' + peer.key + ' 的 taker 已降级为 observer：' + session)
        return { ok: true, action: 'observer', binding: this.#bindingView(session, account.id, peer, 'observer') }
      }
      this.store.upsertBinding({ sessionId: session, accountId: account.id, kind: peer.kind, peerId: peer.peerId, mode: 'observer', boundBy })
      this.counters.bump('binding.observer')
      this.logger?.info?.('[mira_account] 新增 observer 绑定：' + peer.key + ' ← ' + session)
      return { ok: true, action: 'observer', binding: this.#bindingView(session, account.id, peer, 'observer') }
    }

    if (taker && taker.sessionId === session) {
      this.store.bindTaker({ sessionId: session, accountId: account.id, kind: peer.kind, peerId: peer.peerId, boundBy })
      return { ok: true, action: 'reused', binding: this.#bindingView(session, account.id, peer, 'taker') }
    }

    if (taker && !force) {
      throw new MiraError('binding/conflict',
        peer.key + ' 已经由会话 ' + taker.sessionId + ' 应答',
        '要抢过来加 force:true；只想旁听加 observer:true；不动就先 unbind 旧绑定')
    }

    if (taker && force) {
      // 旧 taker 降级成 observer（不删：让它还能看到后来的消息，撤销也容易）。
      // 一次写盘完成"降级 + 新建"：原来两次写盘，中间崩会留下"没有 taker"的哑火状态。
      const forced = this.store.bindTaker({
        sessionId: session, accountId: account.id, kind: peer.kind, peerId: peer.peerId, boundBy, force: true,
      })
      this.counters.bump('binding.forced')
      this.logger?.warn?.('[mira_account] ' + peer.key + ' 的 taker 被 ' + session + ' 抢走（原 ' + taker.sessionId + ' 降级 observer'
        + (forced.demoted.length ? '' : '（降级失败？）') + '）')
      return { ok: true, action: 'forced', previousTaker: taker.sessionId, binding: this.#bindingView(session, account.id, peer, 'taker') }
    }

    this.store.bindTaker({ sessionId: session, accountId: account.id, kind: peer.kind, peerId: peer.peerId, boundBy })
    this.counters.bump('binding.created')
    this.logger?.info?.('[mira_account] 新增 taker 绑定：' + peer.key + ' ← ' + session)
    return { ok: true, action: 'created', binding: this.#bindingView(session, account.id, peer, 'taker') }
  }

  unbind(query = {}) {
    const filter = {}
    if (query.sessionId !== undefined) filter.sessionId = String(query.sessionId)
    if (query.accountId !== undefined) filter.accountId = String(query.accountId)
    if (query.kind !== undefined) filter.kind = String(query.kind)
    if (query.peerId !== undefined) filter.peerId = normPeerId(query.peerId)
    const full = filter.accountId !== undefined && filter.kind !== undefined && filter.peerId !== undefined
    if (!full && filter.sessionId === undefined) {
      throw new MiraError('config/missing',
        'unbind 只给了部分条件（' + Object.keys(filter).join('/') + '），会误删别的账号/会话',
        '要么给 sessionId（删这个会话的全部绑定），要么同时给 accountId + kind + peerId（删这一个 peer）')
    }
    const removed = this.store.removeBinding(filter)
    if (removed > 0) {
      this.counters.bump('binding.removed', removed)
      this.logger?.info?.('[mira_account] 解绑 ' + removed + ' 条：' + JSON.stringify(filter))
    }
    return { removed, filter }
  }

  bindings(sessionIdOrFilter) {
    let filter = {}
    if (typeof sessionIdOrFilter === 'string' && sessionIdOrFilter) filter = { sessionId: String(sessionIdOrFilter) }
    else if (sessionIdOrFilter && typeof sessionIdOrFilter === 'object') {
      const { sessionId, accountId, kind, peerId } = sessionIdOrFilter
      if (sessionId !== undefined && String(sessionId).trim()) filter.sessionId = String(sessionId).trim()
      if (accountId !== undefined && String(accountId).trim()) filter.accountId = String(accountId).trim()
      if (kind !== undefined && String(kind).trim()) filter.kind = String(kind).trim()
      if (peerId !== undefined && String(peerId).trim()) filter.peerId = String(peerId).trim()
    }
    const rows = this.store.findBindings(filter)
    return rows.map((b) => ({
      sessionId: b.sessionId,
      accountId: b.accountId,
      kind: b.kind,
      peerId: b.peerId,
      mode: b.mode,
      boundBy: b.boundBy ?? null,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }))
  }

  /** 双向可查：peer → { taker, observers }。停用账号返回空绑定（等于"没人应答这条线"）。 */
  resolve(accountId, kind, peerId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    if (!account) {
      throw new MiraError('account/not-found', '账号不存在：' + accountId, '先 mira_account_list 看有哪些账号')
    }
    const peer = this.#requirePeer(kind, peerId, account.platform)
    if (!account.enabled) {
      // bot 插件的「已绑定快路径」不经过 router，只能在这里拦住：停用账号看起来"没有绑定"，
      // 于是它会走 inboundPolicy → router 按 account/disabled 丢弃并计数（而不是继续投递）。
      return { accountId: account.id, key: peer.key, taker: null, observers: [], disabled: true }
    }
    const { taker, observers } = this.store.resolve(account.id, peer.kind, peer.peerId)
    return {
      accountId: account.id,
      key: peer.key,
      taker: taker ? { sessionId: taker.sessionId, since: taker.updatedAt, boundBy: taker.boundBy ?? null } : null,
      observers: observers.map((o) => ({ sessionId: o.sessionId, since: o.updatedAt, boundBy: o.boundBy ?? null })),
    }
  }

  /* ── 出站（契约 B：先 bind 或复用，再 adapter.send） ──── */

  /**
   * @param {object} input
   * @param {string} input.accountId
   * @param {string} input.kind
   * @param {string|number} input.peerId
   * @param {object} input.payload           交给适配器编码（至少含 text，媒体类自行加字段）
   * @param {string} [input.sessionId]       发起方会话：给了就做反向绑定
   * @param {boolean} [input.force]          抢答（旧的 taker 降级 observer）
   * @param {boolean} [input.observer]       只旁听登记
   */
  async send({ accountId, kind, peerId, payload, sessionId, force = false, observer = false }) {
    const account = this.requireAccount(accountId)
    const adapter = this.requireAdapter(account.platform)
    const peer = this.#requirePeer(kind, peerId, account.platform)

    const body = payload && typeof payload === 'object' ? payload : (payload === undefined ? {} : { text: String(payload) })
    if (Object.keys(body).length === 0) {
      throw new MiraError('config/missing', 'payload 是空的（没有文本，也没有媒体字段）', '至少给 text；媒体消息给 file/url 等适配器认识的字段')
    }

    // 1. 限流（写桶）—— **先于绑定**：被限流拒绝的一次调用不该改动绑定表
    //    （旧顺序是「先 bind 再限流」，结果是一次被拒的 force 抢答已经把 taker 换掉了，而消息一条没发）
    this.#checkLimit(account.id, 'write')

    // 2. 反向绑定（任务书功能点4）：发送即登记，对端回复才回得来
    let binding = { mode: 'none' }
    const snapshot = sessionId ? this.store.snapshotPeer(account.id, peer.kind, peer.peerId) : null
    let after = null // 绑定写完之后的样子（三方回滚要用）

    // 3. 绑定 + 发送放在同一个 try 里：bind 写失败（账号刚被删 / 写盘失败）也要回滚，
    //    否则会出现"内存降级了、磁盘还是旧 taker"这种半截状态。
    let result
    try {
      if (sessionId) {
        const bound = this.bind({
          sessionId: this.#requireSessionId(sessionId, 'send'),
          accountId: account.id, kind: peer.kind, peerId: peer.peerId, force, observer, boundBy: sessionId,
        })
        after = this.store.snapshotPeer(account.id, peer.kind, peer.peerId)
        binding = { mode: bound.binding.mode, action: bound.action }
      }
      result = await adapter.send(account, peer.kind, peer.peerId, body)
      // 适配器"不抛错但明确失败"也要当失败：否则会报 ok:true、计 outbound.sent、绑定留在那儿
      if (result && result.ok === false) {
        const inner = result.error && typeof result.error === 'object' ? result.error : {}
        throw Object.assign(new Error(inner.message ?? '适配器返回 ok:false（没有 message）'), {
          code: inner.code ?? 'delivery/failed',
          hint: inner.hint,
        })
      }
    } catch (error) {
      if (snapshot && after) {
        try {
          const undo = this.store.rollbackPeer(account.id, peer.kind, peer.peerId, snapshot, after, { sessionId })
          if (undo.rolledBack) {
            this.logger?.warn?.('[mira_account] 发送失败，已把 ' + peer.key + ' 的绑定回滚到发送前状态')
          } else if (undo.reason === 'peer-changed') {
            this.logger?.warn?.('[mira_account] 发送失败，但 ' + peer.key + ' 在这期间被 '
              + (undo.foreign || []).join(',') + ' 改动过，放弃回滚（避免抹掉别人的绑定）')
          } else if (undo.reason === 'account-gone') {
            this.logger?.warn?.('[mira_account] 发送失败且账号 ' + account.id + ' 已被删除，已清掉该 peer 的绑定')
          }
        } catch (restoreError) {
          this.noteError(restoreError)
        }
      }
      const normalized = toError(error, 'delivery/failed', '看 ' + account.platform + ' 适配器的日志与 qq_status / bili_status')
      this.noteError(normalized.error)
      throw new MiraError(normalized.error.code, normalized.error.message, normalized.error.hint)
    }

    const messageId = result && (result.messageId ?? result.id) !== undefined
      ? String(result.messageId ?? result.id) : null

    // 4. 自己发出去的 id 记成 self：平台回推同一条时按 echo 丢掉（功能点6 覆盖来源 1）
    if (messageId) this.dedup.markSelf(account.platform, seenKey(account.id, messageId))

    this.counters.bump('outbound.sent')
    this.logger?.info?.('[mira_account] 出站 ' + peer.key + ' 「' + preview(body.text ?? '[非文本]') + '」'
      + (messageId ? ' id=' + messageId : '') + (binding.mode !== 'none' ? ' binding=' + binding.action : ''))

    return {
      ok: true,
      accountId: account.id,
      kind: peer.kind,
      peerId: peer.peerId,
      messageId,
      binding: binding.mode === 'none' ? undefined : binding,
      raw: result && typeof result === 'object' ? undefined : result,
    }
  }

  /* ── 入站（契约 A：一律交给这里路由） ─────────────────── */

  /**
   * @param {object} input
   * @param {string} input.accountId
   * @param {string} input.kind
   * @param {string|number} input.peerId
   * @param {object} input.message         { id, text, sender, isSelf? }
   * @param {string} [input.display]       peername（inboundPolicy=create 时用作会话标题）
   * @param {{kind:string}} [input.source] 投递时写进 message.source 的来源（不给 = 'user'）
   */
  async inbound(input) {
    // 先把去重键算出来：账号可能在路由途中被删，事后用"当前账号"算 key 会算成 unknown，
    // 原来的占位就永远不释放（60s 内同 id 重推会被判 inflight 丢掉）。
    const entryAccount = this.store.getAccount(String(input?.accountId ?? '').trim())
    const dedupPlatform = entryAccount?.platform ?? 'unknown'
    const dedupKey = seenKey(entryAccount?.id ?? String(input?.accountId ?? '').trim(), input?.message?.id)
    try {
      const result = await this.router.route({
        accountId: String(input?.accountId ?? '').trim(),
        kind: String(input?.kind ?? '').trim(),
        peerId: normPeerId(input?.peerId),
        display: input?.display ?? '',
        message: input?.message ?? {},
        source: input?.source ?? null,
      })
      if (result && result.error) this.noteError(result.error)
      return result
    } catch (error) {
      // 路径上任何一处抛错（建会话失败、绑定冲突…）都撤销占位，否则同一条消息在占位 TTL 内重试不了
      try { this.dedup.release(dedupPlatform, dedupKey) } catch { /* 落盘失败已在 writeError 里 */ }
      const normalized = toError(error, 'delivery/failed')
      this.noteError(normalized.error)
      this.router.noteFailure(input?.accountId, normalized.error)
      this.logger?.warn?.('[mira_account] 入站路由失败：' + normalized.error.code + ' ' + normalized.error.message)
      return { routed: 'error', error: normalized.error }
    }
  }

  /* ── 去重（对 bot 插件的额外窗口） ─────────────────────── */

  /**
   * 只查不记：给 bot 插件自己的入站快路径用。
   * 语义是「先 verdict → 投递 → 成功再 recordSeen」，别再用 seen() 一步到位（那会先记账后投递）。
   */
  verdict(accountId, messageId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    return this.dedup.verdict(account?.platform ?? 'unknown', seenKey(account?.id ?? accountId, messageId))
  }

  /** 投递成功后登记（同时释放占位）。 */
  recordSeen(accountId, messageId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    return this.dedup.record(account?.platform ?? 'unknown', seenKey(account?.id ?? accountId, messageId))
  }

  /** 投递失败时撤销占位（之后同 id 还能再试）。 */
  releaseSeen(accountId, messageId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    if (!account) {
      // 账号已删：平台未知，到所有平台的占位表里按同一个键撤销（否则占位留到 60s TTL）
      return this.dedup.releaseAny(seenKey(String(accountId ?? '').trim(), messageId))
    }
    return this.dedup.release(account.platform, seenKey(account.id, messageId))
  }

  /** 查 + 记一步到位。**只在"查到就算处理完"的地方用**（例如原始事件缓冲），别用在投递路径上。 */
  seen(accountId, messageId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    return this.dedup.check(account?.platform ?? 'unknown', seenKey(account?.id ?? accountId, messageId)).duplicate === true
  }

  markSeen(accountId, messageId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    return this.dedup.record(account?.platform ?? 'unknown', seenKey(account?.id ?? accountId, messageId))
  }

  markSelf(accountId, messageId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    return this.dedup.markSelf(account?.platform ?? 'unknown', seenKey(account?.id ?? accountId, messageId))
  }

  /* ── 连接管理 ─────────────────────────────────────────── */

  /**
   * 按账号池逐个连。凭据存在就**在本进程内**交给适配器（不出现在返回值/日志里）。
   * 适配器 connect 抛错或返回 {ok:false,error} → 账号 state=error，错误进 status。
   */
  async connectAll() {
    const report = { connected: [], failed: [], skipped: [] }
    for (const account of this.store.listAccounts()) {
      if (!account.enabled) {
        report.skipped.push({ accountId: account.id, reason: 'account/disabled' })
        continue
      }
      const adapter = this.adapterFor(account.platform)
      if (!adapter) {
        this.store.setState(account.id, 'error', { code: 'platform/unsupported', message: '没有 ' + account.platform + ' 适配器' })
        report.failed.push({ accountId: account.id, error: { code: 'platform/unsupported', message: account.platform + ' 适配器未注册' } })
        continue
      }
      const outcome = await this.#connectOnce(account, adapter)
      if (outcome.ok) report.connected.push(account.id)
      else report.failed.push({ accountId: account.id, error: outcome.error })
    }
    return report
  }

  /** 适配器迟到时按平台补连（已经在线的跳过）。 */
  async connectPlatform(platform) {
    const report = { connected: [], failed: [], skipped: [] }
    const adapter = this.adapterFor(platform)
    if (!adapter) return report
    for (const account of this.store.listAccounts()) {
      if (account.platform !== platform) continue
      if (!account.enabled) {
        report.skipped.push({ accountId: account.id, reason: 'account/disabled' })
        continue
      }
      if (account.state === 'online') {
        report.skipped.push({ accountId: account.id, reason: 'already-online' })
        continue
      }
      const outcome = await this.#connectOnce(account, adapter)
      if (outcome.ok) report.connected.push(account.id)
      else report.failed.push({ accountId: account.id, error: outcome.error })
    }
    return report
  }

  /* ── 健康巡检与重连（P1-7） ───────────────────────────── */

  /**
   * 起巡检定时器：每 intervalMs 调一次 adapter.status(account) 刷新真实状态，
   * 并对 error/offline 的账号按指数退避重连。默认 30s，定时器 unref（不拖住进程退出）。
   */
  startHealthLoop(options = {}) {
    if (this.health.timer) return this.health
    const intervalMs = Math.max(5000, Number(options.intervalMs) || 30000)
    this.health.intervalMs = intervalMs
    this.health.running = true
    this.health.timer = setInterval(() => {
      this.runHealthCheck().catch((error) => {
        this.health.errors += 1
        this.noteError(error)
      })
    }, intervalMs)
    this.health.timer.unref?.()
    return this.health
  }

  stopHealthLoop() {
    if (this.health.timer) {
      clearInterval(this.health.timer)
      this.health.timer = null
    }
    this.health.running = false
    return this.health
  }

  /** 把不同 adapter 的 status() 形状归一成账号状态。判不出来就返回 null（不瞎改）。 */
  #deriveState(st) {
    if (!st || typeof st !== 'object') return null
    if (st.ok === false) return { state: 'error', error: st.error ?? { code: 'delivery/failed', message: '适配器 status 返回 ok:false' } }
    if (typeof st.state === 'string' && ['online', 'offline', 'error'].includes(st.state)) {
      return { state: st.state, error: st.error ?? null }
    }
    // qqbot：onebot.status() 的 connected = ws 是否连着；bilibili：connected = 是否已登录
    if (st.connected === true) return { state: 'online', error: null }
    if (st.connected === false) return { state: 'offline', error: null }
    return null
  }

  /** 跑一轮巡检（也可手动调用，测试用）。 */
  async runHealthCheck() {
    // setInterval 可重入：一轮巡检耗时超过 intervalMs 时不能叠着跑（否则同账号双连接）
    if (this.health.inProgress) return this.health
    this.health.inProgress = true
    try {
      return await this.#runHealthCheckOnce()
    } finally {
      this.health.inProgress = false
    }
  }

  async #runHealthCheckOnce() {
    const accounts = this.store.listAccounts()
    const reconnect = this.config.reconnect && typeof this.config.reconnect === 'object' ? this.config.reconnect : {}
    const reconnectEnabled = reconnect.enabled !== false
    const minMs = Math.max(1000, Number(reconnect.minMs) || 5000)
    const maxMs = Math.max(minMs, Number(reconnect.maxMs) || 300000)
    const now = Date.now()
    this.health.lastRunAt = nowIso(now)
    this.health.checks += 1

    for (const account of accounts) {
      if (!account.enabled) continue
      const adapter = this.adapterFor(account.platform)
      if (!adapter) continue

      // 1) 用适配器自己的 status() 刷新真实状态
      if (typeof adapter.status === 'function') {
        try {
          const st = await adapter.status(account)
          const derived = this.#deriveState(st)
          if (derived && derived.state !== account.state) {
            // 不能把 error（有具体诊断，如 creds/missing）降级成 offline（error:null）：
            // 那会让"凭据没了"看起来像"网络断了"，失败不再可见。
            if (derived.state === 'offline' && account.state === 'error') {
              this.logger?.info?.('[mira_account] 健康巡检：账号 ' + account.id + ' 链路离线，但保留原错误 '
                + (account.error?.code ?? '') + '（不降级为 offline）')
            } else {
              this.store.setState(account.id, derived.state, derived.error ?? null)
              this.counters.bump('health.state.' + derived.state)
              this.logger?.info?.('[mira_account] 健康巡检：账号 ' + account.id + ' ' + account.state + ' → ' + derived.state)
            }
          } else if (derived && derived.state === 'error' && derived.error) {
            this.store.setState(account.id, 'error', derived.error) // 保持 error 但刷新原因
          }
        } catch (error) {
          this.health.errors += 1
          this.counters.bump('health.statusFailed')
          this.logger?.warn?.('[mira_account] ' + account.id + ' 的适配器 status() 抛错：' + (error?.message ?? error))
        }
      }

      // 2) 断了就重连（指数退避；成功则清空退避）
      //    注意：上面可能刚改过 state，必须重新读一次（listAccounts 给的是副本）
      if (!reconnectEnabled) continue
      const fresh = this.store.getAccount(account.id) ?? account
      if (fresh.state !== 'error' && fresh.state !== 'offline') {
        this.retry.delete(account.id)
        continue
      }
      // 凭据/配置类错误重连没用（每次都会同样失败），只会刷日志 + 撞平台风控：交给人工
      const code = String(fresh.error?.code || '')
      if (/^(creds\/|config\/|platform\/unsupported|account\/)/.test(code)) {
        this.retry.delete(account.id)
        if (this.health.checks % 20 === 1) {
          this.logger?.warn?.('[mira_account] 账号 ' + account.id + ' 的错误需要人工处理（' + code + '），已暂停自动重连')
        }
        continue
      }
      const backoff = this.retry.get(account.id)
      if (backoff && now < backoff.nextAt) continue
      const outcome = await this.#connectOnce(fresh, adapter)
      if (outcome.ok) {
        this.retry.delete(account.id)
        this.health.reconnects += 1
        this.counters.bump('health.reconnected')
        this.logger?.info?.('[mira_account] 账号 ' + account.id + ' 重连成功')
      } else {
        const attempts = (backoff?.attempts ?? 0) + 1
        const delay = Math.min(maxMs, minMs * 2 ** (attempts - 1))
        this.retry.set(account.id, { attempts, nextAt: now + delay })
        this.counters.bump('health.reconnectFailed')
        this.logger?.warn?.('[mira_account] 账号 ' + account.id + ' 重连失败（第 ' + attempts + ' 次），'
          + Math.round(delay / 1000) + ' 秒后再试：' + (outcome.error?.code ?? ''))
      }
    }
    return this.health
  }

  /** 连一个账号：凭据存在就在进程内交给适配器（不回显），成功 state=online，失败记 error。 */
  /**
   * 同一账号同一时刻只允许一次 connect。
   * 没有它：connectAll（加载时）与健康巡检/适配器迟到补连会重叠，qq 会开出两条 ws ——
   * 同一条消息两份入站，正是去重表要兜的场景（就不该让它发生）。
   */
  #connectOnce(account, adapter) {
    const key = account.id
    const inflight = this.connecting.get(key)
    if (inflight) return inflight
    const task = this.#connectOne(account, adapter).finally(() => this.connecting.delete(key))
    this.connecting.set(key, task)
    return task
  }

  async #connectOne(account, adapter) {
    const creds = readCreds(this.baseDir, account.id, account.platform)
    try {
      const result = await adapter.connect(account, creds.ok ? creds.value : null)
      // 失败形状有两种：`{ok:false, error}`，以及**直接返回错误对象** `{code,message,hint}`
      // （mira_bilibili 的 catch 就是后者）。只认 ok:false 会把"凭据过期"记成 online —— 假在线，
      // 而且 creds/* 的错误永远进不了 account.error，于是每 30s 重连一次、永不停。
      const bareError = result && result.ok === undefined && typeof result.code === 'string'
        ? result
        : (result && result.error ? result.error : null)
      if ((result && result.ok === false) || bareError) {
        const error = bareError ?? { code: 'delivery/failed', message: 'connect 返回 ok:false' }
        this.store.setState(account.id, 'error', error)
        this.noteError(error)
        return { ok: false, error }
      }
      this.store.setState(account.id, 'online', null)
      return { ok: true }
    } catch (error) {
      const normalized = toError(error, 'delivery/failed', '看适配器日志')
      this.store.setState(account.id, 'error', normalized.error)
      this.noteError(normalized.error)
      return { ok: false, error: normalized.error }
    }
  }

  async disconnectAll() {
    for (const [platform, adapter] of this.adapters) {
      for (const account of this.store.listAccounts().filter((a) => a.platform === platform)) {
        try {
          await adapter.disconnect(account)
          this.store.setState(account.id, 'offline', null)
        } catch (error) {
          const normalized = toError(error, 'delivery/failed')
          this.logger?.warn?.('[mira_account] 断开 ' + platform + '/' + account.id + ' 失败：' + normalized.error.message)
        }
      }
    }
  }

  /**
   * 账号级暂停（给适配器用）：撞风控时调一次，之后该账号的所有出站都会被限流层拒。
   * `resumeAccount()` 立即恢复。以前 `Limiter.pause/resume` 没有任何入口，等于死代码。
   */
  pauseAccount(accountId, ms, reason = '') {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    if (!account) {
      throw new MiraError('account/not-found', '账号不存在：' + accountId, '先 mira_account_list 看有哪些账号')
    }
    const until = this.#limiterFor(account.id).pause(ms, reason)
    this.counters.bump('limit.paused')
    this.logger?.warn?.('[mira_account] 账号 ' + account.id + ' 暂停出站 ' + Math.round(ms / 1000) + ' 秒：' + reason)
    return { accountId: account.id, pausedUntil: until, reason }
  }

  resumeAccount(accountId) {
    const account = this.store.getAccount(String(accountId ?? '').trim())
    if (!account) {
      throw new MiraError('account/not-found', '账号不存在：' + accountId, '先 mira_account_list 看有哪些账号')
    }
    this.#limiterFor(account.id).resume()
    return { accountId: account.id, paused: false }
  }

  /* ── 观测（约定5） ─────────────────────────────────────── */

  noteError(error) {
    const e = error && error.error ? error.error : error
    this.lastError = {
      code: String(e?.code ?? 'unknown/error'),
      message: redact(e?.message ?? ''),
      at: nowIso(),
    }
    // 留最近 10 条：单槽会被下一条覆盖，排障时经常「原因被后面的错盖掉」
    if (!Array.isArray(this.lastErrors)) this.lastErrors = []
    this.lastErrors.push(this.lastError)
    if (this.lastErrors.length > 10) this.lastErrors.shift()
    this.counters.bump('error.' + this.lastError.code)
    return this.lastError
  }

  status() {
    const accounts = this.store.listAccounts()
    const bindings = this.store.bindings
    const bySession = {}
    for (const b of bindings) bySession[b.sessionId] = (bySession[b.sessionId] || 0) + 1
    const byPlatform = {}
    for (const platform of PLATFORMS) byPlatform[platform] = this.dedup.size(platform)
    const limits = {}
    for (const account of accounts) {
      // 没发过消息的账号也应该能看到"预算是多少"（以前懒建，status 里是空的）
      limits[account.id] = this.#limiterFor(account.id).snapshot()
    }
    return {
      ok: true,
      schemaVersion: 1,
      baseDir: this.baseDir,
      accounts: accounts.map((a) => this.#accountView(a)),
      bindingCount: bindings.length,
      takerCount: bindings.filter((b) => b.mode === 'taker').length,
      observerCount: bindings.filter((b) => b.mode === 'observer').length,
      bindingsBySession: bySession,
      adapters: [...this.adapters.keys()],
      dedup: { total: this.dedup.size(), self: this.dedup.selfSize(), byPlatform },
      limits,
      counters: this.counters.snapshot(),
      lastError: this.lastError,
      lastErrors: Array.isArray(this.lastErrors) ? this.lastErrors.slice() : [],
      // 写盘失败要能被看见：内存里的改动此时还没落盘，重启会丢
      writeError: this.store.writeError,
      health: {
        running: this.health.running,
        intervalMs: this.health.intervalMs,
        lastRunAt: this.health.lastRunAt,
        checks: this.health.checks,
        errors: this.health.errors,
        reconnects: this.health.reconnects,
        backoff: [...this.retry.entries()].map(([accountId, retry]) => ({
          accountId, attempts: retry.attempts, retryInSeconds: Math.max(0, Math.round((retry.nextAt - Date.now()) / 1000)),
        })),
      },
      // 排障三件套：每个账号的路由/投递计数与时间戳（分清"没人发/绑定错/投递失败"）
      byAccount: [...(this.router.stats || new Map()).entries()].map(([accountId, st]) => ({ accountId, ...st })),
      // 绑定明细（peer ↔ taker/observers），不用再去调 mira_account_bindings
      bindingPeers: this.store.findBindings().slice(0, 100).map((b) => ({
        accountId: b.accountId, kind: b.kind, peerId: b.peerId, mode: b.mode,
        sessionId: b.sessionId, boundBy: b.boundBy ?? null, updatedAt: b.updatedAt,
      })),
      warnings: {
        accounts: this.store.fatalError ? this.store.fatalError.error : null,
        bindings: this.store.bindingWarning,
        runtime: this.warnings.slice(-20),
        peersFailingDelivery: [...(this.router.peerFailures || new Map()).entries()]
          .map(([peer, count]) => ({ peer, consecutiveFailures: count })),
      },
      message: accounts.length === 0 ? '账号池是空的：在 ' + join(this.baseDir, 'accounts.json') + ' 里登记账号' : undefined,
    }
  }

  /* ── 内部 ─────────────────────────────────────────────── */

  #requirePeer(kind, peerId, platform = null) {
    const k = String(kind ?? '').trim().toLowerCase()
    if (!KINDS.includes(k)) {
      throw new MiraError('config/missing', 'peer kind 非法：' + JSON.stringify(kind), '可选 ' + KINDS.join(' / '))
    }
    const rawId = String(peerId ?? '').trim()
    if (!rawId) {
      throw new MiraError('config/missing', 'peerId 为空', 'QQ 号/群号/房间号都行，只要不是空字符串')
    }
    if (rawId.length > 200 || /[\s\u0000-\u001f]/.test(rawId)) {
      throw new MiraError('config/invalid', 'peerId 不像合法 id：' + JSON.stringify(rawId.slice(0, 60)),
        'peerId 不该含空白或控制字符（也能防日志伪造）')
    }
    if (platform) {
      const allowed = PLATFORM_KINDS[platform] || KINDS
      if (!allowed.includes(k)) {
        throw new MiraError('platform/unsupported',
          '平台 ' + platform + ' 没有 ' + k + ' 这种 peer（绑了也永远收不到消息）',
          '平台 ' + platform + ' 支持：' + allowed.join(' / '))
      }
    }
    const id = normPeerId(peerId)
    if (!id) {
      throw new MiraError('config/missing', 'peerId 不能为空', 'peerId 是平台侧的对象 id：QQ 号 / 群号 / B 站 mid / 直播间号')
    }
    return { kind: k, peerId: id, key: peerKey('', k, id).slice(1) }
  }

  #bindingView(sessionId, accountId, peer, mode) {
    return {
      sessionId,
      accountId,
      kind: peer.kind,
      peerId: peer.peerId,
      mode,
    }
  }

  #limiterFor(accountId) {
    let limiter = this.limiters.get(accountId)
    if (!limiter) {
      limiter = new Limiter(this.config.limits || {})
      this.limiters.set(accountId, limiter)
    }
    return limiter
  }

  #checkLimit(accountId, kind) {
    // Limiter.take 自己处理「全局暂停」与三档窗口，被拒时不消耗配额
    const verdict = this.#limiterFor(accountId).take(kind)
    if (!verdict.ok) {
      this.counters.bump('limit.rejected')
      throw new MiraError(verdict.code, verdict.message, verdict.hint)
    }
    return verdict
  }
}

/** 创建并加载一个服务（smoke 与 index.js 共用同一条构造路径）。 */
export function createService(options) {
  return new AccountService(options).load()
}

export { fail, preview }
