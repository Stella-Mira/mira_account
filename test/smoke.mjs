/**
 * mira_account 自检：node test/smoke.mjs
 *
 * 全过 → 退出码 0，末行 `==== ALL PASS（N 项）====`；
 * 有失败 → 逐行打印 `[FAIL] 编号 说明`，退出码 1。
 *
 * 覆盖 tool_shared/PLAN.md §1.1 的 A1–A14：
 *   A2  空账号池 → account/none（插件仍然加载）
 *   A3  登记账号但没凭据 → state=error / creds/missing
 *   A4–A7  绑定：taker / 冲突 / force 抢答 / observer 旁听
 *   A8  入站去重：同 message_id 第二次不重复投递
 *   A9  无绑定 + inboundPolicy=drop → 丢弃并计数
 *   A10 无绑定 + inboundPolicy=create → 建会话并自动登记 taker
 *   A11 首次 send 自动反向绑定
 *   A12 另一个会话 send 同一 peer → binding/conflict 且不发出去
 *   A13 凭据 600、任何工具输出都不含凭据明文
 *   A14 schemaVersion 不符 → 拒绝该文件，status 报 config/schema
 * 另加：适配器契约校验、steer（不是 followup）、自身 echo 去重、限流、单实例。
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ── 测试小框架 ─────────────────────────────────────────── */

let passed = 0
const failures = []
let current = '(未命名)'

function check(ok, message) {
  if (ok) { passed++; return true }
  failures.push('[' + current + '] ' + message)
  return false
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return check(a === e, message + '（期望 ' + e + '，实得 ' + a + '）')
}

async function test(id, name, fn) {
  current = id + ' ' + name
  try {
    await fn()
  } catch (error) {
    failures.push('[' + current + '] 抛异常：' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error)))
  }
}

/* ── 隔离环境：每轮一个临时 DSH_HOME ───────────────────── */

const TMP = mkdtempSync(join(tmpdir(), 'mira-account-smoke-'))
process.env.DSH_HOME = TMP
const BASE = join(TMP, 'mira_config', 'mira_account')

const logLines = []
const silentLogger = {
  info: (m) => logLines.push('I ' + m),
  warn: (m) => logLines.push('W ' + m),
  error: (m) => logLines.push('E ' + m),
  debug: () => {},
}

/** 假 agent：记录 steer / followup 次数，用来断言「走的是插话，不是排队」。 */
function makeAgent(id) {
  const record = { id, steers: [], followups: 0, status: 'idle', session: { id } }
  record.steer = (message) => { record.steers.push(message); record.status = 'running' }
  record.followup = () => { record.followups++ }
  record.cancel = () => {}
  return record
}

function makeCtx() {
  const tools = new Map()
  const agents = new Map()
  const disposers = []
  const provided = new Map()
  const ctx = {
    logger: silentLogger,
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    effect(fn) {
      const d = fn()
      disposers.push(d)
      return () => {}
    },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    sessionController: {
      async resolveAgent(sessionId) {
        if (!agents.has(sessionId)) agents.set(sessionId, makeAgent(sessionId))
        return { agent: agents.get(sessionId) }
      },
    },
    sessions: { async flush() {} },
    agentFor(sessionId) {
      if (!agents.has(sessionId)) agents.set(sessionId, makeAgent(sessionId))
      return agents.get(sessionId)
    },
    dispose() {
      for (const d of disposers.reverse()) { try { if (typeof d === 'function') d() } catch { /* noop */ } }
    },
    toolsMap: tools,
    provided,
  }
  return ctx
}

async function callTool(ctx, name, args = {}, exec = {}) {
  const def = ctx.toolsMap.get(name)
  if (!def) throw new Error('工具未注册：' + name + '（已注册：' + [...ctx.toolsMap.keys()].join(', ') + '）')
  const text = await def.execute(args, exec)
  return JSON.parse(text)
}

/** 假 qq 适配器：记录出站，能按需失败。 */
function makeAdapter(platform = 'qq', options = {}) {
  const state = { sent: [], connected: [], inbound: null, seq: 0, failNext: false }
  return {
    platform,
    state,
    async connect(account, creds) {
      state.connected.push({ accountId: account.id, hasCreds: !!creds })
      if (options.connectFails) return { ok: false, error: { code: 'creds/missing', message: '没有 access_token' } }
      return { ok: true }
    },
    async disconnect() {},
    async send(account, kind, peerId, payload) {
      if (state.failNext) { state.failNext = false; throw Object.assign(new Error('winsock 断了'), { code: 'delivery/failed' }) }
      state.seq++
      state.sent.push({ accountId: account.id, kind, peerId, payload })
      return { ok: true, messageId: 'self-' + state.seq }
    },
    onMessage(_account, cb) { state.inbound = cb; return () => { state.inbound = null } },
    async status() { return { connected: true } },
    async createSession(info) { state.created = info; return 'session-created-' + info.peerId },
  }
}

const { apply } = await import('../lib/index.js')
const { writeCreds } = await import('../lib/creds.js')

const ctx = makeCtx()
const applied = apply(ctx, { autoConnect: false })

/* ── A2 空账号池 ────────────────────────────────────────── */

await test('A2', '空账号池：插件已加载，list 返回 account/none', async () => {
  check(applied && applied.ok === true, 'apply 应成功（空配置也要加载）：' + JSON.stringify(applied))
  // provide 在 apply 里就做了：bot 插件 `inject: ['miraAccount']` 才有东西可拿
  check(ctx.provided.has('miraAccount'), '必须 provide miraAccount 服务（bot 插件 inject 它）')
  const listed = await callTool(ctx, 'mira_account_list')
  eq(listed.ok, false, 'list 应失败')
  eq(listed.error.code, 'account/none', '错误码应是 account/none')
  check(String(listed.error.hint || '').includes('accounts.json'), 'hint 要指出 accounts.json：' + listed.error.hint)
})

/* ── A3 登记账号但没有凭据 ──────────────────────────────── */

await test('A3', '登记账号无凭据：state=error / creds/missing', async () => {
  const added = await callTool(ctx, 'mira_account_add', { id: 'qq-main', platform: 'qq', label: '主号' })
  check(added.ok === true, 'add 应成功：' + JSON.stringify(added))
  eq(added.account.state, 'error', '新账号 state 应为 error')
  eq(added.account.error.code, 'creds/missing', '错误码应为 creds/missing')
  check(String(added.next).includes('creds/qq-main.json'), 'next 要给出凭据文件路径：' + added.next)

  const status = await callTool(ctx, 'mira_account_status')
  eq(status.ok, true, 'status 在配置不全时也必须能读')
  eq(status.accounts[0].creds.present, false, 'status 里 creds.present 应为 false')
  eq(status.accounts[0].adapter, false, '还没注册适配器 → adapter:false')
  eq(status.adapters.length, 0, '适配器列表应为空')
})

/* ── 适配器契约 ─────────────────────────────────────────── */

await test('A15', '适配器契约校验与单平台唯一', async () => {
  const api = ctx.provided.get('miraAccount')
  let err = null
  try { api.registerAdapter({ platform: 'telegram', connect() {}, disconnect() {}, send() {}, onMessage() {}, status() {} }) } catch (e) { err = e }
  eq(err && err.code, 'platform/unsupported', '未登记的平台应报 platform/unsupported')

  err = null
  try { api.registerAdapter({ platform: 'qq', connect() {} }) } catch (e) { err = e }
  eq(err && err.code, 'platform/unsupported', '缺方法的适配器应报 platform/unsupported')

  const adapter = makeAdapter('qq')
  api.registerAdapter(adapter)
  err = null
  try { api.registerAdapter(makeAdapter('qq')) } catch (e) { err = e }
  eq(err && err.code, 'platform/duplicate', '同平台第二个适配器应报 platform/duplicate')

  const status = await callTool(ctx, 'mira_account_status')
  eq(status.adapters, ['qq'], 'status 应显示已注册 qq')
})

/* ── A4–A7 绑定语义 ─────────────────────────────────────── */

await test('A4', '绑定 taker', async () => {
  const bound = await callTool(ctx, 'mira_account_bind', { accountId: 'qq-main', kind: 'user', peerId: 1000, sessionId: 'S1' })
  eq(bound.ok, true, 'bind 应成功')
  eq(bound.binding.mode, 'taker', 'mode 应为 taker')
  check(existsSync(join(BASE, 'bindings.json')), 'bindings.json 应落盘')
})

await test('A5', '同 peer 再绑另一个会话 → binding/conflict', async () => {
  const conflict = await callTool(ctx, 'mira_account_bind', { accountId: 'qq-main', kind: 'user', peerId: '1000', sessionId: 'S2' })
  eq(conflict.ok, false, '应冲突')
  eq(conflict.error.code, 'binding/conflict', '错误码应是 binding/conflict')
  check(String(conflict.error.hint).includes('force'), 'hint 要教怎么抢：' + conflict.error.hint)
})

await test('A6', '冲突后 force 抢答：taker 换人，旧的降级 observer', async () => {
  const forced = await callTool(ctx, 'mira_account_bind', { accountId: 'qq-main', kind: 'user', peerId: '1000', sessionId: 'S2', force: true })
  eq(forced.ok, true, 'force 应成功')
  eq(forced.action, 'forced', 'action 应为 forced')
  eq(forced.previousTaker, 'S1', '应报出被抢的会话')
  const resolved = await callTool(ctx, 'mira_account_bindings', { accountId: 'qq-main', kind: 'user', peerId: '1000' })
  eq(resolved.resolved.taker.sessionId, 'S2', 'taker 应换成 S2')
  eq(resolved.resolved.observers.map((o) => o.sessionId), ['S1'], 'S1 应降级为 observer')
})

await test('A7', 'observer 只旁听，不抢 taker', async () => {
  const obs = await callTool(ctx, 'mira_account_bind', { accountId: 'qq-main', kind: 'user', peerId: '1000', sessionId: 'S3', observer: true })
  eq(obs.ok, true, 'observer 应成功')
  eq(obs.binding.mode, 'observer', 'mode 应为 observer')
  const resolved = await callTool(ctx, 'mira_account_bindings', { accountId: 'qq-main', kind: 'user', peerId: '1000' })
  eq(resolved.resolved.taker.sessionId, 'S2', 'taker 仍是 S2')
  eq(resolved.resolved.observers.length, 2, '应有两个 observer')
})

/* ── A8 入站去重 + steer 投递 ───────────────────────────── */

