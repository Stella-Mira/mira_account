# mira_account

DSH 的**账号管理框架**：账号池 + 会话绑定 + 入站路由 + `message_id` 去重 + 令牌桶限流。
qq / 微信 / B 站 bot 插件只做协议层（适配器），「哪个账号、哪个会话在应答谁」只有这一份。

> 待办：`mira_account` 是 `mira_qqbot` / `mira_bilibili` / `mira_wxbot` 的**前置依赖**。
> 只装 bot 插件不装它，那些插件会因为 `inject: ['miraAccount']` 不满足而**不加载**（工具全消失）。
> 这是刻意的：硬依赖比「起来了但发不出去」好排查。`mira_account_status` 能自证它在跑。

```
落盘：$DSH_HOME/mira_config/mira_account/     （DSH_HOME 缺省 ~/.dsh）
  accounts.json        账号池（不含凭据本体）
  bindings.json        绑定表（坏了不致命：丢弃重建并 warn，账号池不受影响）
  creds/<id>.json      凭据本体，600，永不回显、不进日志、不进工具返回
  seen/<platform>.json message_id 去重表（带 TTL）
```

本机实测 `DSH_HOME=$DSH_HOME` → 实际落 `$DSH_HOME/mira_config/mira_account/`。

## 配置

配置来自 profile 里该插件行的 `config`（cordis patch），全部可省略：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不注册工具、不提供服务（插件行仍在，便于临时关） |
| `autoConnect` | `true` | 加载后按账号池自动 `connect` 所有启用账号。关掉只是不自动连，工具照常工作 |
| `health.enabled` / `health.intervalMs` | `true` / `30000` | 健康巡检：定时调 `adapter.status()` 刷新账号真实状态（没有它 state 会永远停在 connect 那一刻＝"假在线"） |
| `reconnect.enabled` / `minMs` / `maxMs` | `true` / `5000` / `300000` | 断线重连：`error`/`offline` 的账号按指数退避重连（min × 2ⁿ，封顶 max） |
| `limits.read` / `limits.write` | 全 `0`（不限） | 按账号维度的通用令牌桶：`{ perMinute, perHour, perDay }`。也接受简写 `limits.read: 100`（= 每小时 100） |
| `dedup.ttlMs` | `1800000`（30 分钟） | 去重 id 的存活时间 |
| `dedup.maxEntries` | `5000` | 每平台去重表条数上限（超出按最旧淘汰） |

必备配置项**没有**：账号池为空不算配置错误 —— 插件照常加载，任何需要账号的工具返回
`account/none` 并告诉你去哪个文件登记。**不自动创建账号、不自动登录、不自动探测**。

## 落盘格式

`accounts.json`（手填或 `mira_account_add` 写；`schemaVersion` 不符会拒绝该文件并报 `config/schema`）：

```json
{
  "schemaVersion": 1,
  "accounts": [{
    "id": "qq-main",
    "platform": "qq",
    "label": "主号",
    "enabled": true,
    "state": "offline",
    "error": null,
    "inboundPolicy": "create",
    "defaultSessionId": "",
    "createdAt": "2026-10-26T15:00:00.000Z",
    "lastLoginAt": null
  }]
}
```

- `platform`：`qq` / `wx` / `bilibili` / `vtuber`（新增平台要先在 `lib/store.js` 的 `PLATFORMS` 登记）
- `inboundPolicy`（无绑定时怎么办）：`create` 新建会话｜`default` 投 `defaultSessionId`｜`drop` 丢弃并计数
- `state` / `error` / `lastLoginAt` 由适配器回报，手填会被覆盖

### 本地虚拟平台 `vtuber`

`vtuber` 没有对外连接，也不需要适配器：登记后直接记 `online`（进程活着就算在线）。
它的用途是给「形象」当**权限主体** —— peer 类型只有 `avatar`（通常 `peerId: "main"`），
**会话**是绑定的主体，于是同一个形象自然满足「一个 taker + 多个 observer」：

```
mira_account_add    { id: "vtuber-main", platform: "vtuber", label: "形象" }
mira_account_bind   { sessionId: "会话A", accountId: "vtuber-main", kind: "avatar", peerId: "main", mode: "taker" }   // 能控
mira_account_bind   { sessionId: "会话B", accountId: "vtuber-main", kind: "avatar", peerId: "main", observer: true }  // 只能看
```

