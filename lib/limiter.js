/**
 * mira_account / limiter.js —— 通用令牌桶（按账号维度，读 / 写分桶）
 *
 * 定位（PLAN §3.4 的取舍）：这里是**通用**限流，供 qq 这类没有自己预算的插件用；
 * mira_bilibili 的读写预算在它自己插件内是**权威**的（任务书功能点4：预算不许被单次调用绕过），
 * 两层都过。所以本模块只做「窗口计数 + 全局暂停」，不替平台做风控判断。
 *
 * 窗口：perMinute / perHour / perDay，0 或缺省 = 不限。
 */

export const KINDS = ['read', 'write']

const DEFAULTS = { perMinute: 0, perHour: 0, perDay: 0 }

export class Limiter {
  constructor(limits = {}, options = {}) {
    this.now = options.now ?? (() => Date.now())
    this.limits = {}
    for (const kind of KINDS) {
      this.limits[kind] = { ...DEFAULTS, ...(limits?.[kind] ?? {}) }
      // 允许简写：limits.read = 100 等价于 perHour:100
      if (typeof limits?.[kind] === 'number') this.limits[kind] = { ...DEFAULTS, perHour: limits[kind] }
    }
    /** kind -> number[]（命中时刻） */
    this.hits = { read: [], write: [] }
    this.pausedUntil = 0
    this.pauseReason = ''
  }

  #windowMs(kind) {
    const limit = this.limits[kind]
    // 以最细的已配置窗口做裁剪基准
    if (limit.perMinute > 0) return 24 * 60 * 60 * 1000
    return 24 * 60 * 60 * 1000
  }

  #prune(kind) {
    const cutoff = this.now() - this.#windowMs(kind)
    const list = this.hits[kind]
    let drop = 0
    while (drop < list.length && list[drop] < cutoff) drop++
    if (drop > 0) list.splice(0, drop)
  }

  #count(kind, windowMs) {
    const cutoff = this.now() - windowMs
    let n = 0
    for (let i = this.hits[kind].length - 1; i >= 0; i--) {
      if (this.hits[kind][i] >= cutoff) n++
      else break
    }
    return n
  }

  pause(ms, reason = '') {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.max(0, Number(ms) || 0))
    this.pauseReason = String(reason || 'paused')
    return this.pausedUntil
  }

  resume() {
    this.pausedUntil = 0
    this.pauseReason = ''
  }

  isPaused() {
    return this.pausedUntil > this.now()
  }

  /**
   * 记一次调用。返回 { ok:true } 或 { ok:false, code, message, hint, retryAfterMs }。
   * 被拒时**不消耗**配额。
   */
  take(kind = 'read') {
    const k = KINDS.includes(kind) ? kind : 'read'
    const now = this.now()
    if (this.isPaused()) {
      const retryAfterMs = this.pausedUntil - now
      return {
        ok: false,
        code: 'limit/paused',
        message: '全局暂停中（' + (this.pauseReason || '已暂停') + '），还需 ' + Math.ceil(retryAfterMs / 1000) + ' 秒',
        hint: '等暂停结束，或修好触发风控的原因',
        retryAfterMs,
      }
    }
    this.#prune(k)
    const limit = this.limits[k]
    const checks = [
      ['perMinute', 60 * 1000],
      ['perHour', 60 * 60 * 1000],
      ['perDay', 24 * 60 * 60 * 1000],
    ]
    for (const [key, windowMs] of checks) {
      const cap = Number(limit[key]) || 0
      if (cap <= 0) continue
      if (this.#count(k, windowMs) >= cap) {
        return {
          ok: false,
          code: 'limit/exceeded',
          message: kind + ' 预算用尽（' + key + ' 上限 ' + cap + '）',
          hint: '等窗口过去，或把 config.limits.' + kind + '.' + key + ' 调大（预算不接受单次调用绕过）',
          retryAfterMs: windowMs,
        }
      }
    }
    this.hits[k].push(now)
    return { ok: true }
  }

  snapshot() {
    const out = { paused: this.isPaused(), pausedUntil: this.pausedUntil || null, pauseReason: this.pauseReason || null }
    for (const kind of KINDS) {
      const limit = this.limits[kind]
      out[kind] = {
        limits: { ...limit },
        used: {
          perMinute: limit.perMinute > 0 ? this.#count(kind, 60 * 1000) : null,
          perHour: limit.perHour > 0 ? this.#count(kind, 60 * 60 * 1000) : null,
          perDay: limit.perDay > 0 ? this.#count(kind, 24 * 60 * 60 * 1000) : null,
        },
      }
    }
    return out
  }
}
