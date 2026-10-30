/**
 * mira_account — 账号管理框架（账号池 + 会话绑定 + 消息路由 + 去重限流）
 *
 * 为什么有这个插件：
 *   qq / 微信 / B 站三个 bot 各自需要「哪个账号、哪个会话在应答谁」这套东西。
 *   以前每个 bot 各写一份 chatId→sessionId 映射，于是「没绑定的会话发出去就回不来」
 *   （任务书 §mira_account 的原话）。现在这套关系只有一份：binding 表。
 *
 * 对外提供 cordis 服务 `miraAccount`（bot 插件 inject 它，见 README「给 bot 插件的契约」）。
 *
 * 落盘（`$DSH_HOME/mira_config/mira_account/`，DSH_HOME 缺省 ~/.dsh）：
 *   accounts.json  账号池（不含凭据本体）
 *   bindings.json  绑定表（坏了不致命，可从账号重建）
 *   creds/<id>.json 凭据本体，600，永不回显、不进日志
 *   seen/<platform>.json message_id 去重表（带 TTL）
 *
 * 只依赖 Node 内置能力。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  claimInstance, deepMerge, ensureDir, fail, miraConfigDir, toError,
} from './kit.mjs'
import { createService } from './service.js'
import { acquireProcessLock } from './lock.js'
import { registerTools } from './tools.js'

export const name = 'mira_account'

/**
 * 投递要能把消息塞进会话，所以这三个服务是硬依赖。
 * 缺了它们插件不会加载（工具全消失）——比「起来了但投不进去」容易排查得多。
 */
export const inject = ['tools', 'sessionController', 'sessions']

const DEFAULTS = {
  enabled: true,
  // 加载后自动连所有 enabled 账号（关掉只是不自动连，工具仍然工作）
  autoConnect: true,
  limits: {
    // 0 / 缺省 = 不限。bilibili 的预算是它自己插件内的权威闸门（任务书功能点4），这里是通用兜底。
    read: { perMinute: 0, perHour: 0, perDay: 0 },
    write: { perMinute: 0, perHour: 0, perDay: 0 },
  },
  dedup: { ttlMs: 30 * 60 * 1000, maxEntries: 5000 },
  /**
   * 健康巡检（P1-7）：定时调 adapter.status() 刷新账号真实状态。
   * 没有它，state 会永远停在 connect 那一刻（"假在线"），而 status() 也看不出断线。
   */
  health: { enabled: true, intervalMs: 30000 },
  /** 断线重连：error/offline 的账号按指数退避重连（min × 2^n，封顶 max）。 */
  reconnect: { enabled: true, minMs: 5000, maxMs: 300000 },
}

const INSTANCE_ID = 'mira_account'

/**
 * 旁听提示：由框架统一加在正文最前面。
 * 用一句话说清「你是谁、别回、想接管怎么办」——bot 插件不用自己拼。
 */
const OBSERVER_NOTICE = '（框架提示：这个会话在该对话线上只是**旁听者**，这条消息不需要你回复；'
  + '要接管这条线请调用 mira_account_bind 并带 force:true）'

/**
 * 造一条用户消息（steer/followup 都吃这个形状）。
 * source.kind 默认 'user'（它确实是一条对端用户消息），bot 插件可以用 `inbound({source})`
 * 覆盖成自己（如 'mira_bilibili'）—— 宿主 RuntimeContextProjection 只认这个 kind。
 */
function makeUserMessage(text, source = null) {
  const kind = source && typeof source.kind === 'string' && source.kind.trim() !== ''
    ? source.kind.trim()
    : 'user'
  return {
    id: 'miraacct-' + randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  }
}

/**
 * 把服务包成给 bot 插件用的门面。
 * 刻意不暴露 store / dedup 内部对象：bot 插件只该走这 12 个入口，
 * 免得哪天有人绕过 bind 直接改 bindings（那就又回到「每个 bot 各一套映射」了）。
 */
