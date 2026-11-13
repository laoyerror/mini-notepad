'use strict';

/**
 * Node.js 版 minimalist web notepad（原 index.php 的等价实现，零运行时依赖）。
 *
 * 行为对照：
 *   index.php:11-13  -> noCache()
 *   index.php:16-21  -> 缺失 / 非法 note 名 -> 302 到随机 5 字符
 *   index.php:23     -> store 的 dataDir + noteId
 *   index.php:25-35  -> POST text= 覆盖写；空内容删文件
 *   index.php:38-46  -> ?raw / curl / wget -> text/plain，不存在则 404
 *   index.php:47-121 -> renderPage()，HTML 结构逐字保留
 *
 * 前端 script.js / styles.css 一行未改，URL 结构与表单字段保持不变：
 * 保存仍是 POST 当前 URL 的 application/x-www-form-urlencoded text= 字段。
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const limits = require('./limits');

// 静态资源白名单：只有这 5 个文件可通过 HTTP 访问。
// 数据目录不在其中，因此无需再依赖 _tmp/.htaccess 来防直读。
const STATIC_ASSETS = new Map([
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/script.js', { file: 'script.js', type: 'application/javascript; charset=utf-8' }],
  ['/favicon.ico', { file: 'favicon.ico', type: 'image/x-icon' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/robots.txt', { file: 'robots.txt', type: 'text/plain; charset=utf-8' }],
]);

function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

// 纵深防御：CSP 兜住 Markdown 渲染阶段可能漏过的注入，同时防点击劫持与凭证外泄
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

// 对应 index.php:56 / 73 / 98 的 htmlspecialchars(..., ENT_QUOTES, 'UTF-8')
function escapeHtml(value) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(value).replace(/[&<>"']/g, (ch) => map[ch]);
}

// 对应 index.php:19 的 substr(str_shuffle($alphabet), -5)
function randomId() {
  const chars = config.idAlphabet;
  const used = new Set();
  let out = '';
  while (out.length < config.idLength) {
    const ch = chars[crypto.randomInt(0, chars.length)];
    if (used.has(ch)) continue;
    used.add(ch);
    out += ch;
  }
  return out;
}

function redirectToRandom(res) {
  res.writeHead(302, { Location: '/' + randomId() });
  res.end();
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

async function serveStatic(res, entry) {
  try {
    const data = await fs.readFile(path.join(config.staticDir, entry.file));
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return notFound(res);
    throw err;
  }
}

// 保留 isset($_POST['text']) 的语义：没有该字段时不做任何写入
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      continue; // 继续排空请求流，保证能正常回 413
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) {
    const err = new Error('payload too large');
    err.code = 'BODY_TOO_LARGE';
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRawRequest(url, req) {
  if (url.searchParams.has('raw')) return true;
  const ua = req.headers['user-agent'] || '';
  return ua.startsWith('curl') || ua.startsWith('Wget');
}

function renderPage(noteId, text) {
  const name = escapeHtml(noteId);
  const v = config.assetVersion;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="robots" content="noindex, nofollow">
    <meta name="color-scheme" content="light dark">
    <meta name="theme-color" content="#f6f5f4" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#1e201f" media="(prefers-color-scheme: dark)">
    <title>${name}</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/styles.css?v=${v}">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/showdown/2.1.0/showdown.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/${config.dompurifyVersion}/purify.min.js"></script>
</head>
<body data-view="preview">
    <div class="app">
        <header class="menu topbar">
            <div class="brand">
                <svg class="brand-mark" viewBox="0 0 20 20" aria-hidden="true">
                    <rect x="2.5" y="2.5" width="15" height="15" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
                    <path class="accent-line" d="M6 7.5h8" stroke-width="2" stroke-linecap="round"/>
                    <path d="M6 11h8M6 14h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/>
                </svg>
                <span class="brand-word">note</span>
                <span class="brand-slash" aria-hidden="true">/</span>
                <span class="note-name" title="${name}">${name}</span>
            </div>

            <div class="view-switch" role="group" aria-label="视图模式">
                <button type="button" class="view-btn" data-view="edit" aria-pressed="false" title="仅编辑（Alt + 1）">编辑</button>
                <button type="button" class="view-btn" data-view="split" aria-pressed="false" title="一半编辑一半预览（Alt + 2）">分屏</button>
                <button type="button" class="view-btn" data-view="preview" aria-pressed="true" title="仅预览（Alt + 3）">预览</button>
            </div>

            <div class="actions">
                <button type="button" class="btn color2" id="copyBtn" aria-label="复制当前内容">复制</button>
                <div class="message-alert message-success" role="status" aria-live="polite">
                    <strong>已复制</strong><span>内容已在剪贴板</span>
                </div>
            </div>
        </header>

        <main class="container">
            <section class="pane pane-editor" aria-label="编辑区">
                <div class="pane-head">
                    <span class="pane-tag">编辑</span>
                    <span class="pane-meta" id="countMeta">0 字</span>
                </div>
                <textarea id="content" spellcheck="false" aria-label="Markdown 内容" placeholder="写下 Markdown，预览会即时渲染…">${escapeHtml(text)}</textarea>
            </section>

            <div class="divider" id="divider" role="separator" tabindex="0"
                 aria-label="调整分屏比例，方向键微调，Home 复位" aria-orientation="vertical"
                 aria-valuemin="25" aria-valuemax="75" aria-valuenow="50"></div>

            <section class="pane pane-preview" aria-label="预览区">
                <div class="pane-head">
                    <span class="pane-tag">预览</span>
                    <span class="pane-meta">Markdown</span>
                </div>
                <nav class="toc" id="toc" aria-label="标题导航" hidden></nav>
                <article class="markdown" aria-live="off"></article>
            </section>
        </main>
    </div>

    <pre id="printable"></pre>
    <script src="/script.js?v=${v}"></script>
</body>
</html>`;
}

async function handle(req, res) {
  noCache(res);
  securityHeaders(res);

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return notFound(res);
  }
  const pathname = url.pathname;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && STATIC_ASSETS.has(pathname)) {
    return serveStatic(res, STATIC_ASSETS.get(pathname));
  }

  // 对应 index.php:16-21，POST / 或非法 note 名同样重定向
  let noteId;
  try {
    noteId = decodeURIComponent(pathname.replace(/^\//, ''));
  } catch {
    return redirectToRandom(res);
  }
  if (!config.noteIdPattern.test(noteId)) return redirectToRandom(res);
  const id = config.lowercaseIds ? noteId.toLowerCase() : noteId;

  if (req.method === 'POST') {
    // 1) 来源校验：跨域表单无法静默覆盖 / 清空笔记
    if (!limits.isTrustedWrite(req)) {
      req.resume(); // 排空未读的请求体，避免连接被复用时残留数据
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Cross-origin write rejected');
      return;
    }

    try {
      const body = await readBody(req, config.maxBodyBytes);
      const params = new URLSearchParams(body);
      if (!params.has('text')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('');
        return;
      }

      const text = params.get('text');
      const ip = limits.clientIp(req);
      const before = await store.stat(id);
      const isDelete = text.length === 0;
      const isNew = !before && !isDelete;
      const byteDelta = Buffer.byteLength(text, 'utf8') - (before ? before.size : 0);

      // 2) 每 IP 滑动窗口 + 全局容量水位线
      const limited = limits.checkWrite(ip, isNew);
      if (limited) {
        res.writeHead(limited.status, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': String(limited.retryAfter),
        });
        res.end(limited.reason);
        return;
      }
      const quota = await limits.checkQuota(byteDelta, isNew);
      // 被水位线拒绝的尝试同样计入窗口，避免反复试探
      limits.recordWrite(ip, isNew);
      if (quota) {
        res.writeHead(quota.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(quota.reason);
        return;
      }

      await store.put(id, text);
      limits.adjustUsage(byteDelta, isDelete ? (before ? -1 : 0) : (isNew ? 1 : 0));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('');
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Payload Too Large');
        return;
      }
      throw err;
    }
    return;
  }

  if (!isRead) {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    res.end();
    return;
  }

  const text = await store.get(id);

  // 对应 index.php:38-46
  if (isRawRequest(url, req)) {
    if (text === null) return notFound(res);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPage(id, text === null ? '' : text));
}

async function main() {
  await fs.mkdir(config.dataDir, { recursive: true });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[request error]', err);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`note (Node.js) listening on http://${config.host}:${config.port}`);
    console.log(`data   : ${config.dataDir}`);
    console.log(`static : ${config.staticDir}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

// 供测试脚本直接引入做模板比对；被 require 时不会自动监听端口
module.exports = { handle, renderPage, randomId, escapeHtml };