await test('A8', '入站投给 taker（steer），同 message_id 第二次为 dup', async () => {
  const api = ctx.provided.get('miraAccount')
  const takerAgent = ctx.agentFor('S2')

  const first = await api.inbound({ accountId: 'qq-main', kind: 'user', peerId: '1000', message: { id: 'm1', text: '在吗' } })
  eq(first.routed, 'taker', '第一次应路由到 taker：' + JSON.stringify(first))
  eq(takerAgent.steers.length, 1, 'steer 应被调用 1 次')
  eq(takerAgent.followups, 0, '不允许走 followup（那是整轮排队，任务书要求 steer）')
  eq(takerAgent.steers[0].content[0].text, '在吗', '投递内容应是消息文本')
  eq(takerAgent.steers[0].source.kind, 'user', '消息必须带 source（否则宿主 RuntimeContextProjection 崩）')

  const second = await api.inbound({ accountId: 'qq-main', kind: 'user', peerId: '1000', message: { id: 'm1', text: '在吗' } })
  eq(second.routed, 'dup', '第二次应是 dup')
  eq(takerAgent.steers.length, 1, '重复消息不应再次 steer')

  // 口径（任务书功能点5）：有 taker 时只投 taker；observer 是「只有 observer 时」才收
  eq(ctx.agentFor('S3').steers.length, 0, '有 taker 时 observer 不重复收一份（否则等于两个会话各回一句）')
})

await test('A8b', 'bot 插件可以用 inbound({source}) 指定消息来源；不传则回落 user', async () => {
  const api = ctx.provided.get('miraAccount')
  const agent = ctx.agentFor('S2')
  const before = agent.steers.length

  const tagged = await api.inbound({
    accountId: 'qq-main',
    kind: 'user',
    peerId: '1000',
    message: { id: 'm-src-1', text: '带来源的消息' },
    source: { kind: 'mira_bilibili' },
  })
  eq(tagged.routed, 'taker', '带 source 的入站仍应投给 taker')
  eq(agent.steers[before].source.kind, 'mira_bilibili', 'source.kind 应透传到 message.source')

  // 空 / 非法 source 回落 'user'：老插件不传也不会崩
  await api.inbound({
    accountId: 'qq-main',
    kind: 'user',
    peerId: '1000',
    message: { id: 'm-src-2', text: '不传来源' },
    source: {},
  })
  eq(agent.steers[before + 1].source.kind, 'user', 'source 不合法时应回落 user')
})

await test('A22', '只有 observer 的 peer → 投 observer，且不自动登记 taker', async () => {
  const api = ctx.provided.get('miraAccount')
  await callTool(ctx, 'mira_account_bind', { accountId: 'qq-main', kind: 'group', peerId: '31337', sessionId: 'S-obs', observer: true })
  const routed = await api.inbound({ accountId: 'qq-main', kind: 'group', peerId: '31337', message: { id: 'm-obs-1', text: '直播弹幕' } })
  eq(routed.routed, 'observer', '应走 observer 分支：' + JSON.stringify(routed))
  check(ctx.agentFor('S-obs').steers.length === 1, 'observer 应收到消息')
  const resolved = await callTool(ctx, 'mira_account_bindings', { accountId: 'qq-main', kind: 'group', peerId: '31337' })
  eq(resolved.resolved.taker, null, '不应凭空出现 taker')
})

await test('A16', '自身 echo：markSelf 后入站同 id 丢弃', async () => {
  const api = ctx.provided.get('miraAccount')
  const sent = await api.send({ accountId: 'qq-main', kind: 'user', peerId: '2000', payload: { text: '我发的' }, sessionId: 'S9' })
  eq(sent.ok, true, 'send 应成功')
  eq(sent.binding.mode, 'taker', 'send 应自动反向绑定为 taker')
  eq(sent.messageId, 'self-1', '应回传 messageId')
  const echo = await api.inbound({ accountId: 'qq-main', kind: 'user', peerId: '2000', message: { id: 'self-1', text: '我发的' } })
  eq(echo.routed, 'dup', '自己的 echo 应被去重')
  eq(echo.echo, true, '应标记为 echo')
})

/* ── A9 无绑定 drop ─────────────────────────────────────── */

await test('A9', '无绑定 + inboundPolicy=drop → dropped 并计数', async () => {
  const added = await callTool(ctx, 'mira_account_add', { id: 'qq-drop', platform: 'qq', inboundPolicy: 'drop' })
  eq(added.ok, true, 'add 应成功：' + JSON.stringify(added))
  const api = ctx.provided.get('miraAccount')
  const before = api.status().counters['inbound.dropped.noBinding'] || 0
  const routed = await api.inbound({ accountId: 'qq-drop', kind: 'user', peerId: '777', message: { id: 'm-drop-1', text: '陌生人' } })
  eq(routed.routed, 'dropped', '应丢弃：' + JSON.stringify(routed))
  const after = api.status().counters['inbound.dropped.noBinding'] || 0
  eq(after, before + 1, '丢弃计数应 +1')
})

/* ── A10 无绑定 create ──────────────────────────────────── */

await test('A10', '无绑定 + inboundPolicy=create → 建会话并自动登记 taker', async () => {
  await callTool(ctx, 'mira_account_add', { id: 'qq-create', platform: 'qq', inboundPolicy: 'create' })
  const api = ctx.provided.get('miraAccount')
  const routed = await api.inbound({
    accountId: 'qq-create', kind: 'group', peerId: '8888', display: '测试群',
    message: { id: 'm-create-1', text: '大家好' },
  })
  eq(routed.routed, 'created', '应新建会话：' + JSON.stringify(routed))
  eq(routed.sessionId, 'session-created-8888', '会话 id 应来自适配器 createSession')
  check(ctx.agentFor('session-created-8888').steers.length === 1, '新会话应收到这条消息')
  const resolved = await callTool(ctx, 'mira_account_bindings', { accountId: 'qq-create', kind: 'group', peerId: '8888' })
  eq(resolved.resolved.taker.sessionId, 'session-created-8888', '应自动登记为 taker')
  const adapterState = api.adapterFor('qq').state
  eq(adapterState.created.display, '测试群', 'createSession 应收到 peername 作标题')
})

/* ── A11 / A12 反向绑定与冲突 ───────────────────────────── */

await test('A11', 'send 首次自动登记 taker 并真的发出去', async () => {
  const api = ctx.provided.get('miraAccount')
  const adapter = api.adapterFor('qq')
  const before = adapter.state.sent.length
  const sent = await api.send({ accountId: 'qq-main', kind: 'group', peerId: '4242', payload: { text: '你好' }, sessionId: 'S11' })
  eq(sent.ok, true, 'send 应成功')
  eq(sent.binding.action, 'created', '应新建绑定')
  eq(adapter.state.sent.length, before + 1, '适配器应收到一次 send')
  eq(adapter.state.sent.at(-1).payload.text, '你好', 'payload 应原样传给适配器')
})

await test('A12', '另一个会话 send 同一 peer → binding/conflict 且不发', async () => {
  const api = ctx.provided.get('miraAccount')
  const adapter = api.adapterFor('qq')
  const before = adapter.state.sent.length
  let err = null
  try {
    await api.send({ accountId: 'qq-main', kind: 'group', peerId: '4242', payload: { text: '抢话' }, sessionId: 'S12' })
  } catch (e) { err = e }
  eq(err && err.code, 'binding/conflict', '应报 binding/conflict')
  eq(adapter.state.sent.length, before, '冲突时不允许真的发出去')

  const forced = await api.send({ accountId: 'qq-main', kind: 'group', peerId: '4242', payload: { text: '抢话' }, sessionId: 'S12', force: true })
  eq(forced.ok, true, 'force 应能发出去')
  eq(forced.binding.action, 'forced', '应报 forced')
})

await test('A17', '适配器抛错 → 归一成 delivery/failed，不裸抛', async () => {
  const api = ctx.provided.get('miraAccount')
  api.adapterFor('qq').state.failNext = true
  let err = null
  try { await api.send({ accountId: 'qq-main', kind: 'user', peerId: '2000', payload: { text: 'x' }, sessionId: 'S9' }) } catch (e) { err = e }
  eq(err && err.code, 'delivery/failed', '应归一成 delivery/failed')
  check(api.status().lastError && api.status().lastError.code === 'delivery/failed', 'lastError 应可见')
})

/* ── A13 凭据 ───────────────────────────────────────────── */

await test('A13', '凭据 600、只报字段名、任何工具输出不含明文', async () => {
  const secret = 'SESSDATA_FAKE_VALUE_SHOULD_NEVER_LEAK'
  const written = writeCreds(BASE, 'qq-main', { platform: 'qq', kind: 'token', fields: { access_token: secret, note: 'x' } })
  const mode = statSync(written.file).mode & 0o777
  eq(mode, 0o600, '凭据文件权限应为 600（实得 ' + mode.toString(8) + '）')

  const listed = await callTool(ctx, 'mira_account_list')
  eq(listed.accounts[0].creds.present, true, 'status 应看到凭据已就位')
  eq(listed.accounts[0].creds.modeOk, true, '权限应为合规')
  eq(listed.accounts[0].creds.fieldNames.sort(), ['access_token', 'note'], '只报字段名')
  const json = JSON.stringify(listed)
  check(!json.includes(secret), '工具输出里绝不能出现凭据明文')
  check(!json.includes('FAKE_VALUE'), '工具输出里连片段都不许有')

  const status = JSON.stringify(await callTool(ctx, 'mira_account_status'))
  check(!status.includes(secret), 'status 不含凭据明文')
  const logs = logLines.join('\n')
  check(!logs.includes(secret), '日志不含凭据明文')
})

/* ── 限流 ───────────────────────────────────────────────── */

await test('A18', '写预算用尽 → limit/exceeded，且不发请求', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, config: { limits: { write: { perHour: 2 } } }, logger: silentLogger })
  svc.load()
  const adapter = makeAdapter('qq')
  svc.registerAdapter(adapter)
  await svc.send({ accountId: 'qq-main', kind: 'user', peerId: '9001', payload: { text: 'a' } })
  await svc.send({ accountId: 'qq-main', kind: 'user', peerId: '9002', payload: { text: 'b' } })
  const before = adapter.state.sent.length
  let err = null
  try { await svc.send({ accountId: 'qq-main', kind: 'user', peerId: '9003', payload: { text: 'c' } }) } catch (e) { err = e }
  eq(err && err.code, 'limit/exceeded', '第三次应被预算拦住')
  eq(adapter.state.sent.length, before, '被拦时不允许发出')
})

/* ── 冷启动顺序：适配器迟到也要连上 ─────────────────────── */

await test('A23', '适配器在该平台账号之后注册 → 自动补连（冷启动顺序问题）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger })
  svc.load()
  svc.addAccount({ id: 'qq-late', platform: 'qq', label: '迟到适配器' })

  // 此刻还没有 qq 适配器：connectAll 只会把它记成 platform/unsupported
  const report = await svc.connectAll()
  check(report.failed.some((f) => f.accountId === 'qq-late' && f.error.code === 'platform/unsupported'),
    '没有适配器时应记 platform/unsupported：' + JSON.stringify(report.failed))

  // bot 插件稍后才注册适配器：必须自动补连，而不是等下一次重启
  const adapter = makeAdapter('qq')
  svc.registerAdapter(adapter)
  const deadline = Date.now() + 1000
  while (Date.now() < deadline && svc.store.getAccount('qq-late').state !== 'online') {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  eq(svc.store.getAccount('qq-late').state, 'online', '适配器注册后应自动连上')
  check(adapter.state.connected.some((c) => c.accountId === 'qq-late'), 'adapter.connect 应被调用过')
})