> 为什么 peer 是 `avatar` 而不是 `session`：peer 若用 sessionId，每个会话都会成为**自己那条 peer** 的
> taker，永远不会冲突，"单 taker" 约束就失效了。消费方（muse_vtuber）按这套判定：
> 接收 = observer 或 taker，控制 = 必须 taker。

`creds/<id>.json`（**只能手填**，权限 600）：

```json
{
  "schemaVersion": 1,
  "platform": "qq",
  "kind": "token",
  "fields": { "access_token": "…" },
  "updatedAt": "2026-10-26T15:00:00.000Z"
}
```

`kind` = `cookie` / `token` / `qrcode`；`fields` 的键名由平台适配器自己定（框架不理解内容）。
读不到 → `creds/missing`；权限不是 600 → `credsStatus` 会顺手改回 600 并在状态里标 `modeOk`。

## 健康巡检与重连

`adapter.status()` 是契约里要求实现的方法 —— 但**光要求不调用等于没有**：以前 `state` 永远停在
`connect` 那一刻，适配器断线了 `status` 里还写着 `online`（"假在线"），`error` 账号也不会自己恢复。

现在每 `health.intervalMs`（默认 30s，定时器 `unref` 不拖住进程退出）跑一轮：

1. 逐个账号调 `adapter.status(account)`，把结论归一成 `online / offline / error`：
   `{ok:false,error}` → `error`；`{state:"online"|"offline"|"error"}` → 直接采用；
   `{connected:true|false}` → `online`/`offline`（qqbot 的 ws 连接、bilibili 的登录态都落这一档）；
   判不出来就**不改**（不瞎猜）。
2. `error`/`offline` 的账号按指数退避重连（`reconnect.minMs × 2ⁿ`，封顶 `maxMs`）：成功清零退避并计
   `reconnects`，失败把 `attempts` 与 `retryInSeconds` 记进 `status.health.backoff`。

状态只在**发生变化**时打一行 info（不会每 30s 刷日志）。`status.health` 给
`running / intervalMs / lastRunAt / checks / errors / reconnects / backoff[]`。

插件卸载的顺序是：摘工具 → 停巡检 → **同步** flush 去重表 → 异步 `disconnectAll()` → 放服务 → **最后**放进程锁与单实例认领；
`apply` 中途抛错也会释放认领（否则修好后重载只会得到 `plugin/instance`，只能重启 DSH）。

> 取舍：`adapter.status()` 是"每 30s 问一次"的轮询，不是推送 —— 两轮之间断线时状态最多滞后一个
> `health.intervalMs`；重连窗口里平台重推的同一条消息由去重表按 `message_id` 挡住。

## 工具

| 工具 | 说明 |
|---|---|
| `mira_account_list` | 账号清单（含 `creds` 是否有、字段名、权限是否合规）。账号池空 → `account/none` |
| `mira_account_status` | 只读状态：路径、账号/连接态、绑定统计、已注册适配器、去重表大小、限流余量、错误计数、最近错误。**配置坏了也照样返回**（在 `warnings` 里如实报告），否则没法诊断 |
| `mira_account_bind` | 会话 ↔ peer 绑定。不给 `sessionId` 用当前会话；`taker` 冲突要 `force` 或 `observer` |
| `mira_account_unbind` | 解绑：必须给 `sessionId`，**或** `accountId`+`kind`+`peerId` 三件套；只给一部分会被拒（避免误删全表）。**不会默认用当前会话** |
| `mira_account_bindings` | 双向查：会话 → peers / peer → taker + observers / 不带条件列全部 |
| `mira_account_add` | 登记账号**行**（不含凭据）。登记后 `state=error / creds/missing` 直到手填凭据 |
| `mira_account_remove` | 删账号 + 它名下全部绑定。**不删凭据文件**（避免误删，要删请手工删） |
| `mira_account_toggle` | 启用/停用账号（停用后入站 `account/disabled` 丢弃计数，出站直接报错） |

前 5 个是任务书功能点9 要求的；后 3 个补功能点1 的「新增/启停/删除」。
**没有**写凭据的工具 —— 工具参数会进会话记录，凭据一经工具传递就等于回显（PLAN §3.3）。

## 给 bot 插件的契约

`ctx.provide('miraAccount', api)` 暴露的就是下面这些入口（`lib/index.js` 的 `createApi`）：