function createApi(service) {
  return Object.freeze({
    version: 2, // 2: verdict 占位 + recordSeen/releaseSeen + deliver(meta.mode)
    baseDir: service.baseDir,
    // 适配器
    registerAdapter: (adapter) => service.registerAdapter(adapter),
    adapterFor: (platform) => service.adapterFor(platform),
    // 账号池
    listAccounts: () => service.listAccounts(),
    requireAccount: (accountId) => service.requireAccount(accountId),
    requireAdapter: (platform) => service.requireAdapter(platform),
    addAccount: (input) => service.addAccount(input),
    removeAccount: (accountId) => service.removeAccount(accountId),
    setAccountEnabled: (accountId, enabled) => service.setAccountEnabled(accountId, enabled),
    setState: (accountId, state, error) => service.store.setState(accountId, state, error),
    // 绑定
    bind: (input) => service.bind(input),
    unbind: (query) => service.unbind(query),
    bindings: (sessionId) => service.bindings(sessionId),
    resolve: (accountId, kind, peerId) => service.resolve(accountId, kind, peerId),
    // 收发
    send: (input) => service.send(input),
    inbound: (input) => service.inbound(input),
    // 去重
    // 入站快路径请用 verdict → 投递 → recordSeen，不要用 seen（那会先记账后投递）
    verdict: (accountId, messageId) => service.verdict(accountId, messageId),
    recordSeen: (accountId, messageId) => service.recordSeen(accountId, messageId),
    releaseSeen: (accountId, messageId) => service.releaseSeen(accountId, messageId),
    seen: (accountId, messageId) => service.seen(accountId, messageId),
    markSeen: (accountId, messageId) => service.markSeen(accountId, messageId),
    markSelf: (accountId, messageId) => service.markSelf(accountId, messageId),
    // 观测
    noteError: (error) => service.noteError(error),
    status: () => service.status(),
    setCreateSession: (fn) => service.setCreateSession(fn),
  })
}

