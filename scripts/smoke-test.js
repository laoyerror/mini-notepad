'use strict';

/**
 * 端到端冒烟测试：真实启动 server.js，走真实 HTTP 请求。
 * 数据目录使用系统临时目录，测试结束自动清理，不影响 new/data 或上级 _tmp。
 * 运行：npm test
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../config');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3317;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;

function assert(ok, label, detail) {
  if (!ok) throw new Error(`FAIL: ${label}${detail ? ' -> ' + detail : ''}`);
  passed++;
  console.log(`  ok   ${label}`);
}

function formData(text, extraHeaders) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(extraHeaders || {}),
    },
    body: 'text=' + encodeURIComponent(text),
    redirect: 'manual',
  };
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE + '/', { redirect: 'manual' });
      if (res.status === 302) return;
    } catch {
      // 服务尚未监听
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start listening');
}

async function run(dataDir) {
  const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };

  // 1. 根路径重定向到 5 字符随机 ID
  let res = await fetch(BASE + '/', { redirect: 'manual' });
  assert(res.status === 302, 'GET / 返回 302');
  const location = res.headers.get('location') || '';
  assert(/^\/[a-z0-9]{5}$/.test(location), '随机 ID 为 5 位无歧义字符', location);

  // 2. 静态资源白名单，并确认前端新增能力已随资源下发
  res = await fetch(BASE + '/styles.css?v=' + config.assetVersion);
  const clientCss = await res.text();
  assert(res.status === 200 && clientCss.length > 10000, 'styles.css 完整返回');
  assert(clientCss.includes('.message-alert.message-danger'), '错误气泡样式已下发');

  res = await fetch(BASE + '/script.js?v=' + config.assetVersion);
  const clientJs = await res.text();
  assert(res.status === 200 && clientJs.includes('uploadContent'), 'script.js 可访问');
  assert(clientJs.includes('showNetworkError') && clientJs.includes('TOAST_DURATION_MS = 3000'), '错误气泡 3s 逻辑已下发');
  assert(clientJs.includes('function debounce') && clientJs.includes('scheduleSave()'), '输入防抖已下发');
  res = await fetch(BASE + '/favicon.ico');
  assert(res.status === 200, 'favicon.ico 可访问');
  res = await fetch(BASE + '/robots.txt');
  assert(res.status === 200, 'robots.txt 可访问');

  // 3. 新笔记页面结构
  res = await fetch(BASE + '/smoke1');
  const html = await res.text();
  assert(res.status === 200 && res.headers.get('content-type').includes('text/html'), 'GET /smoke1 返回 HTML');
  assert(html.includes('<title>smoke1</title>'), 'title 注入正确');
  assert(html.includes('data-view="preview"'), '默认视图保留');
  assert(html.includes('id="divider"') && html.includes('id="toc"'), '分屏与目录节点保留');
  assert(html.includes('/script.js?v=' + config.assetVersion), '前端引用路径与版本号正确');
  assert(res.headers.get('cache-control').includes('no-store'), '禁用缓存头保留');

  // 3b. P0：CSP / 安全响应头 / 净化链路接线
  const csp = res.headers.get('content-security-policy') || '';
  assert(csp.includes("script-src 'self' https://cdnjs.cloudflare.com"), 'CSP 限定脚本来源');
  assert(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src 未放开内联脚本');
  assert(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), 'CSP 防点击劫持与对象注入');
  assert(res.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options 生效');
  assert(res.headers.get('referrer-policy') === 'no-referrer', 'Referrer-Policy 保护笔记 URL');
  assert(html.includes('dompurify/' + config.dompurifyVersion + '/purify.min.js'), 'DOMPurify 已引入');
  assert(!html.includes('onclick='), '页面无内联事件处理器');
  assert(html.includes('id="copyBtn"'), '复制按钮改为 id 绑定');
  assert(clientJs.includes('DOMPurify.sanitize') && clientJs.includes('sanitizeHtml('), 'Markdown 渲染前净化已接线');
  assert(clientJs.includes('addEventListener("click", copy)'), '复制按钮外部绑定已接线');

  // 4. 不存在的笔记：raw 返回 404，页面仍可打开
  res = await fetch(BASE + '/smoke1?raw');
  assert(res.status === 404, '未创建时 raw 返回 404');

  // 5. 保存 + 读回（含中文与特殊字符）
  const payload = '中文笔记 # 标题\n第二行 & <tag> "引号"';
  res = await fetch(BASE + '/smoke1', formData(payload));
  assert(res.status === 200, 'POST text= 保存成功');
  res = await fetch(BASE + '/smoke1?raw');
  assert((await res.text()) === payload, 'raw 读回内容完全一致');

  // 6. HTML 转义（对齐 htmlspecialchars）
  const html2 = await (await fetch(BASE + '/smoke1')).text();
  assert(html2.includes('&lt;tag&gt;') && !html2.includes('<tag>'), 'textarea 内尖括号已转义');
  const xss = '</textarea><script>alert(1)</script>';
  await fetch(BASE + '/smoke1', formData(xss));
  const html3 = await (await fetch(BASE + '/smoke1')).text();
  assert(!html3.includes('<script>alert(1)</script>'), 'XSS 载荷被转义');

  // 7. curl / wget UA 自动返回纯文本
  res = await fetch(BASE + '/smoke1', { headers: { 'User-Agent': 'curl/8.21.0' } });
  assert(res.headers.get('content-type').includes('text/plain') && (await res.text()) === xss, 'curl UA 自动 raw');

  // 8. 缺少 text 参数时不写入（对齐 isset($_POST['text'])）
  res = await fetch(BASE + '/smoke1', {
    method: 'POST', headers: formHeaders, body: 'other=1', redirect: 'manual',
  });
  assert(res.status === 200, '缺少 text 字段返回 200');
  assert((await (await fetch(BASE + '/smoke1?raw')).text()) === xss, '缺少 text 字段时内容未被改动');

  // 9. 空内容删除文件
  await fetch(BASE + '/smoke1', formData(''));
  res = await fetch(BASE + '/smoke1?raw');
  assert(res.status === 404, '空内容后文件被删除');

  // 10. 非法 ID / 路径穿越一律重定向，且读不到数据目录
  for (const bad of ['/bad.name', '/' + 'a'.repeat(65), '/_tmp/README', '/..%2F_tmp%2FREADME', '/data/.gitkeep']) {
    res = await fetch(BASE + bad, { redirect: 'manual' });
    assert(res.status === 302, '非法路径被拒绝: ' + bad, String(res.status));
  }

  // 11. body 上限：限制的是整个 form-urlencoded body 的字节数，不是纯文本字符数
  res = await fetch(BASE + '/big', formData('x'.repeat(3 * 1024 * 1024)));
  assert(res.status === 413, '超过上限返回 413');
  res = await fetch(BASE + '/big?raw');
  assert(res.status === 404, '被拒绝的写入不落盘');

  const prefixLen = 'text='.length;
  res = await fetch(BASE + '/exact', formData('x'.repeat(config.maxBodyBytes - prefixLen)));
  assert(res.status === 200, '恰好等于上限允许写入');
  await fetch(BASE + '/exact', formData(''));
  res = await fetch(BASE + '/over', formData('x'.repeat(config.maxBodyBytes - prefixLen + 1)));
  assert(res.status === 413, '超出上限 1 字节即拒绝');

  // 12. 并发写串行化 + 无临时文件残留
  const values = Array.from({ length: 10 }, (_, i) => `并发写入 #${i} ` + 'x'.repeat(2000));
  await Promise.all(values.map((v) => fetch(BASE + '/concurrent', formData(v))));
  const finalText = await (await fetch(BASE + '/concurrent?raw')).text();
  assert(values.includes(finalText), '并发写后内容仍是某次完整写入');
  const names = await fs.readdir(dataDir);
  assert(!names.some((n) => n.endsWith('.tmp')), '无 .tmp 残留文件');
  assert(names.includes('concurrent'), '数据落在独立 DATA_DIR');

  // 13. 数据目录隔离：上级 _tmp 未被写入
  const legacy = path.join(ROOT, '..', '_tmp');
  const legacyNames = await fs.readdir(legacy);
  assert(!legacyNames.includes('smoke1') && !legacyNames.includes('concurrent'), '原 _tmp 未被触碰');

  // 14. P0：跨站写入被拒绝，同源 / curl 保持兼容
  const originHost = '127.0.0.1:' + PORT;
  res = await fetch(BASE + '/csrf', formData('safe', { Origin: 'http://' + originHost }));
  assert(res.status === 200, '同源 Origin 允许写入');
  res = await fetch(BASE + '/csrf', formData('evil', { Origin: 'https://evil.example.com' }));
  assert(res.status === 403, '跨站 Origin 被拒绝');
  assert((await (await fetch(BASE + '/csrf?raw')).text()) === 'safe', '跨站写入未改动内容');
  res = await fetch(BASE + '/csrf', formData('evil2', { 'Sec-Fetch-Site': 'cross-site' }));
  assert(res.status === 403, 'Sec-Fetch-Site cross-site 被拒绝');
  res = await fetch(BASE + '/csrf', formData('curl-save'));
  assert(res.status === 200, '无 Origin 的 curl 式写入保持兼容');
  assert((await (await fetch(BASE + '/csrf?raw')).text()) === 'curl-save', 'curl 式写入生效');

  // 15. P0：每 IP 滑动窗口限流（用 XFF 模拟独立来源，不干扰主流程）
  const xff = { 'X-Forwarded-For': '198.51.100.77' };
  for (let i = 0; i < 3; i++) {
    res = await fetch(BASE + '/rate', formData('r' + i, xff));
    assert(res.status === 200, '窗口内第 ' + (i + 1) + ' 次写入通过');
  }
  res = await fetch(BASE + '/rate', formData('blocked', xff));
  assert(res.status === 429, '超出窗口阈值返回 429');
  assert(Number(res.headers.get('retry-after')) >= 1, '429 带 Retry-After');
  assert((await (await fetch(BASE + '/rate?raw')).text()) !== 'blocked', '被限流的写入不落盘');

  // 16. P0：容量水位线（直接验证逻辑，避免污染 HTTP 测试的状态）
  await testQuota(dataDir);

  await compareTemplate();
  await testClientLogic();
  await testSanitizer();
}

// 容量水位线：在测试进程内直接驱动 limits 模块（与服务端子进程状态隔离）
async function testQuota(dataDir) {
  const limits = require('../limits');
  const saved = {
    dataDir: config.dataDir,
    maxFiles: config.quota.maxFiles,
    maxTotalBytes: config.quota.maxTotalBytes,
  };
  config.dataDir = dataDir;
  try {
    config.quota.maxFiles = 0;
    limits.reset();
    const byCount = await limits.checkQuota(0, true);
    assert(byCount && byCount.status === 507, '笔记数超水位线返回 507');

    config.quota.maxFiles = 10000;
    config.quota.maxTotalBytes = 1;
    limits.reset();
    const byBytes = await limits.checkQuota(100, false);
    assert(byBytes && byBytes.status === 507, '总字节超水位线返回 507');

    config.quota.maxTotalBytes = 512 * 1024 * 1024;
    limits.reset();
    assert((await limits.checkQuota(10, false)) === null, '正常写入不受水位线影响');
  } finally {
    config.dataDir = saved.dataDir;
    config.quota.maxFiles = saved.maxFiles;
    config.quota.maxTotalBytes = saved.maxTotalBytes;
    limits.reset();
  }
}

// 在隔离环境 + 受控时钟里真实执行前端的防抖与错误气泡逻辑，
// 不依赖浏览器，也不需要引入 jsdom 等依赖。
async function testClientLogic() {
  const src = await fs.readFile(path.join(ROOT, 'public', 'script.js'), 'utf8');
  const start = src.indexOf('var SAVE_DEBOUNCE_MS');
  const end = src.indexOf('function uploadContent()');
  assert(start > 0 && end > start, '可提取前端保存逻辑片段');

  let now = 0;
  let seq = 0;
  const jobs = new Map();
  const created = [];

  function makeEl(tag) {
    const classes = new Set();
    return {
      tag,
      className: '',
      attrs: {},
      children: [],
      textContent: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); return c; },
      querySelector(sel) { return this.children.find((c) => c.tag === sel) || null; },
    };
  }

  const sandbox = {
    document: {
      createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
      querySelector() { return makeEl('div'); },
      body: makeEl('body'),
    },
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
  };

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      jobs.delete(due[0]);
      due[1].fn();
    }
    now = target;
  }

  const probe = `
    var __hits = 0;
    var __d = debounce(function () { __hits++; }, 500);
    globalThis.__api = {
      d: __d,
      hits: function () { return __hits; },
      error: showNetworkError,
      toastMs: TOAST_DURATION_MS
    };
  `;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end) + probe, ctx);
  const api = sandbox.__api;

  assert(api.toastMs === 3000, '气泡自动消失时长为 3000ms');

  // 防抖：连续 5 次输入只触发 1 次，且发生在最后一次输入 500ms 之后
  for (let i = 0; i < 5; i++) { api.d(); advance(100); }
  assert(api.hits() === 0, '频繁输入期间不触发保存');
  advance(500);
  assert(api.hits() === 1, '停止输入后只触发 1 次保存');

  // 气泡：动态创建、显示错误详情、3s 自动消失、连续报错重新计时
  api.error('网络异常，请检查连接');
  const toast = created.find((el) => el.className.includes('message-danger'));
  assert(!!toast, '动态创建错误气泡节点');
  assert(toast.classList.contains('is-visible'), '气泡已显示');
  assert(toast.children[0].textContent === '保存失败', '气泡标题正确');
  assert(toast.children[1].textContent === '网络异常，请检查连接', '气泡展示错误详情');
  assert(toast.attrs.role === 'alert', '气泡具备无障碍告警语义');

  advance(2000);
  api.error('请求超时');
  assert(created.filter((el) => el.className.includes('message-danger')).length === 1, '连续报错复用同一气泡');
  assert(toast.children[1].textContent === '请求超时', '气泡文案已更新');
  advance(2000);
  assert(toast.classList.contains('is-visible'), '重新计时期间气泡仍显示');
  advance(1000);
  assert(!toast.classList.contains('is-visible'), '3s 后气泡自动消失');
}

// 真实净化实证：在 jsdom 里加载 showdown + DOMPurify，验证恶意载荷被清除、
// 且标题 / 表格 / 任务列表 / 外链 rel 等原有能力不丢失。
// 环境缺 jsdom 或 CDN 不可达时跳过，不引入项目依赖，也不影响离线回归。
async function testSanitizer() {
  let JSDOM;
  try {
    JSDOM = require('jsdom').JSDOM;
  } catch {
    console.log('  skip 净化实证（环境无 jsdom）');
    return;
  }

  let showdownSrc;
  let purifySrc;
  try {
    [showdownSrc, purifySrc] = await Promise.all([
      fetch('https://cdnjs.cloudflare.com/ajax/libs/showdown/2.1.0/showdown.min.js').then((r) => r.text()),
      fetch('https://cdnjs.cloudflare.com/ajax/libs/dompurify/' + config.dompurifyVersion + '/purify.min.js').then((r) => r.text()),
    ]);
  } catch {
    console.log('  skip 净化实证（CDN 不可达）');
    return;
  }

  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(showdownSrc);
  dom.window.eval(purifySrc);

  const src = await fs.readFile(path.join(ROOT, 'public', 'script.js'), 'utf8');
  const cfg = src.slice(src.indexOf('var PURIFY_CONFIG'), src.indexOf('function sanitizeHtml'));
  const probe = `
    (function () {
      var c = new showdown.Converter({ tables:true, openLinksInNewWindow:true, emoji:true,
        noHeaderId:true, simplifiedAutoLink:true, strikethrough:true, tasklists:true });
      c.setFlavor('github');
      var md = ['# 标题','<img src=x onerror=alert(1)>','<script>alert(2)</script>',
        '[外链](https://example.com)','','| A | B |','|---|---|','| 1 | 2 |','',
        '- [x] 已完成任务'].join('\\n');
      var clean = DOMPurify.sanitize(c.makeHtml(md), PURIFY_CONFIG);
      var box = document.createElement('div'); box.innerHTML = clean;
      var link = box.querySelector('a[target=_blank]');
      globalThis.__probe = {
        onerror: /onerror/i.test(clean),
        script: /<script/i.test(clean),
        h1: !!box.querySelector('h1'),
        table: !!box.querySelector('table'),
        checkbox: !!box.querySelector('input[type=checkbox]'),
        rel: link ? link.getAttribute('rel') : null
      };
    })()
  `;
  dom.window.eval(cfg + probe);
  const r = dom.window.__probe;

  assert(!r.onerror && !r.script, 'DOMPurify 清除 onerror 与 script');
  assert(r.h1 && r.table && r.checkbox, '净化后标题 / 表格 / 任务列表保留');
  assert(r.rel === 'noopener noreferrer', '净化后外链 rel 保留');
}

// 把 index.php 里的 PHP 片段替换成占位符，与 renderPage 的输出逐字比对：
// 任何结构、属性、className、aria 或按钮被删改，这里都会失败。
// 唯一例外是静态资源版本号（?v=...），前端有改动时允许递增。
async function compareTemplate() {
  const php = await fs.readFile(path.join(ROOT, '..', 'index.php'), 'utf8');
  const phpHtml = php
    .slice(php.indexOf('<!DOCTYPE html>'))
    .replace(/<\?php print \$_GET\['note'\]; \?>/g, '__NOTE__')
    .replace(/<\?php print \$base_url; \?>/g, '')
    .replace(/<\?php[\s\S]*?\?>/g, '__TEXT__')
    .trim();

  const { renderPage } = require('../server.js');
  const nodeHtml = renderPage('__NOTE__', '__TEXT__').trim();

  // 允许三类安全重构差异：资源版本号、内联事件改外部绑定、新增净化库脚本；
  // 其余任何结构、属性、className、aria 或按钮被删改，比对仍会失败。
  const normalize = (s) => s
    .replace(/\?v=[A-Za-z0-9]+/g, '?v=__V__')
    .replace(/\s+onclick="copy\(\)"/g, ' __COPY_HOOK__')
    .replace(/\s+id="copyBtn"/g, ' __COPY_HOOK__')
    .replace(/^[ \t]*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/dompurify\/[^"]+"><\/script>\r?\n/gm, '');
  const a = normalize(phpHtml);
  const b = normalize(nodeHtml);

  if (a !== b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    console.error(`首个差异 @${i}`);
    console.error('  PHP : ' + JSON.stringify(a.slice(i, i + 80)));
    console.error('  NODE: ' + JSON.stringify(b.slice(i, i + 80)));
  }
  assert(a === b, 'HTML 结构与原 index.php 逐字一致（版本号除外）');
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-smoke-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TRUST_PROXY: '1',
      RATE_MAX_WRITES: '3',
      RATE_MAX_NEW_NOTES: '2',
      // 主流程请求豁免限流，专项测试用 XFF 模拟独立 IP
      RATE_EXEMPT_IPS: '127.0.0.1,::1,::ffff:127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await waitReady();
    await run(dataDir);
    console.log(`\n全部通过：${passed} 项断言`);
  } catch (err) {
    console.error('\n' + err.message);
    if (stderr) console.error('server stderr:\n' + stderr);
    process.exitCode = 1;
  } finally {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main();