/* ── 去重表：两个实例同写不丢 id ─────────────────────────── */

await test('A24', '两个 Dedup 实例同写去重表：后写者不能冲掉别人刚记的 id', async () => {
  const { Dedup } = await import('../lib/dedup.js')
  const a = new Dedup(BASE, { saveThrottleMs: 0 }).load('qq')
  const b = new Dedup(BASE, { saveThrottleMs: 0 }).load('qq')

  a.check('qq', 'id-from-a')
  a.flush()
  // b 的内存快照是 a 落盘之前读的，它并不知道 id-from-a
  b.check('qq', 'id-from-b')
  b.flush()

  const disk = JSON.parse(readFileSync(join(BASE, 'seen', 'qq.json'), 'utf8'))
  check(Object.prototype.hasOwnProperty.call(disk.entries, 'id-from-a'), 'a 记的 id 不能被 b 冲掉')
  check(Object.prototype.hasOwnProperty.call(disk.entries, 'id-from-b'), 'b 记的 id 也应在盘上')
  check(a.check('qq', 'id-from-a').duplicate === true, '并盘之后 a 自己的记录也应仍在（内存已同步）')
})

/* ── A14 schemaVersion ──────────────────────────────────── */

await test('A14', 'schemaVersion 不符 → 拒绝该文件，status 报 config/schema', async () => {
  const file = join(BASE, 'accounts.json')
  const backup = readFileSync(file, 'utf8')
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, accounts: [{ id: 'qq-main', platform: 'qq' }] }, null, 2))
  try {
    const { AccountService } = await import('../lib/service.js')
    const svc = new AccountService({ baseDir: BASE, logger: silentLogger }).load()
    const status = svc.status()
    eq(status.warnings.accounts && status.warnings.accounts.code, 'config/schema', 'status 应报 config/schema')
    eq(svc.store.listAccounts().length, 0, '不静默兼容：该文件里的账号不应被采用')
    let err = null
    try { svc.listAccounts() } catch (e) { err = e }
    eq(err && err.code, 'config/schema', 'listAccounts 应拒绝并报 config/schema')
  } finally {
    writeFileSync(file, backup)
  }
})

await test('A19', 'bindings.json 坏掉不致命（可从账号重建）', async () => {
  writeFileSync(join(BASE, 'bindings.json'), '{ 这不是 JSON')
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger }).load()
  eq(svc.store.bindings.length, 0, '坏文件按空表重建')
  check(String(svc.store.bindingWarning || '').includes('bindings.json'), '应留下 warning 说明')
  check(svc.store.listAccounts().length > 0, '账号池不受影响（这才是「坏了不致命」的意思）')
  // 恢复一份合法空表，别影响后面的用例
  writeFileSync(join(BASE, 'bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: [] }, null, 2))
})

/* ── 单实例 + 卸载落盘 ──────────────────────────────────── */

await test('A20', '单实例保护：第二个实例被拒并 warn', async () => {
  const ctx2 = makeCtx()
  const second = apply(ctx2, { autoConnect: false })
  eq(second && second.ok, false, '第二个实例应失败')
  eq(second.error && second.error.code, 'plugin/instance', '错误码应是 plugin/instance')
  check(ctx2.toolsMap.size === 0, '被拒的实例不应注册任何工具')
  check(logLines.some((l) => l.includes('已经有一个实例在跑')), '应写一条 warn 日志')
})

await test('A21', '卸载时落盘（去重表 + 绑定表），热重载不丢状态', async () => {
  const before = readFileSync(join(BASE, 'bindings.json'), 'utf8')
  ctx.dispose()
  check(existsSync(join(BASE, 'seen', 'qq.json')), '去重表应落盘到 seen/qq.json')
  const after = readFileSync(join(BASE, 'bindings.json'), 'utf8')
  eq(after, before, '卸载不应改动绑定表（约定9：旧实例不许用旧状态覆写新文件）')
  const seen = JSON.parse(readFileSync(join(BASE, 'seen', 'qq.json'), 'utf8'))
  check(Object.keys(seen.entries || {}).length > 0, '去重表里应有已见 id')
  check(Object.keys(seen.self || {}).length > 0, '去重表里应有自己发出去的 id')
})

/* ── 回归：P0-2 投递失败不丢消息 ─────────────────────────── */

await test('A25', '投递失败不记账：同一 message_id 可重投；成功后再来才是 dup', async () => {
  const { AccountService } = await import('../lib/service.js')
  const delivered = []
  let fail = true
  const svc = new AccountService({
    baseDir: BASE,
    logger: silentLogger,
    deliver: async (sessionId, text, meta) => {
      if (fail) throw Object.assign(new Error('会话不存在'), { code: 'delivery/failed' })
      delivered.push({ sessionId, text, meta })
    },
  })
  svc.load()
  svc.registerAdapter(makeAdapter('qq'))
  svc.addAccount({ id: 'qq-retry', platform: 'qq', inboundPolicy: 'create' })
  svc.adapterFor('qq').createSession = async (info) => 'session-' + info.peerId

  const peer = { accountId: 'qq-retry', kind: 'user', peerId: '9101' }
  const first = await svc.inbound({ ...peer, message: { id: 'retry-1', text: '第一次' } })
  eq(first.routed, 'error', '第一次投递应失败')
  eq(delivered.length, 0, '投递失败时不应记账，也不应投出去')

  // 平台重推同一条：必须还能再试，不能被当成 dup
  // （第一次已经把会话建好并登记了 taker，所以这里会走 taker 分支 —— 关键是"没被当重复吞掉"）
  fail = false
  const second = await svc.inbound({ ...peer, message: { id: 'retry-1', text: '第一次' } })
  check(second.routed !== 'dup', '失败后重投不能被当成 dup：' + JSON.stringify(second))
  eq(delivered.length, 1, '第二次应真的投出去')
  eq(svc.store.findBindings({ accountId: 'qq-retry', peerId: '9101' }).filter((b) => b.mode === 'taker').length, 1,
    '失败重投不应留下第二个 taker')

  // 成功之后才记成重复
  const third = await svc.inbound({ ...peer, message: { id: 'retry-1', text: '第一次' } })
  eq(third.routed, 'dup', '成功后同 id 再来应是 dup')
  eq(delivered.length, 1, 'dup 不应再投递')
})

/* ── 回归：P0-1 并发首条消息只建一个会话 ──────────────────── */

await test('A26', '并发首条消息：只建一个会话、只有一个 taker、两条都投同一个会话', async () => {
  const { AccountService } = await import('../lib/service.js')
  const delivered = []
  let created = 0
  const svc = new AccountService({
    baseDir: BASE,
    logger: silentLogger,
    deliver: async (sessionId, text, meta) => { delivered.push({ sessionId, text, mode: meta?.mode }) },
  })
  svc.load()
  const adapter = makeAdapter('qq')
  // 模拟真实 createSession 的耗时（qq 要 agents.create + get_group_info）
  adapter.createSession = async (info) => {
    created += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return 'session-slow-' + info.peerId
  }
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-race', platform: 'qq', inboundPolicy: 'create' })

  const peer = { accountId: 'qq-race', kind: 'user', peerId: '9201' }
  const [a, b] = await Promise.all([
    svc.inbound({ ...peer, message: { id: 'race-a', text: '并发 A' } }),
    svc.inbound({ ...peer, message: { id: 'race-b', text: '并发 B' } }),
  ])
  eq(created, 1, '并发两条消息只应建一次会话（实建 ' + created + ' 次）')
  eq(svc.store.resolve('qq-race', 'user', '9201').taker.sessionId, 'session-slow-9201', 'taker 应是那个唯一会话')
  eq(svc.store.findBindings({ accountId: 'qq-race', peerId: '9201' }).filter((x) => x.mode === 'taker').length, 1, '只允许一个 taker')
  eq(delivered.length, 2, '两条消息都应投出去')
  check(delivered.every((d) => d.sessionId === 'session-slow-9201'), '两条都应投到同一个会话：' + JSON.stringify(delivered.map((d) => d.sessionId)))
  check([a.routed, b.routed].every((r) => r === 'created' || r === 'taker'),
    '两条都应是 created/taker（同一次创建）：' + JSON.stringify([a.routed, b.routed]))
})

await test('A27', 'upsertBinding：写入处拒绝第二个 taker（binding/conflict）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-inv', platform: 'qq', inboundPolicy: 'create' })
  svc.store.upsertBinding({ sessionId: 'S-first', accountId: 'qq-inv', kind: 'user', peerId: '9301', mode: 'taker' })
  let err = null
  try {
    svc.store.upsertBinding({ sessionId: 'S-second', accountId: 'qq-inv', kind: 'user', peerId: '9301', mode: 'taker' })
  } catch (error) { err = error }
  eq(err && err.code, 'binding/conflict', '第二个 taker 应被拒绝')
  eq(svc.store.resolve('qq-inv', 'user', '9301').taker.sessionId, 'S-first', '原 taker 不变')
})

/* ── 回归：P0-4 写盘可见 / 坏文件隔离 / 平台校验 ──────────── */

await test('A28', '写盘失败必须抛 config/write-failed，并在 status.writeError 可见', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'ro-base')
  mkdirSync(join(dir, 'mira_config', 'mira_account'), { recursive: true })
  const base = join(dir, 'mira_config', 'mira_account')
  const svc = new AccountService({ baseDir: base, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-ro', platform: 'qq' })
  // 把 accounts.json 变成只读文件 → 之后的写盘必然失败
  const file = join(base, 'accounts.json')
  chmodSync(file, 0o400)
  chmodSync(base, 0o500) // 目录不可写：rename 也失败
  let err = null
  try { svc.setAccountEnabled('qq-ro', false) } catch (error) { err = error }
  chmodSync(base, 0o700)
  chmodSync(file, 0o600)
  eq(err && err.code, 'config/write-failed', '写盘失败应抛出 config/write-failed（不应静默返回 ok）')
  check(svc.status().writeError && svc.status().writeError.code === 'config/write-failed',
    'status.writeError 应留下原因：' + JSON.stringify(svc.status().writeError))
})

await test('A29', '坏 bindings.json 被改名保留（.corrupt.*），不被下一次写盘覆盖', async () => {
  const dir = join(TMP, 'corrupt-bindings', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'bindings.json'), '{ 这不是 JSON')
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  eq(svc.store.bindings.length, 0, '坏文件按空表重建')
  const names = readdirSync(dir)
  check(names.some((n) => n.startsWith('bindings.json.corrupt.')), '坏文件应改名保留：' + names.join(','))
  // 写一次正常表：新文件出现，坏文件仍在
  svc.addAccount({ id: 'qq-c', platform: 'qq' })
  svc.store.upsertBinding({ sessionId: 'S-c', accountId: 'qq-c', kind: 'user', peerId: '1', mode: 'taker' })
  const after = readdirSync(dir)
  check(after.some((n) => n.startsWith('bindings.json.corrupt.')), '正常写盘不应覆盖坏文件备份')
})

