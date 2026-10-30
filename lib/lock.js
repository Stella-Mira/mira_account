/**
 * mira_account / lock.js —— 跨进程单写者锁。
 *
 * `claimInstance()` 用的是 globalThis，只挡得住**同一个进程**里的重复加载。
 * 但两个 DSH 进程（GUI + `dsh headless`，或忘记关掉的旧实例）各自连同一个 QQ 账号时，
 * 两边都会回一遍 —— 而去重表在内存里，进程之间互相不知道。
 *
 * 这里用一个带 pid 的锁文件把「一个 DSH_HOME 只能有一个 mira_account」变成跨进程的约束。
 * 持有者 pid 已经死了（kill 0 失败）就视为陈旧锁，直接接管；否则拒绝加载。
 *
 * 只依赖 node: 内置能力。
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

function isAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限发信号，仍算活着
    return error && error.code === 'EPERM'
  }
}

/**
 * 尝试拿锁。
 * @returns {{ok:true, held::{pid:number}, release:()=>void} | {ok:false, error:object}}
 */
export function acquireProcessLock(baseDir, { pid = process.pid, logger = null } = {}) {
  const file = join(baseDir, '.lock')
  const body = JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString() }, null, 2) + '\n'
  const make = () => {
    // 原子创建（O_EXCL）：两个进程同时启动时，只有一个能创建成功，
    // 另一个必然拿到 EEXIST —— 先读后写做不到这一点（TOCTOU）。
    const fd = openSync(file, 'wx', 0o600)
    try {
      writeSync(fd, body, null, 'utf8')
      fsyncSync(fd) // 锁文件内容也要落地，否则崩溃后 pid 读不出来会被当成陈旧锁
    } finally {
      closeSync(fd)
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      make()
      return {
        ok: true,
        held: { pid },
        release() {
          try {
            const cur = JSON.parse(readFileSync(file, 'utf8'))
            if (Number(cur && cur.pid) === pid) unlinkSync(file)
          } catch { /* 不是自己的锁/已消失：不动 */ }
        },
      }
    } catch (error) {
      if (error && error.code !== 'EEXIST') {
        return {
          ok: false,
          error: {
            code: 'config/write-failed',
            message: '锁文件写不出来：' + file + '（' + (error?.message ?? error) + '）',
            hint: '检查该目录权限；mira_account 的状态文件都写在这里',
          },
        }
      }
    }

    // 已存在：看看持有者是否还活着
    let info = null
    try { info = JSON.parse(readFileSync(file, 'utf8')) } catch { info = null }
    const holder = Number(info && info.pid) || 0
    const holderHost = String((info && info.host) || '')
    const me = hostname()
    if (holder && holderHost && holderHost !== me) {
      // 另一台机器上的进程（DSH_HOME 在共享盘/NFS 上）：无法判断它是否还活着，宁可不启动
      return {
        ok: false,
        error: {
          code: 'plugin/instance',
          message: '锁文件由另一台主机（' + holderHost + '，pid ' + holder + '）持有：' + file,
          hint: '确认那台机器上的 DSH 已经退出后，删掉这个锁文件再启动；共享 DSH_HOME 不能同时跑两个 mira_account',
        },
      }
    }
    if (holder && holder !== pid && isAlive(holder)) {
      return {
        ok: false,
        error: {
          code: 'plugin/instance',
          message: '另一个进程（pid ' + holder + '，自 ' + (info.startedAt || '?') + ' 起）正在用同一个 DSH_HOME 的 mira_account',
          hint: '同时跑两个 DSH 进程会让同一个账号收到两份回复；关掉一个，或给另一个换 DSH_HOME。'
            + '如果确定那个进程已经不在了，删掉 ' + file,
        },
      }
    }
    // 陈旧锁（或读不出来）：用 **rename 抢占**再重建。
    // 不能 unlink+create：两个进程同时看到陈旧锁时会各删一次、各建一次，双双成功（评审实测 15 轮里 9 轮双持有）。
    // rename 是原子的 —— 只有一个进程能把它搬走，输的那个拿到 ENOENT，回到循环重试 create。
    const stale = file + '.stale.' + pid + '.' + Math.random().toString(36).slice(2, 8)
    try {
      renameSync(file, stale)
    } catch (error) {
      if (error && error.code === 'ENOENT') continue // 别人先抢走了，直接重试创建
      return {
        ok: false,
        error: {
          code: 'config/write-failed',
          message: '接管陈旧锁失败：' + file + '（' + (error?.message ?? error) + '）',
          hint: '检查目录权限；必要时手动删除该 .lock 文件',
        },
      }
    }
    // rename 之后核对：搬走的必须是我们刚才读到的那把锁（read→rename 之间它可能被替换成别人的新锁）
    let moved = null
    try { moved = JSON.parse(readFileSync(stale, 'utf8')) } catch { moved = null }
    if (holder && moved && (Number(moved.pid) || 0) !== holder) {
      try { renameSync(stale, file) } catch { /* 放不回去就只能删，避免留下垃圾 */ }
      continue // 当没抢到，下一轮重试
    }
    try { unlinkSync(stale) } catch { /* 搬走了就行 */ }
    logger?.warn?.('[mira_account] 接管陈旧锁 ' + file + '（旧 pid ' + (holder || '?') + '）')
  }

  return {
    ok: false,
    error: {
      code: 'plugin/instance',
      message: '拿不到 mira_account 的锁文件：' + file,
      hint: '重试仍被占用；确认没有别的 DSH 进程在用同一个 DSH_HOME，再删掉该文件',
    },
  }
}

export const __testing = { isAlive }
