/**
 * mira_account / tools.js —— 对 agent 暴露的工具（任务书功能点9 的五个 + 账号池 CRUD 三个）
 *
 * 为什么 CRUD 也算工具：任务书功能点1 要求「新增 / 列出 / 启停 / 删除」。
 * 但**不提供写凭据的工具**（PLAN §3.3）：工具参数会进会话记录，凭据一经工具传递就等于回显。
 * 凭据只能手填 `creds/<id>.json`（600），工具只报 `creds/missing` 并给出文件路径。
 */

import { MiraError, textTool } from './kit.mjs'
import { join } from 'node:path'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })

/** 当前会话 id：在会话里调用工具时宿主会给 exec.agent。 */
function currentSessionId(exec) {
  const agent = exec && exec.agent
  if (!agent) return ''
  // **优先用活会话的 id**：resume / 克隆 / rekey 之后 `agent.id` 可能还是旧 id（实测：
  // 会话目录是 qq-mvpvzf70-01703d，而 exec.agent.id 报 qq-mvp8dqhy-smrami），拿它去绑定会让
  // taker 指向不存在的会话、每次发送都要 force、回信路由错位。`agent.session.id` 是会话日志的权威 id。
  const live = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  if (live) return live
  return typeof agent.id === 'string' ? agent.id : ''
}

function accountsFile(service) {
  return join(service.baseDir, 'accounts.json')
}

function credsFileHint(service, accountId) {
  return join(service.baseDir, 'creds', accountId + '.json')
}