await test('A30', '非法 platform 的账号在加载时被跳过（防去重表路径穿越）', async () => {
  const dir = join(TMP, 'bad-platform', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({
    schemaVersion: 1,
    accounts: [
      { id: 'qq-ok', platform: 'qq', enabled: true },
      { id: 'evil', platform: '../../PWNED', enabled: true },
    ],
  }, null, 2))
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  const ids = svc.store.listAccounts().map((a) => a.id)
  eq(ids, ['qq-ok'], '非法平台的账号应被跳过：' + JSON.stringify(ids))
  check(String(svc.store.bindingWarning || '').includes('PWNED'), '应留下一条 warning 说明跳过了谁')
})

/* ── 回归：P1-5 旁听语义由框架保证 / P1-6 限流不回滚失败 ───── */

await test('A31', '旁听投递的正文带框架提示（不依赖 bot 插件自己拼）', async () => {
  // 主 ctx 已在 A21 dispose，这里另起一个新实例（顺带验证「dispose 后能重新 apply」）
  const { apply } = await import('../lib/index.js')
  const ctx2 = makeCtx()
  const applied = apply(ctx2, { autoConnect: false })
  eq(applied && applied.ok, true, '重新 apply 应成功：' + JSON.stringify(applied))
  try {
    const api = ctx2.provided.get('miraAccount')
    api.registerAdapter(makeAdapter('qq'))
    api.addAccount({ id: 'qq-obs', platform: 'qq', inboundPolicy: 'drop' })
    api.bind({ sessionId: 'S-observer', accountId: 'qq-obs', kind: 'group', peerId: '9410', observer: true })
    const observed = ctx2.agentFor('S-observer')
    const before = observed.steers.length
    const routed = await api.inbound({ accountId: 'qq-obs', kind: 'group', peerId: '9410', message: { id: 'obs-1', text: '旁听内容' } })
    eq(routed.routed, 'observer', '应走 observer 分支')
    eq(observed.steers.length, before + 1, 'observer 应收到消息')
    const text = observed.steers[observed.steers.length - 1].content[0].text
    check(text.includes('旁听者'), '正文里应有框架的旁听提示：' + text.slice(0, 80))
    check(text.includes('mira_account_bind'), '要告诉它怎么接管')
  } finally {
    ctx2.dispose()
  }
})

await test('A32', '写限流拒绝时不动绑定（force 抢答也不生效）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const delivered = []
  const svc = new AccountService({
    baseDir: BASE,
    logger: silentLogger,
    deliver: async () => {},
    config: { limits: { write: { perHour: 1 } } },
  })
  svc.load()
  const adapter = makeAdapter('qq')
  adapter.send = async (account, kind, peerId, payload) => { delivered.push({ peerId, payload }); return { ok: true, messageId: 'mid-' + delivered.length } }
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-limit', platform: 'qq' })
  svc.store.upsertBinding({ sessionId: 'S-old', accountId: 'qq-limit', kind: 'user', peerId: '9501', mode: 'taker' })

  // 第一次发送消耗掉唯一配额
  await svc.send({ accountId: 'qq-limit', kind: 'user', peerId: '9501', payload: { text: 'ok' }, sessionId: 'S-old' })
  // 第二次：S-new 想 force 抢答，但限流会拒
  let err = null
  try {
    await svc.send({ accountId: 'qq-limit', kind: 'user', peerId: '9501', payload: { text: '抢' }, sessionId: 'S-new', force: true })
  } catch (error) { err = error }
  eq(err && err.code, 'limit/exceeded', '应被限流拒绝')
  eq(svc.store.resolve('qq-limit', 'user', '9501').taker.sessionId, 'S-old', '被拒时 taker 不应被换掉')
  eq(delivered.length, 1, '被拒时不应发出任何消息')
})

await test('A33', 'createSession 按平台：两个 bot 并存时各用各的，卸载后不残留', async () => {
  const { AccountService } = await import('../lib/service.js')
  const delivered = []
  const svc = new AccountService({
    baseDir: BASE,
    logger: silentLogger,
    deliver: async (sessionId) => { delivered.push(sessionId) },
  })
  svc.load()
  const qq = makeAdapter('qq')
  qq.createSession = async (info) => 'qq-made-' + info.peerId
  const bili = makeAdapter('bilibili')
  bili.createSession = async (info) => 'bili-made-' + info.peerId
  const disposeQq = svc.registerAdapter(qq)
  svc.registerAdapter(bili)
  svc.addAccount({ id: 'qq-p', platform: 'qq', inboundPolicy: 'create' })
  svc.addAccount({ id: 'bili-p', platform: 'bilibili', inboundPolicy: 'create' })

  const a = await svc.inbound({ accountId: 'qq-p', kind: 'user', peerId: '1', message: { id: 'p1', text: 'x' } })
  const b = await svc.inbound({ accountId: 'bili-p', kind: 'user', peerId: '2', message: { id: 'p2', text: 'y' } })
  eq(a.sessionId, 'qq-made-1', 'qq 必须用自己的 createSession')
  eq(b.sessionId, 'bili-made-2', 'bilibili 必须用自己的 createSession')

  // 卸载 qq 适配器：该平台不能再建会话（不能继续调已死的闭包）
  disposeQq()
  const c = await svc.inbound({ accountId: 'qq-p', kind: 'user', peerId: '3', message: { id: 'p3', text: 'z' } })
  eq(c.routed, 'error', '卸载后该平台建会话应报错')
  eq(c.error && c.error.code, 'session/create-unsupported', '错误码应是 session/create-unsupported')
})

/* ── 回归：P1-7 健康巡检与重连 ──────────────────────────── */

await test('A34', '健康巡检：适配器报断开 → state 转 offline/error 并重连；退避生效', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'health', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let connected = true
  let connectCalls = 0
  let allowReconnect = false
  const adapter = makeAdapter('qq')
  adapter.status = async () => ({ ok: true, platform: 'qq', connected })
  adapter.connect = async () => {
    connectCalls += 1
    if (allowReconnect) { connected = true; return { ok: true } }
    return connected ? { ok: true } : { ok: false, error: { code: 'delivery/failed', message: '连接已断' } }
  }
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-health', platform: 'qq' }) // 登记即自动连（P1-8），可能已经连过一次
  await svc.connectAll()
  eq(svc.store.getAccount('qq-health').state, 'online', '先连上')
  connectCalls = 0 // 只看巡检引起的连接次数

  // 适配器说断了 → 巡检把状态改成断开并尝试重连（这次重连也失败）
  connected = false
  await svc.runHealthCheck()
  check(['offline', 'error'].includes(svc.store.getAccount('qq-health').state),
    'status() 报断开 → state 应转成断开态：' + svc.store.getAccount('qq-health').state)
  eq(connectCalls, 1, '巡检应尝试过一次重连（次数 ' + connectCalls + '）')
  eq(svc.store.getAccount('qq-health').state, 'error', '重连失败后 state=error（比 offline 更有信息量）')
  eq(svc.status().health.checks, 1, 'status.health.checks 应计数')
  check(svc.status().health.backoff.some((b) => b.accountId === 'qq-health'), '失败重连应进退避队列')

  // 退避期内不再打适配器
  await svc.runHealthCheck()
  eq(connectCalls, 1, '退避期内不应重复重连')

  // 网络恢复：让这次重连成功（connect 会把 connected 翻回 true）
  allowReconnect = true
  svc.retry.clear()
  await svc.runHealthCheck()
  eq(svc.store.getAccount('qq-health').state, 'online', '重连成功后应回到 online')
  eq(svc.status().health.reconnects, 1, 'status.health.reconnects 应计数')
})

await test('A35', 'startHealthLoop / dispose：定时器起得来也停得掉，dispose 会断开适配器', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'health2', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  const adapter = makeAdapter('qq')
  const disconnects = []
  adapter.disconnect = async (account) => { disconnects.push(account.id) }
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-loop', platform: 'qq' })
  await svc.connectAll()

  svc.startHealthLoop({ intervalMs: 5000 })
  eq(svc.status().health.running, true, '巡检应在跑')
  eq(svc.status().health.intervalMs, 5000, '间隔应是 5000')
  eq(svc.status().health.timer, undefined, 'timer 不应泄漏进 status')
  svc.stopHealthLoop()
  eq(svc.status().health.running, false, 'stopHealthLoop 后应停止')

  await svc.disconnectAll()
  eq(disconnects, ['qq-loop'], 'disconnectAll 应断开账号')
  svc.dispose()
  eq(svc.status().health.running, false, 'dispose 后巡检必须停')
})

/* ── 回归：P1-8 启停闭环 ─────────────────────────────────── */

const waitUntil = async (fn, timeoutMs = 800) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return fn()
}

await test('A36', 'toggle 闭环：启用即连接、停用即断开，且停用账号不再路由到绑定', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'toggle', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  const disconnects = []
  let connectCalls = 0
  const adapter = makeAdapter('qq')
  adapter.connect = async () => { connectCalls += 1; return { ok: true } }
  adapter.disconnect = async (account) => { disconnects.push(account.id) }
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-tog', platform: 'qq' }) // 先有账号（upsertBinding 现在会校验账号存在）
  svc.store.upsertBinding({ sessionId: 'S-tog', accountId: 'qq-tog', kind: 'user', peerId: '9701', mode: 'taker' })
  check(await waitUntil(() => svc.store.getAccount('qq-tog').state === 'online'), '登记后应自动连上')
  eq(connectCalls >= 1, true, 'addAccount 应触发连接')

  // 停用：断开 + offline + 不再返回绑定
  svc.setAccountEnabled('qq-tog', false)
  check(await waitUntil(() => disconnects.length === 1), '停用应断开适配器')
  eq(svc.store.getAccount('qq-tog').state, 'offline', '停用后应为 offline')
  const resolved = svc.resolve('qq-tog', 'user', '9701')
  eq(resolved.taker, null, '停用账号不应再返回 taker（bot 的已绑定快路径靠这个拦住）')
  eq(resolved.disabled, true, '应标出 disabled')

  // 重新启用：再次连接
  const before = connectCalls
  svc.setAccountEnabled('qq-tog', true)
  check(await waitUntil(() => svc.store.getAccount('qq-tog').state === 'online'), '启用后应重新连上')
  eq(connectCalls > before, true, '启用应再次触发连接')
})

await test('A37', 'autoConnect:false 时 addAccount 不自动连（行为可控）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'toggle2', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let connectCalls = 0
  const adapter = makeAdapter('qq')
  adapter.connect = async () => { connectCalls += 1; return { ok: true } }
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {}, config: { autoConnect: false } })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-manual', platform: 'qq' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  eq(connectCalls, 0, 'autoConnect:false 时不应自动连')
})

/* ── 回归：P1-9 绑定表校验与审计 ────────────────────────── */