export function apply(ctx, config) {
  const logger = ctx.logger || null
  const cfg = deepMerge(structuredClone(DEFAULTS), config || {})

  if (cfg.enabled === false) {
    logger?.info?.('[mira_account] 已禁用（config.enabled = false），不注册工具、不提供服务')
    return fail('plugin/disabled', 'mira_account 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // 约定6 单实例：同一 plugin id 只允许一个实例生效（否则适配器/定时器翻倍）
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_account] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '重复加载会让同一平台的适配器注册两次、投递翻倍。检查 profile 里是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'mira_account 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_account 挂了两遍；一个进程只允许一个实例')
  }

  const baseDir = miraConfigDir('mira_account')
  let procLock = null
  try {
    ensureDir(baseDir)
    // 跨进程锁：claimInstance 只管进程内；两个 DSH 进程各连一次 QQ 会各回一遍
    procLock = acquireProcessLock(baseDir, { logger })
    if (!procLock.ok) {
      try { claim.release() } catch { /* noop */ }
      return fail(procLock.error.code, procLock.error.message, procLock.error.hint)
    }
  } catch (error) {
    try { claim.release() } catch { /* noop */ }
    return fail('config/missing', '无法创建配置目录：' + baseDir + '（' + (error?.message ?? String(error)) + '）',
      '检查该路径的权限 —— mira_account 的账号池/绑定/去重表都写在这里')
  }

  let sessionsSvc = null
  let sessionControllerSvc = null
  try { sessionsSvc = ctx.sessions || null } catch { sessionsSvc = null }
  try { sessionControllerSvc = ctx.sessionController || null } catch { sessionControllerSvc = null }

  async function resolveAgent(sessionId) {
    if (!sessionControllerSvc || typeof sessionControllerSvc.resolveAgent !== 'function') {
      throw new Error('sessionController.resolveAgent 不可用')
    }
    const result = await sessionControllerSvc.resolveAgent(sessionId)
    if (result && result.agent) return result.agent
    const err = result && result.error
    throw new Error('resolveAgent 失败：' + (err && (err.message || err.code) ? (err.message || err.code) : String(err)))
  }

  /**
   * 投递（任务书功能点5 / 约定「steer 插话」）：
   * 会话空闲 → 立刻开一轮；会话在跑 → 插到最近一步。**不排队等下一轮**。
   */
  /**
   * 投递。meta 由 router 传进来（`mode: 'taker' | 'observer' | 'default'`）：
   * 旁听会话必须靠**框架**把语义写进正文 —— 不能指望每个 bot 插件各自拼提示词
   * （bilibili 就没拼，旁听会话收到一条没有任何角色标记的用户消息，自然会抢话）。
   */
  async function deliver(sessionId, text, meta = {}) {
    const agent = await resolveAgent(sessionId)
    if (!agent || typeof agent.steer !== 'function') {
      throw new Error('agent.steer 不可用（会话 ' + sessionId + '）')
    }
    const body = meta && meta.mode === 'observer'
      ? OBSERVER_NOTICE + '\n\n' + text
      : text
    agent.steer(makeUserMessage(body, meta && meta.source))
    // 与内置 dsh-schedule 一样跟一次 flush，确认这轮投递真的落盘（失败不算投递失败）
    try {
      if (sessionsSvc && typeof sessionsSvc.flush === 'function' && agent.session) await sessionsSvc.flush(agent.session)
    } catch { /* 日志由宿主出 */ }
  }

  let service
  try {
    service = createService({ baseDir, config: cfg, logger, deliver })
  } catch (error) {
    try { claim.release() } catch { /* noop */ }
    const normalized = toError(error, 'unknown/error')
    return fail(normalized.error.code, 'mira_account 装配失败：' + normalized.error.message,
      normalized.error.hint || '看 DSH 启动日志；这条失败发生在注册服务之前')
  }

  let disposeProvide = () => {}
  let disposeTools = () => {}
  try {
    // 对外提供服务：bot 插件 `inject: ['miraAccount']` 即可拿到（约定「契约」三条的前提）
    disposeProvide = ctx.provide('miraAccount', createApi(service))
    disposeTools = registerTools(ctx, service)
  } catch (error) {
    // 半初始化就抛：把已建立的清理掉、把认领放回去，否则修好后重载会得到 plugin/instance（只能重启 DSH）
    try { disposeProvide?.() } catch { /* noop */ }
    try { service.dispose() } catch { /* noop */ }
    try { procLock?.release() } catch { /* noop */ }
    try { claim.release() } catch { /* noop */ }
    const normalized = toError(error, 'unknown/error')
    return fail(normalized.error.code, 'mira_account 注册服务/工具失败：' + normalized.error.message,
      normalized.error.hint || '看 DSH 启动日志')
  }

  if (cfg.health && cfg.health.enabled !== false) {
    service.startHealthLoop({ intervalMs: cfg.health.intervalMs })
    logger?.info?.('[mira_account] 健康巡检已启动：每 ' + Math.max(5, Math.round((Number(cfg.health.intervalMs) || 30000) / 1000)) + ' 秒查一次适配器状态'
      + (cfg.reconnect && cfg.reconnect.enabled !== false ? '，断线自动重连' : '（重连已关闭）'))
  }

  logger?.info?.('[mira_account] 已加载：账号 ' + service.store.listAccounts().length + ' 个，绑定 '
    + service.store.bindings.length + ' 条，配置目录 ' + baseDir
    + (service.store.fatalError ? '；⚠ accounts.json 有问题，见 mira_account_status.warnings' : ''))

  if (cfg.autoConnect !== false) {
    // 不 await：连接失败不该阻塞插件加载（失败会写进账号 state 与 status）
    service.connectAll().then((report) => {
      if (report.connected.length || report.failed.length) {
        logger?.info?.('[mira_account] 自动连接：成功 ' + report.connected.length + ' / 失败 '
          + report.failed.length + (report.failed.length ? '（' + report.failed.map((f) => f.accountId + ':' + f.error.code).join(', ') + '）' : ''))
      }
    }).catch((error) => {
      logger?.warn?.('[mira_account] 自动连接异常：' + (error && error.message ? error.message : String(error)))
    })
  }

  ctx.effect(() => () => {
    // 卸载顺序：停巡检 → 断开适配器 → 落盘 → 放服务 → 最后放实例认领。
    // 最后才 release，是为了让"新实例 load 到的永远是最新文件"（约定9 的踩坑点）成立。
    try { disposeTools?.() } catch { /* noop */ }
    try { service.stopHealthLoop() } catch { /* noop */ }
    // 同步落盘放最前面：这一步不依赖调用方 await，保证"卸载即落盘"（约定9）
    try { service.flush() } catch { /* noop */ }
    return (async () => {
      try { await service.disconnectAll() } catch { /* 退场不抛 */ }
      try { service.dispose() } catch { /* 退场不抛 */ }
      try { disposeProvide?.() } catch { /* noop */ }
      try { procLock?.release() } catch { /* noop */ }
      try { claim.release() } catch { /* noop */ }
    })()
  })

  return { ok: true, baseDir, accounts: service.store.listAccounts().length }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  DEFAULTS,
  makeUserMessage,
  createApi,
  defaults: () => structuredClone(DEFAULTS),
  configDir: () => miraConfigDir('mira_account'),
  accountsFile: (base) => join(base || miraConfigDir('mira_account'), 'accounts.json'),
  credsFileExists: (base, id) => existsSync(join(base || miraConfigDir('mira_account'), 'creds', id + '.json')),
}