```js
// 适配器（任务书功能点2）
registerAdapter(adapter) -> dispose      // adapter = { platform, connect, disconnect, send, onMessage, status, createSession? }
adapterFor(platform)

// 账号池
listAccounts() / requireAccount(id) / requireAdapter(platform)
addAccount({id,platform,label,inboundPolicy,defaultSessionId}) / removeAccount(id) / setAccountEnabled(id,bool)
setState(id, 'online'|'offline'|'error', error)

// 绑定
bind({sessionId,accountId,kind,peerId,mode,force,observer,boundBy})   // boundBy = 发起方会话（审计）
unbind(query) / bindings(sessionId?) / resolve(accountId,kind,peerId)

// 收发
send({accountId,kind,peerId,payload,sessionId?,force?,observer?}) -> {ok,messageId,binding}
inbound({accountId,kind,peerId,message:{id,text,sender},display?,source?})
  -> {routed:'taker'|'observer'|'created'|'default'|'dropped'|'dup'|'error'}
  // source（可选）= { kind }：投递时写进 message.source（宿主读 source.kind）。不给就是 'user'。
  //   bot 插件应当写上自己，例如 mira_bilibili → { kind: 'mira_bilibili' }；
  //   空串/非法值一律回落 'user'（老插件不传也不会崩）。
  // deliver 回调收到的 meta 里带 mode:'taker'|'observer'|'default' 与 source —— bot 插件据此在提示词里
  // 告诉 agent「你是应答方还是旁听」：mira_qqbot 自己拼【本会话角色】不依赖它；
  // bilibili 没有角色声明，靠框架这句
  // ⚠️ 正文（message.text）由 bot 插件自己拼（安全规则/识别名单/消息来源/行为规则），
  //    framework 只做两件事：observer 时在最前面加一句旁听提示、原样投递。

// 去重（入站路径请用 verdict → 投递 → recordSeen，不要用 seen：那会先记账后投递）
verdict(accountId,messageId) -> { duplicate, echo }        // 只查**并占位**（不落表；投递成功 recordSeen / 失败 releaseSeen）
recordSeen(accountId,messageId)                            // 投递成功后记账（并释放占位）
releaseSeen(accountId,messageId)                           // 投递失败时撤销占位（之后同 id 还能再试）
seen(accountId,messageId) / markSeen(...) / markSelf(...)   // 旧的"查+记"一步到位，只用于"查到就算处理完"的地方

// 观测
status() / noteError(error) / setCreateSession(fn)
```

三条硬约定（任务书 §mira_account 契约 A/B/C）：

- **A** 入站一律 `inbound()`，bot 插件不许自己维护 session 映射
- **B** 出站一律 `send()`，它负责「先 bind 或复用已有 binding，再 `adapter.send`」
- **C** 平台错误用同一套归一错误码（下表）

`adapter.send(account, kind, peerId, payload)` 返回 `{ ok:true, messageId }`；返回的 `messageId`
会被自动记成「自己发的」，平台把同一条回推时按 echo 丢掉。
`adapter.createSession({account,kind,peerId,display,text})` 是**可选**的：只有 `inboundPolicy=create`
用到它，而创建会话需要 cwd / preset 这类平台自己的配置，所以由 bot 插件提供。

**提示词归属**：`message.text` 由 bot 插件拼好（安全规则 / 识别名单 / 消息来源 / 行为规则 /
聊天消息），框架只做两件事 —— observer 分支在最前面加一句旁听提示，其余原样投递。
（`mira_qqbot`、`mira_bilibili` 都按 qqbot 那套六段格式拼；早期 bilibili 传裸文本，
会话里既没有来源说明也没有配置里的规则块，已在 r1xx 修掉。）

## 错误码

| code | 场景 |
|---|---|
| `account/none` | 账号池为空（list 时） |
| `account/not-found` | 账号不在池里 |
| `account/disabled` | 账号存在但 `enabled:false` |
| `account/exists` / `account/invalid` | 重复登记 / id 非法 |
| `creds/missing` | 凭据文件缺或没有 `fields` |
| `creds/invalid` | 凭据平台不符 / 无权限读 |
| `binding/conflict` | 同 peer 已有别的 taker，且没给 `force` / `observer` |
| `platform/unsupported` | 没有该平台适配器 / 平台名不在 `PLATFORMS` |
| `platform/duplicate` | 同平台注册了第二个适配器 |
| `delivery/failed` | 投递到会话或平台发送失败 |
| `limit/exceeded` / `limit/paused` | 令牌桶用尽 / 全局暂停 |
| `config/missing` | 必备参数为空（peerId / sessionId / payload） |
| `config/schema` | `schemaVersion` 不符（拒绝该文件，不静默兼容） |
| `config/invalid` | 参数不合法（sessionId/peerId/mode 格式、enabled 不是布尔等） |
| `config/write-failed` | 写盘失败（内存改动未落盘；`status.writeError` 里有原因） |
| `session/create-unsupported` | `inboundPolicy=create` 但该平台没有 `createSession` |
| `session/create-failed` | 适配器 `createSession` 没返回 sessionId |
| `plugin/instance` | 单实例保护：同 id 第二个实例 |