await test('A38', 'bind：sessionId 带空白/控制字符 → config/invalid（挡住"看起来对"的黑洞）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-sid', platform: 'qq' })
  // 注意：首尾空白会被 trim 掉（'S1\n' 是合法的）；这里测的是**内部**空白/控制字符/超长
  for (const bad of ['a b', 'S1\t2', 'x'.repeat(201), '\u0007evil']) {
    let err = null
    try { svc.bind({ sessionId: bad, accountId: 'qq-sid', kind: 'user', peerId: '9801' }) } catch (error) { err = error }
    eq(err && err.code, 'config/invalid', '应拒绝非法 sessionId：' + JSON.stringify(bad.slice(0, 12)))
  }
  let missing = null
  try { svc.bind({ sessionId: '', accountId: 'qq-sid', kind: 'user', peerId: '9801' }) } catch (error) { missing = error }
  eq(missing && missing.code, 'config/missing', '空 sessionId 应是 config/missing')
  eq(svc.store.findBindings({ accountId: 'qq-sid' }).length, 0, '非法调用不应写入任何绑定')
})

await test('A39', 'bind 记录 boundBy 审计字段，bindings()/resolve() 里可见', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-audit', platform: 'qq' })
  svc.bind({ sessionId: 'S-audit', accountId: 'qq-audit', kind: 'user', peerId: '9901', boundBy: 'S-caller' })
  const rows = svc.bindings().filter((b) => b.accountId === 'qq-audit')
  eq(rows.length, 1, '应有一条绑定')
  eq(rows[0].boundBy, 'S-caller', '应记下发起方会话')
  eq(svc.resolve('qq-audit', 'user', '9901').taker.boundBy, 'S-caller', 'resolve 里也应带 boundBy')
  // 入站自动登记（没有 caller）时为 null
  const svc2 = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc2.load()
  svc2.store.upsertBinding({ sessionId: 'S-auto', accountId: 'qq-audit', kind: 'user', peerId: '9902', mode: 'taker' })
  eq(svc2.bindings().filter((b) => b.peerId === '9902')[0].boundBy, null, '入站自动登记没有 boundBy')
})

/* ── 回归：P2 工具面与可观测 ────────────────────────────── */

await test('A40', 'mode 大小写归一；非法 mode 直接拒（以前 "Observer" 会静默变 taker）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-mode', platform: 'qq' })
  const lower = svc.bind({ sessionId: 'S-m1', accountId: 'qq-mode', kind: 'user', peerId: '4001', mode: 'Observer' })
  eq(lower.binding.mode, 'observer', '"Observer" 应归一成 observer')
  let err = null
  try { svc.bind({ sessionId: 'S-m2', accountId: 'qq-mode', kind: 'user', peerId: '4002', mode: 'boss' }) } catch (e) { err = e }
  eq(err && err.code, 'config/invalid', '非法 mode 应报 config/invalid')
  eq(svc.store.findBindings({ accountId: 'qq-mode', peerId: '4002' }).length, 0, '非法 mode 不应写入绑定')
})

await test('A41', 'kind 与平台能力不匹配 → platform/unsupported（绑了也永远收不到的线）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'bili-k', platform: 'bilibili' })
  let err = null
  try { svc.bind({ sessionId: 'S-k', accountId: 'bili-k', kind: 'group', peerId: '1' }) } catch (e) { err = e }
  eq(err && err.code, 'platform/unsupported', 'bilibili 没有 group 这类 peer')
  check(String(err && err.hint).includes('room'), 'hint 要列出该平台支持的 kind：' + (err && err.hint))
  const ok = svc.bind({ sessionId: 'S-k', accountId: 'bili-k', kind: 'room', peerId: '2' })
  eq(ok.binding.mode, 'taker', 'room 是 bilibili 的合法 kind')
})

await test('A42', 'unbind 只给部分条件会误删全表 → 必须给 sessionId 或 accountId+kind+peerId', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-unbind', platform: 'qq' })
  svc.bind({ sessionId: 'S-u1', accountId: 'qq-unbind', kind: 'user', peerId: '4101' })
  svc.bind({ sessionId: 'S-u2', accountId: 'qq-unbind', kind: 'group', peerId: '4102' })
  let err = null
  try { svc.unbind({ kind: 'user' }) } catch (e) { err = e }
  eq(err && err.code, 'config/missing', '只给 kind 应被拒')
  eq(svc.store.findBindings({ accountId: 'qq-unbind' }).length, 2, '被拒时不应删掉任何绑定')
  const removed = svc.unbind({ accountId: 'qq-unbind', kind: 'user', peerId: '4101' })
  eq(removed.removed, 1, '给全条件才删这一条')
  eq(svc.store.findBindings({ accountId: 'qq-unbind' }).length, 1, '别的绑定不受影响')
})

await test('A42b', 'vtuber 是本地虚拟平台：不需要适配器、state 记 online、peer 是形象本身（avatar）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  // 没有任何 vtuber 适配器也要能登记成功
  const added = svc.addAccount({ id: 'vtuber-main', platform: 'vtuber', label: '形象' })
  eq(added.platform, 'vtuber', 'vtuber 平台可登记')
  eq(added.state, 'online', '本地虚拟账号不需要连接，登记后即 online（不能记 error）')

  // peer kind：只允许 avatar（形象本身）；给 user 要明确报错并提示合法 kind
  let err = null
  try { svc.bind({ sessionId: 'S-v1', accountId: 'vtuber-main', kind: 'user', peerId: '1' }) } catch (e) { err = e }
  eq(err && err.code, 'platform/unsupported', 'vtuber 没有 user 这类 peer')
  check(String(err && err.hint).includes('avatar'), 'hint 要列出 avatar：' + (err && err.hint))

  // 关键语义：peer 是形象本身（常量），会话是绑定主体 → 一个 taker + 多个 observer，抢要 force
  const t = svc.bind({ sessionId: 'S-v1', accountId: 'vtuber-main', kind: 'avatar', peerId: 'main' })
  eq(t.binding.mode, 'taker', '第一个会话成为 taker')
  const o = svc.bind({ sessionId: 'S-v2', accountId: 'vtuber-main', kind: 'avatar', peerId: 'main', observer: true })
  eq(o.binding.mode, 'observer', '第二个会话可以旁听')
  let conflict = null
  try { svc.bind({ sessionId: 'S-v2', accountId: 'vtuber-main', kind: 'avatar', peerId: 'main' }) } catch (e) { conflict = e }
  eq(conflict && conflict.code, 'binding/conflict', '抢 taker 要给 force')
  const forced = svc.bind({ sessionId: 'S-v2', accountId: 'vtuber-main', kind: 'avatar', peerId: 'main', force: true })
  eq(forced.action, 'forced', 'force 能抢过来')
  const after = svc.store.resolve('vtuber-main', 'avatar', 'main')
  eq(after.taker.sessionId, 'S-v2', 'taker 换成抢的人')
  eq(after.observers.some((x) => x.sessionId === 'S-v1'), true, '原 taker 降级成 observer（还能看，不能控）')
})

await test('A43', 'toggle 严格布尔；status.limits 覆盖所有账号；pauseAccount/resumeAccount 可用', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-paus', platform: 'qq' })
  // limits：没发过消息也要能看见预算
  check(svc.status().limits['qq-paus'], 'status.limits 里应有该账号（以前懒建 → 空的）')
  // 暂停：撞风控时适配器可调（以前 Limiter.pause 是死代码）
  const paused = svc.pauseAccount('qq-paus', 5000, 'test-412')
  check(paused.pausedUntil > Date.now(), '暂停应返回恢复时间')
  let err = null
  const adapter = makeAdapter('qq')
  adapter.send = async () => ({ ok: true, messageId: 'mid-paus' })
  svc.registerAdapter(adapter)
  try { await svc.send({ accountId: 'qq-paus', kind: 'user', peerId: '1', payload: { text: 'x' } }) } catch (e) { err = e }
  eq(err && err.code, 'limit/paused', '暂停期间出站应被拒')
  svc.resumeAccount('qq-paus')
  const sent = await svc.send({ accountId: 'qq-paus', kind: 'user', peerId: '1', payload: { text: 'x' } })
  eq(sent.ok, true, '恢复后应能发')
})

await test('A44', '去重表 flush 不再无限增长：并盘后仍遵守 maxEntries 与 TTL', async () => {
  const { Dedup } = await import('../lib/dedup.js')
  const dir = join(TMP, 'seen-bound')
  mkdirSync(join(dir, 'seen'), { recursive: true })
  const old = Date.now() - 10 * 60 * 1000
  writeFileSync(join(dir, 'seen', 'qq.json'), JSON.stringify({
    schemaVersion: 1,
    entries: { a: old, b: old, c: Date.now(), d: Date.now(), e: Date.now() },
    self: {},
  }))
  const dedup = new Dedup(dir, { ttlMs: 5 * 60 * 1000, maxEntries: 2 })
  dedup.load()
  dedup.record('qq', 'fresh-1')
  dedup.dispose()
  const seen = JSON.parse(readFileSync(join(dir, 'seen', 'qq.json'), 'utf8'))
  const ids = Object.keys(seen.entries || {})
  eq(ids.length <= 2, true, '并盘后应裁到 maxEntries（实得 ' + ids.length + ' 条：' + ids.join(',') + '）')
  check(ids.includes('fresh-1'), '应保留最新记录')
  check(!ids.includes('a') && !ids.includes('b'), '过期条目不应被并盘复活')
})

await test('A45', 'status.lastErrors 保留最近多条（单槽会被后一条错盖掉）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  for (let i = 0; i < 12; i += 1) svc.noteError({ code: 'e' + i, message: 'boom ' + i })
  const status = svc.status()
  eq(status.lastErrors.length, 10, '最多留 10 条')
  eq(status.lastErrors[9].code, 'e11', '最后一条是最新的')
  eq(status.lastError.code, 'e11', 'lastError 仍保留兼容')
})

/* ── 回归：并发同 id / 账号级键 / 跨进程锁 ──────────────── */

await test('A46', '同一条 message_id 并发到达：只投一次（占位生效）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const delivered = []
  const svc = new AccountService({
    baseDir: join(TMP, 'concurrent', 'mira_config', 'mira_account'),
    logger: silentLogger,
    deliver: async (sessionId, text) => {
      await new Promise((resolve) => setTimeout(resolve, 30)) // 模拟投递耗时（占位窗口）
      delivered.push({ sessionId, text })
    },
  })
  mkdirSync(join(TMP, 'concurrent', 'mira_config', 'mira_account'), { recursive: true })
  svc.load()
  const adapter = makeAdapter('qq')
  adapter.createSession = async (info) => 'session-cc-' + info.peerId
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-cc', platform: 'qq', inboundPolicy: 'create' })

  const peer = { accountId: 'qq-cc', kind: 'user', peerId: '4301' }
  const [a, b] = await Promise.all([
    svc.inbound({ ...peer, message: { id: 'same-id', text: '并发同 id' } }),
    svc.inbound({ ...peer, message: { id: 'same-id', text: '并发同 id' } }),
  ])
  eq(delivered.length, 1, '同 id 并发只应投一次（实投 ' + delivered.length + ' 次）')
  const dupCount = [a.routed, b.routed].filter((r) => r === 'dup').length
  eq(dupCount, 1, '另一条应判 dup：' + JSON.stringify([a.routed, b.routed]))
})