export function registerTools(ctx, service) {
  const defs = []

  defs.push(textTool(
    'mira_account_list',
    '列出账号池里的所有账号：id / 平台 / 是否启用 / 连接状态 / 凭据是否就位（**不返回凭据内容**）/ 绑定数。'
    + '账号池为空时返回 account/none 并告诉你去哪个文件登记。',
    obj({}),
    async () => {
      const accounts = service.listAccounts()
      if (accounts.length === 0) {
        throw new MiraError('account/none',
          '账号池是空的（一个账号都没登记）',
          '在 ' + accountsFile(service) + ' 里登记账号；本插件不会自动创建、也不会自动登录')
      }
      return {
        ok: true,
        count: accounts.length,
        accountsFile: accountsFile(service),
        accounts,
      }
    },
  ))

  defs.push(textTool(
    'mira_account_status',
    '账号框架的只读状态：路径、账号与连接状态、绑定统计、已注册的适配器、各平台去重表大小、'
    + '限流余量、错误计数、最近一次错误。配置坏了（schemaVersion 不符）也在这里如实报告 —— 它不会因此调用失败。',
    obj({}),
    async () => service.status(),
  ))

  defs.push(textTool(
    'mira_account_bind',
    '把**一个会话**绑定到一个平台对象（peer），决定「对端发来的消息进哪个会话」。'
    + 'mode=taker 表示该会话负责应答（同一 peer 只允许一个 taker）；observer 表示只旁听不自动应答。'
    + '不给 sessionId 就用当前会话。同 peer 已被别的会话应答时报 binding/conflict，'
    + '要抢加 force:true，只旁听加 observer:true。',
    obj({
      accountId: str('账号 id（见 mira_account_list），例如 qq-main'),
      kind: str('peer 类型：user / group / channel / room / avatar（vtuber 只有 avatar）'),
      peerId: str('平台侧对象 id：QQ 号 / 群号 / B 站 mid / 直播间号'),
      sessionId: str('要绑定的会话 id；不给则用当前会话'),
      mode: { type: 'string', enum: ['taker', 'observer'], description: 'taker=应答（默认），observer=只收' },
      force: bool('抢走别人正在应答的 taker（原 taker 降级为 observer）'),
      observer: bool('等价于 mode=observer，但用于把冲突改成旁听'),
    }, ['accountId', 'kind', 'peerId']),
    async (args, exec) => {
      const sessionId = String(args.sessionId || '').trim() || currentSessionId(exec)
      const result = service.bind({
        sessionId,
        accountId: args.accountId,
        kind: args.kind,
        peerId: args.peerId,
        mode: args.mode,
        force: args.force === true,
        observer: args.observer === true,
        // 审计：记下"是哪个会话发起的绑定"（入站自动登记时没有这个字段）
        boundBy: currentSessionId(exec),
      })
      return { ...result, accountsFile: accountsFile(service) }
    },
  ))

  defs.push(textTool(
    'mira_account_unbind',
    '解除绑定。至少给一个条件（sessionId / accountId / kind / peerId）；'
    + '不给 sessionId 时**不会**默认用当前会话（避免误删别的绑定），要删当前会话的绑定请显式传 sessionId。'
    + '幂等：没有命中时返回 removed:0。',
    obj({
      sessionId: str('会话 id'),
      accountId: str('账号 id'),
      kind: str('peer 类型：user / group / channel / room / avatar（vtuber 只有 avatar）'),
      peerId: str('平台侧对象 id'),
    }),
    async (args) => {
      const query = {}
      for (const key of ['sessionId', 'accountId', 'kind', 'peerId']) {
        if (args[key] !== undefined && String(args[key]).trim() !== '') query[key] = args[key]
      }
      if (Object.keys(query).length === 0) {
        throw new MiraError('config/missing',
          'unbind 至少要给一个条件',
          '给 sessionId（会话的全部绑定）、或 accountId+kind+peerId（某个 peer 的全部绑定）')
      }
      return { ok: true, ...service.unbind(query) }
    },
  ))

  defs.push(textTool(
    'mira_account_bindings',
    '查绑定表（双向可查）：给 sessionId 看这个会话绑了哪些 peer；'
    + '给 accountId+kind+peerId 看这个 peer 归哪个会话应答、还有谁在旁听；都不给就列全部。',
    obj({
      sessionId: str('会话 id'),
      accountId: str('账号 id'),
      kind: str('peer 类型'),
      peerId: str('平台侧对象 id'),
    }),
    async (args) => {
      // 过滤条件**全部**透传：以前只给 accountId 时会被静默丢掉、返回全表
      // （排障时会把"全表"误读成"这个账号的绑定"）。
      const filter = {}
      for (const key of ['sessionId', 'accountId', 'kind', 'peerId']) {
        if (args[key] !== undefined && String(args[key]).trim()) filter[key] = String(args[key]).trim()
      }
      if (Object.keys(filter).length === 0) {
        // 无参 = 看全表（README/工具描述一直这么承诺；排障时最常用）
        const rows = service.bindings({})
        return {
          ok: true,
          count: rows.length,
          note: '没有过滤条件：返回全部绑定（最多 200 条）。用 sessionId 或 accountId+kind+peerId 缩小范围',
          bindings: rows.slice(0, 200),
        }
      }
      const rows = service.bindings(filter)
      const out = { ok: true, count: rows.length, filter, bindings: rows }
      if (filter.accountId !== undefined && filter.kind !== undefined && filter.peerId !== undefined) {
        out.resolved = service.resolve(filter.accountId, filter.kind, filter.peerId)
      }
      return out
    },
  ))

  /* ── 账号池 CRUD（功能点1；凭据仍只允许手填） ─────────── */

  defs.push(textTool(
    'mira_account_add',
    '登记一个账号**行**（不含凭据）。登记后会自动尝试连接（autoConnect 默认开）：'
    + 'qq 走 wsUrl 不需要凭据，通常直接 online；需要凭据的平台（bilibili）在 creds 缺失时报 creds/missing。'
    + '凭据手填到 creds/<id>.json（600 权限，工具不接受凭据参数 —— 避免凭据经过会话记录）。',
    obj({
      id: str('账号 id，只允许字母数字与 . _ -，例如 qq-main'),
      platform: { type: 'string', enum: ['qq', 'wx', 'bilibili', 'vtuber'], description: '平台（vtuber = 本地虚拟账号，给形象当权限主体）' },
      label: str('显示名（可选，默认同 id）'),
      inboundPolicy: { type: 'string', enum: ['create', 'default', 'drop'], description: '无绑定时怎么处理入站消息（默认 create）' },
      defaultSessionId: str('inboundPolicy=default 时投给哪个会话'),
    }, ['id', 'platform']),
    async (args) => {
      const account = service.addAccount({
        id: args.id,
        platform: args.platform,
        label: args.label,
        inboundPolicy: args.inboundPolicy,
        defaultSessionId: args.defaultSessionId,
      })
      return {
        ok: true,
        account,
        // 本地虚拟账号（vtuber）不需要凭据：别让人去找一个根本不存在的文件
        next: account.adapter === false && account.platform === 'vtuber'
          ? '这是本地虚拟账号（形象本身），不需要连接也不需要凭据：直接等消费方按 peer（kind=avatar）绑定即可'
          : '手填凭据到 ' + credsFileHint(service, account.id) + '（权限 600；内容格式见 README）',
      }
    },
  ))

  defs.push(textTool(
    'mira_account_remove',
    '从账号池删除账号，**同时删掉它名下的全部绑定**。凭据文件不会自动删除（要删请手工删；'
    + '本工具不碰文件，避免误删）。',
    obj({ accountId: str('要删除的账号 id') }, ['accountId']),
    async (args) => ({ ok: true, ...service.removeAccount(args.accountId) }),
  ))

  defs.push(textTool(
    'mira_account_toggle',
    '启用或停用一个账号（停用后该账号的入站按 account/disabled 丢弃并计数，出站直接报错）。',
    obj({
      accountId: str('账号 id'),
      enabled: bool('true=启用，false=停用'),
    }, ['accountId', 'enabled']),
    async (args) => {
      // 严格解析布尔：以前 `enabled: "false"`（字符串）会被当成 true —— 想停用反而启用了
      const raw = args.enabled
      const enabled = raw === true || raw === 1 || raw === 'true' || raw === '1'
      if (!(raw === false || raw === 0 || raw === 'false' || raw === '0' || enabled)) {
        throw new MiraError('config/invalid', 'enabled 必须是布尔：' + JSON.stringify(raw),
          '传 true/false（不要传 "no" / "off" 这类字符串）')
      }
      return { ok: true, account: service.setAccountEnabled(args.accountId, enabled) }
    },
  ))

  const disposers = defs.map((def) => ctx.tools.register(def))
  return () => disposers.forEach((d) => { try { d() } catch { /* noop */ } })
}