## 已知取舍

0. **去重记账在投递成功之后**（2026-10-27 修）：以前 `dedup.check()` 投递前就记账，投递失败
   （会话忙超时 / agent 崩 / `createSession` 炸 / sessionId 拼错）时这条 message_id 已被吞掉，
   平台重推会被当成重复直接丢弃 —— 表现是「消息已读、永远不回，且没有任何记录」。
   现在拆成 `verdict()`（只查）+ `recordSeen()`（成功后记）；bot 插件的入站快路径也要照这个顺序。
0b. **`upsertBinding` 在写入处拒绝第二个 taker**（2026-10-27 修）：单 taker 原来只在**加载时**修补，
   同一 peer 的并发首条消息会各建一个会话、各登记一个 taker（影子 taker 只在下次重启被降级，
   且降级只写内存）。现在：写入即拒 + `Router` 有 **per-peer 创建锁**（并发首条消息共用一次 `createSession`）。
0c. **`createSession` 按平台注册**：以前是全局单槽，装两个 bot 插件时后注册的会顶掉前一个
   （qq 的新 peer 被 bilibili 的 cwd/preset 建会话）；适配器卸载时一并清除。
0d. **写盘失败会抛 `config/write-failed`**，不再静默返回 `false`：`accounts.json`/`bindings.json`
   的 `save*` 失败会让工具报错、并记进 `status.writeError`（`setState` 例外，它只记不抛，避免打断连接）。
   `.tmp` 文件名也带 pid+随机后缀（原来固定 `file+'.tmp'`，两个进程同时写会互相撕坏）。
0e. **坏文件改名保留**：`bindings.json` 解析失败会改名成 `bindings.json.corrupt.<ts>` 再按空表重建
   （以前是"丢弃重建"，但第一次正常写盘就把坏文件覆盖了，等于把用户数据当垃圾扔掉）。
   `accounts.json` 仍然走"拒绝使用且拒绝覆盖"的更严格策略。
0f. **非法 `platform` 的账号在加载时跳过**并 warn：`platform` 会被拼进去重表文件名，
   不校验就可能 `../../` 越界写文件（`platform:"../../PWNED"` 实测能在 baseDir 外落盘）。
0g. **`send()` 先限流、后绑定，发送失败回滚绑定**：原来顺序相反，一次被限流拒绝的 `force` 抢答
   已经把 taker 换掉了、消息一条没发；`adapter.send` 抛错时同理。
0i. **`bind` 只校验 sessionId 的格式，不校验存在性**（2026-10-27）：空 / 内部空白 / 控制字符 / 超长
   直接 `config/invalid`（这种"看起来对但永远投不到"的拼写是最常见的黑洞）；但**不**去问宿主
   "这个会话存不存在" —— 那要唤醒 agent（有副作用、代价大）。绑定行会记 `boundBy`（哪个会话发起的），
   入站自动登记时为空，方便事后审计"这条线是谁抢的"。
   conflict 的 hint 也改了措辞：不再直白教"加 force:true"，而是先让人确认该不该接管。
0j. **去重键是「账号id|消息id」，且带 in-flight 占位**（2026-10-27 第二轮评审）：
    · 只管 message_id 的话，同一平台两个账号撞号时后到的**真实消息**会被判 dup 静默丢掉；
    · `verdict()` 命中就**占位**，`record()`（成功）/`release()`（失败）释放 —— 否则两条同 id 并发
      消息都会看到 `duplicate:false` 各投一遍。占位带 60s TTL 兜底。
0j2. **去重表额外有一份追加日志 `seen/recent.ndjson`**：每条投递成功追加一行（~80 字节），
    重启时回放。整张表有 TTL/上限、体积大，每条重写太贵；但只要"已投递"只在内存里，
    **进程骤崩就会丢掉最近最多 2 秒的记录**，平台重推就会重复回复。追加日志把重复窗口
    从"最多 2 秒"缩到"最多一条（崩在投递与追加之间）"。日志超过 2000 行自动压缩（写正式表 + 清空）。
    仍然存在的窗口：崩在 deliver 成功与 record 之间 —— 这是"至少一次"投递的固有代价，已在取舍里写明。