await test('A47', '去重键是「账号|消息」：两个账号撞号时互不影响（不该静默丢真实消息）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const delivered = []
  const svc = new AccountService({
    baseDir: join(TMP, 'twokey', 'mira_config', 'mira_account'),
    logger: silentLogger,
    deliver: async (sessionId, text) => { delivered.push({ sessionId, text }) },
  })
  mkdirSync(join(TMP, 'twokey', 'mira_config', 'mira_account'), { recursive: true })
  svc.load()
  const adapter = makeAdapter('qq')
  adapter.createSession = async (info) => 'session-' + info.account.id + '-' + info.peerId
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-a', platform: 'qq', inboundPolicy: 'create' })
  svc.addAccount({ id: 'qq-b', platform: 'qq', inboundPolicy: 'create' })

  const ra = await svc.inbound({ accountId: 'qq-a', kind: 'user', peerId: '4401', message: { id: 'M-1', text: 'A 号的消息' } })
  const rb = await svc.inbound({ accountId: 'qq-b', kind: 'user', peerId: '4402', message: { id: 'M-1', text: 'B 号的消息' } })
  eq(ra.routed, 'created', 'A 号应投递')
  eq(rb.routed, 'created', 'B 号同 id 也应投递（是另一条真实消息）')
  eq(delivered.length, 2, '两个账号各投一次')
})

await test('A48', '跨进程锁：活着的持有者拒绝加载；陈旧锁可接管；自己可重复进', async () => {
  const { acquireProcessLock, __testing } = await import('../lib/lock.js')
  const dir = join(TMP, 'locktest')
  mkdirSync(dir, { recursive: true })

  const mine = acquireProcessLock(dir)
  eq(mine.ok, true, '第一次拿锁应成功')
  // 同 pid 再进一次（重载场景）允许
  eq(acquireProcessLock(dir).ok, true, '同一个进程重复拿锁应允许（重载）')
  // 模拟另一个活着的进程（pid 1 一定活着）
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 1, startedAt: 'x' }))
  const blocked = acquireProcessLock(dir, { pid: 424242 })
  eq(blocked.ok, false, '持有者活着时应拒绝')
  eq(blocked.error && blocked.error.code, 'plugin/instance', '错误码应是 plugin/instance')
  check(String(blocked.error.hint).includes('两个 DSH 进程'), 'hint 要说清原因：' + blocked.error.hint)
  // 陈旧锁（pid 不存在）
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 999999999, startedAt: 'x' }))
  eq(acquireProcessLock(dir, { pid: 424242 }).ok, true, '陈旧锁应被接管')
  // 锁文件权限 600（里面是 pid，别给全世界看）
  eq(statSync(join(dir, '.lock')).mode & 0o777, 0o600, '锁文件权限应是 600')
  // 读不出来的锁（崩在写锁那一刻）视为陈旧，能接管
  writeFileSync(join(dir, '.lock'), '{ 半截')
  eq(acquireProcessLock(dir, { pid: 424244 }).ok, true, '残缺锁应被接管')
  // 释放
  const lock2 = acquireProcessLock(dir, { pid: 424243 })
  lock2.release()
  check(!existsSync(join(dir, '.lock')), 'release 后锁文件应删除')
  eq(__testing.isAlive(1), true, 'isAlive(1) 应为 true')
  eq(__testing.isAlive(999999999), false, 'isAlive(不存在的 pid) 应为 false')
})

/* ── 回归：回滚误删 / 悬空绑定（评审第二轮） ─────────────── */

await test('A49', 'send 失败回滚不会抹掉「这期间别人抢到的新 taker」', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'rollback', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let rejectSend = null
  const adapter = makeAdapter('qq')
  adapter.send = () => new Promise((resolve, reject) => { rejectSend = reject })
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-rb', platform: 'qq' })
  svc.store.upsertBinding({ sessionId: 'S-old', accountId: 'qq-rb', kind: 'user', peerId: '5001', mode: 'taker' })

  const pending = svc.send({ accountId: 'qq-rb', kind: 'user', peerId: '5001', payload: { text: '抢答' }, sessionId: 'S-new', force: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 发送还挂着的时候，第三方接管了这条线
  svc.bind({ sessionId: 'S-third', accountId: 'qq-rb', kind: 'user', peerId: '5001', force: true })
  rejectSend(new Error('network down'))
  const err = await pending.catch((error) => error)
  eq(err && err.code, 'delivery/failed', '发送失败应报 delivery/failed')
  eq(svc.resolve('qq-rb', 'user', '5001').taker.sessionId, 'S-third',
    '第三方刚抢到的 taker 不该被回滚抹掉（实得 ' + (svc.store.resolve('qq-rb', 'user', '5001').taker || {}).sessionId + '）')
})

await test('A50', '账号在 createSession 途中被删：不写悬空绑定；同 id 重建也不复活旧绑定', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'dangling', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let releaseCreate = null
  const adapter = makeAdapter('qq')
  adapter.createSession = (info) => new Promise((resolve) => { releaseCreate = () => resolve('session-' + info.peerId) })
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-x', platform: 'qq', inboundPolicy: 'create' })

  const inflight = svc.inbound({ accountId: 'qq-x', kind: 'user', peerId: '5501', message: { id: 'd1', text: '在建会话' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  svc.removeAccount('qq-x') // 建会话途中被删
  releaseCreate()
  const result = await inflight
  // 会话已经建好了：绑定写不进去也要把消息投出去（降级投递），只是不留下悬空绑定
  eq(result.routed, 'created', '会话已建立时仍应投递本条（不丢消息）：' + JSON.stringify(result))
  eq(svc.store.findBindings({ accountId: 'qq-x' }).length, 0, '不应留下悬空绑定')
  eq(svc.status().counters['binding.writeFailed'] >= 1, true, '应记一条 binding.writeFailed 计数')

  // 用同一个 id 重新登记：旧绑定不能复活
  svc.addAccount({ id: 'qq-x', platform: 'qq', inboundPolicy: 'create' })
  eq(svc.resolve('qq-x', 'user', '5501').taker, null, '重新登记同 id 账号后旧绑定不该复活')
})

await test('A51', '加载时丢弃指向不存在账号的绑定（旧数据/手改文件）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'stale', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ schemaVersion: 1, accounts: [{ id: 'qq-alive', platform: 'qq', enabled: true }] }))
  writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
    schemaVersion: 1,
    bindings: [
      { sessionId: 'S-live', accountId: 'qq-alive', kind: 'user', peerId: '1', mode: 'taker', createdAt: 'x', updatedAt: 'x' },
      { sessionId: 'S-ghost', accountId: 'qq-deleted', kind: 'user', peerId: '2', mode: 'taker', createdAt: 'x', updatedAt: 'x' },
    ],
  }))
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  eq(svc.store.findBindings().length, 1, '悬空绑定应被丢弃')
  eq(svc.store.findBindings({ accountId: 'qq-alive' }).length, 1, '正常绑定保留')
  check(String(svc.store.bindingWarning || '').includes('已不存在'), '应留下 warning')
  // 落盘也清掉了
  const onDisk = JSON.parse(readFileSync(join(dir, 'bindings.json'), 'utf8'))
  eq(onDisk.bindings.length, 1, '清理结果应落盘')
})

await test('A52', '随机并发压测（固定种子）：单 taker / 无悬空绑定 / 同 id 至多投一次', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'chaos', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  // 确定性伪随机（mulberry32），失败可复现
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rand = rng(20261027)
  const delivered = new Map() // 'account|mid' -> 次数
  const adapter = makeAdapter('qq')
  adapter.createSession = async (info) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(rand() * 8)))
    return 'session-' + info.account.id + '-' + info.peerId + '-' + Math.floor(rand() * 1000)
  }
  adapter.send = async (account, kind, peerId, payload) => {
    if (rand() < 0.2) throw new Error('模拟发送失败')
    return { ok: true, messageId: 'snd-' + Math.floor(rand() * 1000) }
  }
  const svc = new AccountService({
    baseDir: dir,
    logger: silentLogger,
    deliver: async (sessionId, text, meta) => {
      const key = String(meta && meta.accountId) + '|' + String(meta && meta.messageId)
      delivered.set(key, (delivered.get(key) || 0) + 1)
      await new Promise((resolve) => setTimeout(resolve, Math.floor(rand() * 5)))
    },
  })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-a1', platform: 'qq', inboundPolicy: 'create' })
  svc.addAccount({ id: 'qq-a2', platform: 'qq', inboundPolicy: 'create' })

  const ops = []
  for (let i = 0; i < 120; i += 1) {
    const accountId = rand() < 0.5 ? 'qq-a1' : 'qq-a2'
    const kind = rand() < 0.5 ? 'user' : 'group'
    const peerId = String(1000 + Math.floor(rand() * 4))
    const mid = 'm' + Math.floor(rand() * 10) // id 会重复：正是要测并发同 id
    ops.push(svc.inbound({ accountId, kind, peerId, message: { id: mid, text: 'x' } }).catch((error) => ({ routed: 'error', error })))
    if (rand() < 0.15) {
      try {
        svc.bind({ sessionId: 'S-' + Math.floor(rand() * 3), accountId, kind, peerId, force: true })
      } catch { /* 冲突是允许的 */ }
    }
    if (rand() < 0.05) {
      try { await svc.send({ accountId, kind, peerId, payload: { text: 'y' }, sessionId: 'S-send', force: true }) } catch { /* 失败允许 */ }
    }
  }
  await Promise.all(ops)

  // 不变量 1：每个 peer 至多一个 taker
  const byPeer = new Map()
  for (const row of svc.store.findBindings()) {
    if (row.mode !== 'taker') continue
    const key = row.accountId + '|' + row.kind + '|' + row.peerId
    byPeer.set(key, (byPeer.get(key) || 0) + 1)
  }
  const dupTakers = [...byPeer.entries()].filter(([, n]) => n > 1)
  eq(dupTakers, [], '不应出现两个 taker 的 peer：' + JSON.stringify(dupTakers))

  // 不变量 2：没有指向不存在账号的绑定
  const ids = new Set(svc.store.listAccounts().map((a) => a.id))
  const dangling = svc.store.findBindings().filter((b) => !ids.has(b.accountId))
  eq(dangling, [], '不应有悬空绑定：' + JSON.stringify(dangling))

  // 不变量 3：同一个 (账号, 消息id) 至多投递一次
  const twice = [...delivered.entries()].filter(([, n]) => n > 1)
  eq(twice, [], '同一条消息被投递了多次：' + JSON.stringify(twice))
})

