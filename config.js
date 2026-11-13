'use strict';

/**
 * 集中配置。路径均可用环境变量覆盖，方便本地 Windows / 线上 Linux 切换。
 */
const path = require('node:path');

const ROOT = __dirname;
const PARENT = path.resolve(ROOT, '..');

function resolveFromRoot(value, fallback) {
  return value ? path.resolve(ROOT, value) : fallback;
}

module.exports = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT) || 3000,

  // 笔记数据默认隔离在 new/data，绝不写入上级 _tmp
  dataDir: resolveFromRoot(process.env.DATA_DIR, path.join(ROOT, 'data')),

  // 仅供导入脚本读取旧数据，全程只读
  legacyDataDir: path.join(PARENT, '_tmp'),

  // 静态资源默认是 new/public 的副本。
  // 若想直接复用原目录、避免维护两份，启动时设 STATIC_DIR=.. 即可。
  staticDir: resolveFromRoot(process.env.STATIC_DIR, path.join(ROOT, 'public')),

  // 前端 JS / CSS 有改动时递增，避免浏览器缓存旧文件
  assetVersion: '20261112a',

  // 依赖的净化库版本（HTML 模板引用；升级时同步改这里和模板）
  dompurifyVersion: '3.4.17',

  // 与 index.php:16 完全一致
  noteIdPattern: /^[a-zA-Z0-9_-]{1,64}$/,

  // 与 index.php:19 的 str_shuffle 字母表一致
  idAlphabet: '234579abcdefghjkmnpqrstwxyz',
  idLength: 5,

  // PHP 版未限制 body，这里显式设上限，防止单条笔记打爆内存
  maxBodyBytes: 1 * 1024 * 1024,

  // 默认关闭：开启后 /Abc 与 /abc 会归一为同一篇，属于行为变更，需显式启用
  lowercaseIds: process.env.LOWERCASE_IDS === '1',

  // list() 过滤的非笔记文件（旧 _tmp 里混有 README / .htaccess）
  reservedNames: ['README'],

  // ---- 写入来源校验（CSRF）----
  // 反代场景若浏览器 Origin 与 Host 不一致，用 ALLOWED_ORIGINS 额外放行（逗号分隔 host）
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // 置 1 后才采信 X-Forwarded-For / X-Real-IP；直连时保持关闭，避免伪造 IP 绕过限流
  trustProxy: process.env.TRUST_PROXY === '1',

  // ---- 写入限流（每 IP 滑动窗口）----
  rateLimit: {
    windowMs: Number(process.env.RATE_WINDOW_MS) || 60 * 1000,
    maxWrites: Number(process.env.RATE_MAX_WRITES) || 30,
    maxNewNotes: Number(process.env.RATE_MAX_NEW_NOTES) || 10,
    // 内网健康检查等可信来源可豁免，默认不豁免任何人
    exemptIps: (process.env.RATE_EXEMPT_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // ---- 全局容量水位线（防止磁盘被刷爆）----
  quota: {
    maxTotalBytes: Number(process.env.QUOTA_MAX_BYTES) || 512 * 1024 * 1024,
    maxFiles: Number(process.env.QUOTA_MAX_FILES) || 10000,
    refreshMs: 30 * 1000,
  },
};