0k. **回滚是"条件回滚"**：`send()` 失败时只在"这期间没有别人接管这条线"时才恢复快照。
    无条件恢复会把别人刚 force 抢到的 taker 一起抹掉（评审实测：A 发送挂起 → B 抢答成功 →
    A 失败回滚 → 该 peer 0 行，B 的会话永远收不到消息）。
0l. **绑定完整性**：`upsertBinding` 拒绝给不存在的账号写绑定；加载时丢弃指向已删账号的悬空绑定
    并落盘（否则用同一个 id 重新登记账号时旧绑定会立刻"复活"，把新账号的入站路由到旧会话）。
0m. **跨进程单写者**：`claimInstance` 只管进程内，所以另加一个带 pid 的锁文件 `$DSH_HOME/mira_config/mira_account/.lock`。
    持有者进程还活着时，第二个 DSH 进程加载会得到 `plugin/instance`（提示"两个进程会让同一个账号收两份回复"）；
    持有者已死（kill 0 失败）则接管陈旧锁。
0h. **旁听语义由框架保证**：`deliver(sessionId, text, meta)` 现在真的收到 `meta.mode`，
   `mode==='observer'` 时框架会在正文最前面加一句「你只是旁听者，不要回复；要接管用 mira_account_bind force:true」。
   以前 meta 被丢掉，bilibili 的旁听会话收到的是没有任何角色标记的用户消息（照样抢话）。

1. **有 taker 时 observer 不再收一份**（任务书功能点5 的字面口径：「有 taker → 投给它」「只有 observer → 只投 observer」）。
   两个会话各收一份等于各回一句，抢答更难治。要旁听者也能看到，就把它设成 taker 的另一个 observer 并接受它不该随口应答。
2. **`force` 抢答把旧 taker 降级成 observer，不删除**。删了不可逆；降级后它仍能看到后续消息，后悔了再 `force` 回来即可。
3. **`unbind` 不给 `sessionId` 时不默认当前会话**。`bind` 默认当前会话是便利，`unbind` 默认当前会话是危险 —— 不对称是故意的。
4. **`listAccounts()` 在 accounts.json 坏 / 版本不符时抛错**，而不是返回空表：返回空表会让上层以为「没有账号」，
   于是所有绑定看起来都失效了，真正的原因（文件坏了）反而被埋掉。`status()` 仍然可读，`warnings.accounts` 里有详情。
5. **`bindings.json` 坏了不致命**：丢弃重建 + warn（任务书原文「可从 accounts 重建，坏了不致命」）。同 peer 多个 taker
   （手改文件造成）会在加载时保留 `updatedAt` 最新的那个，其余降级 observer 并 warn。
6. **限流在框架层是通用兜底**，bilibili 的读/写预算在 `mira_bilibili` 自己的 `budget.js` 里**权威**生效（两层都过）。
   任务书把这个说法分给了两个插件，这里按 PLAN §3.4 的口径落地。
7. **凭据只能手填**。没有「传 token 的工具」，因为工具参数会落进会话记录。
8. **凭据在进程内交给适配器**（`connect(account, creds)`），不出现在返回值与日志里；`redact()` 兜底抹掉疑似凭据。

## 迁移

从旧 bot 插件各自维护的 `chatId → sessionId` 表迁过来（`mira_qqbot` / `mira_bilibili` 的 `<agentCwd>/data/meta.json`）：

```bash
# 先看计划（默认 dry-run，不写盘）
node tool_shared/migrate/bindings.mjs --from ~/dsh-work/data/meta.json --platform qq --account qq-main
# 确认后写入（会先备份 bindings.json）
node tool_shared/migrate/bindings.mjs --from ... --write
```

规则：`"user:123"` → `kind:"user"`，`"group:456"` → `kind:"group"`，`mode:"taker"`；
`accountId` 必须已经在 `accounts.json` 里存在，否则**报错不自动建**（不猜）。
旧文件改名成 `meta.json.bak.<时间戳>` 保留，不删除。

## 自检

```bash
cd mira_account && node test/smoke.mjs      # 期望末行：==== ALL PASS（242 项断言）====，退出码 0
node ../tool_shared/tools/check-zero-dep.mjs   # 只许 node: 与相对 import
node ../tool_shared/tools/check-kit.mjs        # lib/kit.mjs 与规范源逐字节一致
```

smoke 覆盖 PLAN §1.1 的 A2–A14，并在临时 `DSH_HOME` 里跑（不碰真实配置）。