await test('A53', '进程骤崩后重启：追加日志回放，已投递的 id 仍判 dup（缩小重复投递窗口）', async () => {
  const { Dedup } = await import('../lib/dedup.js')
  const base = join(TMP, 'recent-log')
  mkdirSync(join(base, 'seen'), { recursive: true })

  const d1 = new Dedup(base, { ttlMs: 60 * 1000, maxEntries: 100 })
  d1.load('qq')
  d1.record('qq', 'qq-main|M1')
  check(existsSync(join(base, 'seen', 'recent.ndjson')), '记录应追加到 recent.ndjson')
  // 故意不调 dispose：模拟进程被 kill（只靠追加日志活下来）

  const d2 = new Dedup(base, { ttlMs: 60 * 1000, maxEntries: 100 })
  d2.load('qq')
  eq(d2.verdict('qq', 'qq-main|M1').duplicate, true, '重启后应记得这条已投递过（不重复回复）')
  eq(d2.verdict('qq', 'qq-main|M2').reserved, true, '没见过的 id 应能占位投递')

  // 日志压缩：超过上限先把内存写进正式表再清空
  const d3 = new Dedup(base, { ttlMs: 60 * 1000, maxEntries: 100 })
  d3.load('qq')
  d3.recentLines = d3.recentLimit + 1
  d3.record('qq', 'qq-main|M3')
  const lines = readFileSync(join(base, 'seen', 'recent.ndjson'), 'utf8').split('\n').filter(Boolean).length
  eq(lines <= 2, true, '压缩后日志应被清空/只剩零头（实得 ' + lines + ' 行）')
  const table = JSON.parse(readFileSync(join(base, 'seen', 'qq.json'), 'utf8'))
  check(!!table.entries['qq-main|M1'], '压缩后正式表里应有已投递记录')
})

await test('A54', 'writeJsonAtomic：tmp 名唯一、成功后不留残渣、失败会清理', async () => {
  const { writeJsonAtomic } = await import('../lib/kit.mjs')
  const dir = join(TMP, 'atomic')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'x.json')
  for (let i = 0; i < 20; i += 1) writeJsonAtomic(file, { i })
  eq(JSON.parse(readFileSync(file, 'utf8')).i, 19, '最后一次写入应生效')
  const residue = readdirSync(dir).filter((name) => name.includes('.tmp'))
  eq(residue, [], '不应留下 tmp 残渣：' + residue.join(','))

  // 失败路径：目录不可写 → 返回 false 且不留 tmp
  const roDir = join(TMP, 'atomic-ro')
  mkdirSync(roDir, { recursive: true })
  chmodSync(roDir, 0o500)
  const ok = writeJsonAtomic(join(roDir, 'y.json'), { a: 1 })
  chmodSync(roDir, 0o700)
  eq(ok, false, '不可写目录应返回 false')
  const leftover = readdirSync(roDir).filter((name) => name.includes('.tmp'))
  eq(leftover, [], '失败路径不应留下 tmp：' + leftover.join(','))
})

/* ── 回归：第三轮评审（P0 数据丢失 / 锁竞态 / ok:false / 死 taker）── */

await test('A55', 'P0：accounts.json 坏掉时**不许**清空 bindings.json（不能用一个坏文件毁另一个）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'p0-accounts', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'accounts.json'), '{ 这不是 JSON')
  writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
    schemaVersion: 1,
    bindings: [
      { sessionId: 'S-keep', accountId: 'qq-main', kind: 'user', peerId: '1', mode: 'taker', createdAt: 'x', updatedAt: 'x' },
    ],
  }))
  const before = readFileSync(join(dir, 'bindings.json'), 'utf8')
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  const after = readFileSync(join(dir, 'bindings.json'), 'utf8')
  eq(after, before, '账号池不可信时，绑定文件必须原样保留')
  eq(svc.store.bindings.length, 1, '内存里的绑定也应保留')
  check(String(svc.store.bindingWarning || '').includes('未'), '应留 warning 说明没有清理')
  eq(svc.store.fatalError !== null, true, '账号池仍然报 fatal（不静默）')
})

await test('A56', '适配器返回 {ok:false} 当失败处理：报错、计错、回滚绑定、不记 self', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'okfalse', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  const adapter = makeAdapter('qq')
  adapter.send = async () => ({ ok: false, error: { code: 'delivery/failed', message: '平台拒了' } })
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-of', platform: 'qq' })
  let err = null
  try {
    await svc.send({ accountId: 'qq-of', kind: 'user', peerId: '6101', payload: { text: 'x' }, sessionId: 'S-of' })
  } catch (error) { err = error }
  eq(err && err.code, 'delivery/failed', 'ok:false 应抛 delivery/failed')
  eq(svc.store.findBindings({ accountId: 'qq-of' }).length, 0, '失败应回滚掉新写的前向绑定')
  eq(svc.status().counters['outbound.sent'] || 0, 0, '不应计 outbound.sent')
})

await test('A57', '发送挂起期间别人 unbind：回滚不得把别人的 unbind 撤销', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'rb-unbind', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let rejectSend = null
  const adapter = makeAdapter('qq')
  adapter.send = () => new Promise((resolve, reject) => { rejectSend = reject })
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-rb2', platform: 'qq' })
  svc.store.upsertBinding({ sessionId: 'S-old2', accountId: 'qq-rb2', kind: 'user', peerId: '6201', mode: 'taker' })

  const pending = svc.send({ accountId: 'qq-rb2', kind: 'user', peerId: '6201', payload: { text: 'x' }, sessionId: 'S-new2', force: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  svc.unbind({ sessionId: 'S-old2', accountId: 'qq-rb2', kind: 'user', peerId: '6201' })
  rejectSend(new Error('boom'))
  const err = await pending.catch((error) => error)
  eq(err && err.code, 'delivery/failed', '发送应失败')
  const rows = svc.store.findBindings({ accountId: 'qq-rb2' })
  eq(rows.some((r) => r.sessionId === 'S-old2'), false, '别人的 unbind 不该被回滚撤销')
})

await test('A58', 'observer 部分失败不释放占位：并发同 id 不会把好的 observer 投两遍', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'obs-partial', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  const got = []
  const svc = new AccountService({
    baseDir: dir,
    logger: silentLogger,
    deliver: async (sessionId, text) => {
      if (sessionId === 'S-bad') throw new Error('这个会话没了')
      await new Promise((resolve) => setTimeout(resolve, 30))
      got.push(sessionId)
    },
  })
  svc.load()
  svc.registerAdapter(makeAdapter('qq'))
  svc.addAccount({ id: 'qq-op', platform: 'qq', inboundPolicy: 'create' })
  svc.bind({ sessionId: 'S-ok', accountId: 'qq-op', kind: 'user', peerId: '6301', observer: true })
  svc.bind({ sessionId: 'S-bad', accountId: 'qq-op', kind: 'user', peerId: '6301', observer: true })

  const peer = { accountId: 'qq-op', kind: 'user', peerId: '6301' }
  const [a, b] = await Promise.all([
    svc.inbound({ ...peer, message: { id: 'same-obs', text: 'x' } }),
    svc.inbound({ ...peer, message: { id: 'same-obs', text: 'x' } }),
  ])
  eq(got.filter((x) => x === 'S-ok').length, 1, 'S-ok 只应收到一次（实得 ' + got.length + ' 次）')
  const dups = [a.routed, b.routed].filter((r) => r === 'dup').length
  eq(dups, 1, '另一条应是 dup：' + JSON.stringify([a.routed, b.routed]))
})

await test('A59', '锁：陈旧接管仍然成功；异主机持有则拒绝（无法判断对端存活）', async () => {
  const { acquireProcessLock } = await import('../lib/lock.js')
  const dir = join(TMP, 'lock-host')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 999999999, host: 'someone-else', startedAt: 'x' }))
  const blocked = acquireProcessLock(dir, { pid: 424250 })
  eq(blocked.ok, false, '异主机的锁应被拒绝')
  check(String(blocked.error.hint).includes('锁文件'), 'hint 要告诉怎么处理：' + blocked.error.hint)
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 999999999, host: (await import('node:os')).hostname(), startedAt: 'x' }))
  eq(acquireProcessLock(dir, { pid: 424251 }).ok, true, '本机的陈旧锁应能接管')
})

await test('A60', 'peerId 含换行/控制字符 → config/invalid（防日志伪造）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-pid', platform: 'qq' })
  for (const bad of ['1\n2', 'a b', 'x'.repeat(201), '\u0001']) {
    let err = null
    try { svc.bind({ sessionId: 'S-pid', accountId: 'qq-pid', kind: 'user', peerId: bad }) } catch (error) { err = error }
    eq(err && err.code, 'config/invalid', '应拒绝：' + JSON.stringify(bad.slice(0, 10)))
  }
})

await test('A61', '同平台第二个账号：status.warnings.runtime 里告警（适配器是单连接）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'multi-account', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {}, config: { autoConnect: false } })
  svc.load()
  svc.addAccount({ id: 'qq-first', platform: 'qq' })
  svc.addAccount({ id: 'qq-second', platform: 'qq' })
  const runtime = svc.status().warnings.runtime || []
  check(runtime.some((w) => String(w).includes('单连接')), '应提示单连接共用：' + JSON.stringify(runtime))
})

await test('A62', '死 taker：连续投递失败三次后 status 里能看到这个 peer', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'dead-taker', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  const svc = new AccountService({
    baseDir: dir,
    logger: silentLogger,
    deliver: async () => { throw Object.assign(new Error('会话不存在'), { code: 'delivery/failed' }) },
  })
  svc.load()
  svc.registerAdapter(makeAdapter('qq'))
  svc.addAccount({ id: 'qq-dead', platform: 'qq', inboundPolicy: 'create' })
  svc.bind({ sessionId: 'S-dead', accountId: 'qq-dead', kind: 'user', peerId: '6401' })
  for (let i = 0; i < 3; i += 1) {
    await svc.inbound({ accountId: 'qq-dead', kind: 'user', peerId: '6401', message: { id: 'dead-' + i, text: 'x' } }).catch(() => {})
  }
  const failing = svc.status().warnings.peersFailingDelivery || []
  check(failing.some((x) => x.peer === 'user:6401' && x.consecutiveFailures >= 3),
    'status 应暴露连续失败的 peer：' + JSON.stringify(failing))
})

await test('A63', '巡检不把 error 降级成 offline；凭据类错误不触发重连', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'health-error', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let connectCalls = 0
  const adapter = makeAdapter('qq')
  adapter.status = async () => ({ ok: true, connected: false })
  adapter.connect = async () => { connectCalls += 1; return { ok: true } }
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {}, config: { autoConnect: false } })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-he', platform: 'qq' })
  svc.store.setState('qq-he', 'error', { code: 'creds/missing', message: '没有凭据' })
  connectCalls = 0
  await svc.runHealthCheck()
  const acc = svc.store.getAccount('qq-he')
  eq(acc.state, 'error', 'error 不应被 offline 覆盖')
  eq(acc.error && acc.error.code, 'creds/missing', '具体诊断要保留')
  eq(connectCalls, 0, '凭据类错误不该反复重连')
})

