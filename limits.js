'use strict';

/**
 * 写入防护：来源校验 / 每 IP 滑动窗口限流 / 全局容量水位线。
 * 零依赖，状态只存在本进程内；PM2 cluster 多实例需要各自独立计数或换外部存储。
 */
const config = require('./config');
const store = require('./store');

// ---------- 来源校验（防跨站表单静默覆盖 / 清空笔记）----------
function isTrustedWrite(req) {
  // Sec-Fetch-Site 由浏览器设置，脚本无法伪造
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';

  // 无 Origin 的请求（curl / wget / 老客户端）保持兼容，只拒绝明确跨源的请求
  const origin = req.headers['origin'];
  if (!origin) return true;
  let host;
  try {
    host = new URL(String(origin)).host;
  } catch {
    return false;
  }
  return host === req.headers.host || config.allowedOrigins.includes(host);
}

// ---------- 客户端 IP ----------
function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- 每 IP 滑动窗口 ----------
const writes = new Map(); // ip -> { stamps: number[], news: number[] }

function prune(now) {
  const cutoff = now - config.rateLimit.windowMs;
  for (const [ip, rec] of writes) {
    rec.stamps = rec.stamps.filter((t) => t > cutoff);
    rec.news = rec.news.filter((t) => t > cutoff);
    if (!rec.stamps.length && !rec.news.length) writes.delete(ip);
  }
}

function retryAfter(rec, now) {
  const oldest = rec.stamps.length ? rec.stamps[0] : rec.news[0];
  return Math.max(1, Math.ceil((oldest + config.rateLimit.windowMs - now) / 1000));
}

function checkWrite(ip, isNew, now = Date.now()) {
  if (config.rateLimit.exemptIps.includes(ip)) return null;
  prune(now);
  const rec = writes.get(ip) || { stamps: [], news: [] };
  if (rec.stamps.length >= config.rateLimit.maxWrites) {
    return { status: 429, retryAfter: retryAfter(rec, now), reason: '写入过于频繁' };
  }
  if (isNew && rec.news.length >= config.rateLimit.maxNewNotes) {
    return { status: 429, retryAfter: retryAfter(rec, now), reason: '新建笔记过多' };
  }
  return null;
}

function recordWrite(ip, isNew, now = Date.now()) {
  if (config.rateLimit.exemptIps.includes(ip)) return;
  const rec = writes.get(ip) || { stamps: [], news: [] };
  rec.stamps.push(now);
  if (isNew) rec.news.push(now);
  writes.set(ip, rec);
}

// ---------- 全局容量水位线 ----------
let usageCache = null;

async function currentUsage() {
  if (usageCache && Date.now() - usageCache.at < config.quota.refreshMs) return usageCache;
  usageCache = { ...(await store.usage()), at: Date.now() };
  return usageCache;
}

// byteDelta 是本次写入相对旧文件的净增量（删除时为负）
async function checkQuota(byteDelta, isNew) {
  const u = await currentUsage();
  if (u.files + (isNew ? 1 : 0) > config.quota.maxFiles) {
    return { status: 507, reason: '笔记数量已达上限' };
  }
  if (u.bytes + byteDelta > config.quota.maxTotalBytes) {
    return { status: 507, reason: '存储空间已达上限' };
  }
  return null;
}

function adjustUsage(byteDelta, fileDelta) {
  if (!usageCache) return;
  usageCache.bytes = Math.max(0, usageCache.bytes + byteDelta);
  usageCache.files = Math.max(0, usageCache.files + fileDelta);
}

function reset() {
  writes.clear();
  usageCache = null;
}

module.exports = {
  isTrustedWrite,
  clientIp,
  checkWrite,
  recordWrite,
  checkQuota,
  adjustUsage,
  reset,
};