await test('A64', '同账号并发 connect 只连一次（防双 ws → 一份消息两份入站）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'connect-once', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let calls = 0
  const adapter = makeAdapter('qq')
  adapter.connect = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { ok: true }
  }
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {}, config: { autoConnect: false } })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-one', platform: 'qq' })
  await Promise.all([svc.connectAll(), svc.connectPlatform('qq'), svc.runHealthCheck()])
  eq(calls, 1, '同一账号并发 connect 只应调一次适配器（实得 ' + calls + '）')
})

await test('A65', 'kind 归一：Group 与 group 是同一个 peer（否则绕过单 taker）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-kind', platform: 'qq' })
  svc.bind({ sessionId: 'S-k1', accountId: 'qq-kind', kind: 'Group', peerId: '6501' })
  eq(svc.store.findBindings({ accountId: 'qq-kind', kind: 'group', peerId: '6501' }).length, 1, '小写查询应命中')
  let err = null
  try { svc.bind({ sessionId: 'S-k2', accountId: 'qq-kind', kind: 'group', peerId: '6501' }) } catch (error) { err = error }
  eq(err && err.code, 'binding/conflict', '同 peer 第二个 taker 应被拒（大小写不该绕过）')
})

await test('A66', 'bindings 过滤：只给 accountId 时只返回该账号（不再静默返回全表）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-f1', platform: 'qq' })
  svc.addAccount({ id: 'qq-f2', platform: 'qq' })
  svc.bind({ sessionId: 'S-f1', accountId: 'qq-f1', kind: 'user', peerId: '6601' })
  svc.bind({ sessionId: 'S-f2', accountId: 'qq-f2', kind: 'user', peerId: '6602' })
  const rows = svc.bindings({ accountId: 'qq-f1' })
  eq(rows.length, 1, '只应返回 qq-f1 的绑定（实得 ' + rows.length + '）')
  eq(rows[0].accountId, 'qq-f1', '账号要对')
})

await test('A67', 'releaseSeen 在账号已删时也能撤销占位（不然要等 60s TTL）', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-gone', platform: 'qq' })
  const verdict = svc.verdict('qq-gone', 'gone-1')
  eq(verdict.duplicate, false, '第一次应能占位')
  svc.removeAccount('qq-gone') // 账号删了（平台随之变成 unknown）
  // 账号没了以后 verdict 用的是另一个平台桶，看不到原占位 —— 但撤销必须仍然有效，
  // 否则这条 id 会卡到 60s TTL（releaseAny 会到所有平台桶里按同键撤销）。
  eq(svc.releaseSeen('qq-gone', 'gone-1'), true, '账号没了也要能撤销占位')
  svc.addAccount({ id: 'qq-gone', platform: 'qq' })
  eq(svc.verdict('qq-gone', 'gone-1').reserved, true, '撤销后应能重新占位')
})

await test('A68', 'status 能分清「没人发 / 绑定错 / 投递失败」：byAccount + bindingPeers', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'status-detail', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let fail = false
  const svc = new AccountService({
    baseDir: dir,
    logger: silentLogger,
    deliver: async () => { if (fail) throw Object.assign(new Error('会话没了'), { code: 'delivery/failed' }) },
  })
  svc.load()
  svc.registerAdapter(makeAdapter('qq'))
  svc.addAccount({ id: 'qq-st', platform: 'qq', inboundPolicy: 'create' })

  // 成功一条
  await svc.inbound({ accountId: 'qq-st', kind: 'user', peerId: '6701', message: { id: 'st-1', text: 'x' } })
  let st = svc.status().byAccount.find((x) => x.accountId === 'qq-st')
  eq(st.inbound, 1, 'byAccount.inbound 应计数')
  eq(st.delivered, 1, 'byAccount.delivered 应计数')
  check(!!st.lastInboundAt && !!st.lastDeliveryAt, '应有 lastInboundAt / lastDeliveryAt')
  const peers = svc.status().bindingPeers
  check(peers.some((p) => p.peerId === '6701' && p.mode === 'taker'), 'bindingPeers 应列出 peer→taker：' + JSON.stringify(peers))

  // 失败一条
  fail = true
  await svc.inbound({ accountId: 'qq-st', kind: 'user', peerId: '6701', message: { id: 'st-2', text: 'y' } })
  st = svc.status().byAccount.find((x) => x.accountId === 'qq-st')
  eq(st.failed >= 1, true, 'byAccount.failed 应计数')
  check(st.lastDeliveryError && st.lastDeliveryError.code === 'delivery/failed',
    'lastDeliveryError 应带原因：' + JSON.stringify(st.lastDeliveryError))

  // 没人发消息的账号：计数为 0（与"发了但失败"可区分）
  svc.addAccount({ id: 'qq-idle', platform: 'qq' })
  const idle = svc.status().byAccount.find((x) => x.accountId === 'qq-idle')
  eq(idle === undefined || idle.inbound === 0, true, '没流量的账号不应出现伪造计数')
})

/* ── 回归：收敛轮（connect 裸错误 / kind 归一 / 压缩判定） ── */

await test('A69', '适配器 connect 裸返回错误对象（{code,message,hint}）也要记成 error，不能假在线', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'bare-error', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  let calls = 0
  const adapter = makeAdapter('qq')
  // 复刻 mira_bilibili 的旧形状：catch 里直接 return normalized.error
  adapter.connect = async () => { calls += 1; return { code: 'creds/invalid', message: 'cookie 过期', hint: '重新登录' } }
  adapter.status = async () => ({ ok: true, connected: false })
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {}, config: { autoConnect: false } })
  svc.load()
  svc.registerAdapter(adapter)
  svc.addAccount({ id: 'qq-bare', platform: 'qq' })
  const report = await svc.connectAll()
  eq(report.failed.length, 1, '应记一条失败：' + JSON.stringify(report))
  eq(svc.store.getAccount('qq-bare').state, 'error', '不能记成 online（假在线）')
  eq(svc.store.getAccount('qq-bare').error.code, 'creds/invalid', '要保留具体错误码')

  // 巡检：creds/* 需要人工处理 → 不应反复重连
  calls = 0
  await svc.runHealthCheck()
  eq(calls, 0, '凭据类错误不应触发重连（实调 ' + calls + ' 次）')
})

await test('A70', 'bindings 无参返回全表（文档承诺）；带过滤才缩小', async () => {
  const { AccountService } = await import('../lib/service.js')
  const svc = new AccountService({ baseDir: BASE, logger: silentLogger, deliver: async () => {} })
  svc.load()
  svc.addAccount({ id: 'qq-all1', platform: 'qq' })
  svc.addAccount({ id: 'qq-all2', platform: 'qq' })
  svc.bind({ sessionId: 'S-a1', accountId: 'qq-all1', kind: 'user', peerId: '6801' })
  svc.bind({ sessionId: 'S-a2', accountId: 'qq-all2', kind: 'user', peerId: '6802' })
  const all = svc.bindings({})
  eq(all.length >= 2, true, '无过滤应返回全部（实得 ' + all.length + '）')
  const one = svc.bindings({ accountId: 'qq-all1' })
  eq(one.length, 1, '带过滤应缩小到 1 条')
})

await test('A71', '遗留的大写 kind 在加载时被归一：不再绕过单 taker，unbind 也能删掉', async () => {
  const { AccountService } = await import('../lib/service.js')
  const dir = join(TMP, 'kind-legacy', 'mira_config', 'mira_account')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ schemaVersion: 1, accounts: [{ id: 'qq-k', platform: 'qq', enabled: true }] }))
  writeFileSync(join(dir, 'bindings.json'), JSON.stringify({
    schemaVersion: 1,
    bindings: [{ sessionId: 'S-legacy', accountId: 'qq-k', kind: 'Group', peerId: '6901', mode: 'taker', createdAt: 'x', updatedAt: 'x' }],
  }))
  const svc = new AccountService({ baseDir: dir, logger: silentLogger, deliver: async () => {} })
  svc.load()
  eq(svc.store.findBindings()[0].kind, 'group', '加载后 kind 应归一成小写')
  let err = null
  try { svc.bind({ sessionId: 'S-new', accountId: 'qq-k', kind: 'group', peerId: '6901' }) } catch (error) { err = error }
  eq(err && err.code, 'binding/conflict', '大写遗留行也要能挡住第二个 taker')
  eq(svc.unbind({ accountId: 'qq-k', kind: 'Group', peerId: '6901' }).removed, 1, '用大写 kind 也能删掉')
})

await test('A72', '压缩：正式表写失败时不清追加日志（否则丢"已投递"证据）', async () => {
  const { Dedup } = await import('../lib/dedup.js')
  const base = join(TMP, 'compact-fail')
  mkdirSync(join(base, 'seen'), { recursive: true })
  const dedup = new Dedup(base, { ttlMs: 60 * 1000, maxEntries: 100 })
  dedup.load('qq')
  for (let i = 0; i < 5; i += 1) dedup.record('qq', 'qq-main|C' + i)
  const logBefore = readFileSync(join(base, 'seen', 'recent.ndjson'), 'utf8')
  check(logBefore.split('\n').filter(Boolean).length >= 5, '应写入 5 行日志')
  // 让正式表写不进去
  chmodSync(join(base, 'seen'), 0o500)
  dedup.writeFailed = false
  dedup.recentLines = dedup.recentLimit + 1
  dedup.record('qq', 'qq-main|C5')
  chmodSync(join(base, 'seen'), 0o700)
  check(dedup.writeFailed === true, '写失败应被记录')
  const logAfter = readFileSync(join(base, 'seen', 'recent.ndjson'), 'utf8')
  check(logAfter.length >= logBefore.length, '写失败时不能清空日志（实得 ' + logAfter.length + ' 字节）')
})

await test('A73', 'currentSessionId 优先用活会话 id（resume/克隆后 agent.id 可能是旧 id）', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx2 = makeCtx()
  const applied = apply(ctx2, { autoConnect: false })
  eq(applied && applied.ok, true, '新实例应能加载：' + JSON.stringify(applied))
  try {
    const api = ctx2.provided.get('miraAccount')
    api.addAccount({ id: 'qq-live', platform: 'qq' })
    // 现场复现的形状：exec.agent.id 是旧 id，agent.session.id 是会话目录的真 id
    const r = await callTool(ctx2, 'mira_account_bind', { accountId: 'qq-live', kind: 'user', peerId: '7301' },
      { agent: { id: 'stale-id', session: { id: 'live-id' } } })
    eq(r.ok, true, 'bind 应成功：' + JSON.stringify(r))
    const rows = api.bindings({ accountId: 'qq-live' })
    eq(rows.length, 1, '应有 1 条绑定')
    eq(rows[0].sessionId, 'live-id', '绑定要用活会话 id（不是 agent.id）')
    eq(rows[0].boundBy, 'live-id', 'boundBy 也要用活会话 id')
  } finally {
    ctx2.dispose()
  }
})

/* ── 结果 ───────────────────────────────────────────────── */

rmSync(TMP, { recursive: true, force: true })

console.log('通过 ' + passed + ' 项断言')
if (failures.length) {
  for (const f of failures) console.log('[FAIL] ' + f)
  console.log('\n==== FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + passed + ' 项断言）====')
process.exit(0)
