# note · Node.js 版

原 PHP 版 minimalist web notepad 的等价重构，零运行时依赖（纯 `node:http` + `node:fs`）。

- **原目录零改动**：`index.php`、根目录的 `script.js` / `styles.css`、`_tmp/` 的数据均保持原样，本项目只读引用。
- **页面结构零删改**：HTML 模板与原 `index.php` 逐字一致，仅允许三处安全重构差异（静态资源版本号、复制按钮由内联 `onclick` 改为外部绑定、新增 DOMPurify 脚本行）；URL 结构与 `POST text=` 保存协议完全兼容。
- **前端增强只作用于副本**：`public/` 内的 `script.js` / `styles.css` 增加了输入防抖、错误气泡与 Markdown 净化，不回写原目录。
- **数据隔离**：笔记默认写在 `new/data/`，不会写入上级 `_tmp/`。

## 快速开始

环境要求：Node.js >= 20（实测 v22.22.2）。无需 `npm install`。

```bash
cd new
npm start
```

打开 `http://localhost:3000`，会自动跳转到随机笔记页。

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务 |
| `npm run dev` | `node --watch` 开发模式，改代码自动重启 |
| `npm test` | 端到端 + 前端行为 + 净化实证回归（真实起服务发 HTTP 请求，79 项断言） |
| `npm run check` | 全量语法检查（含 `limits.js` 与 `public/script.js`） |
| `npm run import` | 从上级 `_tmp/` 只读导入旧笔记到 `data/` |

## 目录结构

```
new/
├── server.js                  HTTP 服务、路由、HTML 模板、安全响应头
├── store.js                   存储抽象层（唯一接触 fs 的文件）
├── limits.js                  来源校验 / 写入限流 / 容量水位线
├── config.js                  端口 / 路径 / 限制 / 资源版本号 / 安全参数
├── package.json
├── README.md                  本文档
├── public/                    styles.css、script.js、favicon.*、robots.txt
├── data/                      笔记数据（运行时自动创建）
└── scripts/
    ├── import-notes.js        旧数据导入
    └── smoke-test.js          端到端 + 前端行为 + 净化实证测试
```

## 请求与 PHP 版对照

| 请求 | 行为 | 原实现位置 |
| --- | --- | --- |
| `GET /` | 302 到随机 5 字符 ID | `index.php:16-21` |
| `GET /:note` | 返回完整 HTML 页面 | `index.php:47-121` |
| `GET /:note?raw`、curl / wget UA | `text/plain` 原文；不存在返回 404 | `index.php:38-46` |
| `POST /:note` + `text=...` | 覆盖写；空内容删文件；**先过来源 / 限流 / 配额校验** | `index.php:25-35` |
| `GET /styles.css` 等 5 个静态路径 | 白名单静态资源 | 原先由 Apache 直接提供 |

所有响应保留原版的 `Cache-Control: no-store` 等禁用缓存头，并追加 CSP 等安全响应头。`server.js` 顶部注释逐行标注了行为对照。

## 写入限制

| 限制项 | 当前值 | 超出时 |
| --- | --- | --- |
| 单次请求 body | **1 MiB**（1,048,576 字节） | `413`，且**不落盘**；前端弹错误气泡 |
| 笔记名 | `^[a-zA-Z0-9_-]{1,64}$`，1–64 字符 | 302 重定向到随机 ID |
| 写入来源 | 同源 / 无 Origin（curl） | `403`，跨站表单无法覆盖或清空笔记 |
| 每 IP 写入频率 | 60 秒内 30 次；其中新建笔记 10 次 | `429` + `Retry-After`，不落盘 |
| 全局容量 | 512 MiB / 10,000 篇 | `507`，拒绝新增写入 |
| 并发 | 同一笔记的写操作串行化；不同笔记并行 | — |
| 请求方法 | 仅 `GET` / `HEAD` / `POST` | `405` |

### 关于 1 MiB 怎么算

限制的是**整个 `application/x-www-form-urlencoded` 请求体的字节数**，不是纯文本字数。请求体形如 `text=` + `encodeURIComponent(内容)`，前缀占 5 字节，URL 编码会膨胀：

| 内容类型 | 编码后占用 | 约可写入 |
| --- | --- | --- |
| ASCII 字母数字 | 1 字节/字 | 1,048,571 字符 |
| 中文汉字 | 9 字节/字（`%E4%B8%AD`） | 116,507 汉字 |
| 空格、换行、标点、`&`、`%` 等 | 3 字节/字 | 相应下降 |

边界实测：恰好等于上限 → `200`；超出 1 字节 → `413`；被拒绝的写入不会创建文件。
需要调整时改 `config.js` 的 `maxBodyBytes`（放大前先评估内存与磁盘）。

### 写入语义

- **后写覆盖前写**（last write wins），无版本历史、无乐观锁，多人同时编辑同一 URL 会互相覆盖。
- `text=` 为空字符串 → 删除该笔记文件；请求里**没有** `text` 字段 → 不做任何写入。
- **原子写**：先写同目录临时文件，再 `rename` 覆盖，进程崩溃不会留下半截内容，失败时清理 `.tmp`。
- **大小写**：默认不归一化，Linux 上 `/Abc` 与 `/abc` 是两篇；设 `LOWERCASE_IDS=1` 可归一（会改变 URL 语义，需自行评估旧链接）。
- 内容是原始 UTF-8 文本，无包装、无元数据；文件 mtime 天然支持「按最后编辑时间清理」。

### 仍然没有的限制（重要）

- **无用户体系、无鉴权**：知道笔记名即可读写，笔记名是唯一的「密钥」。限流只挡高频刷写，不挡低频的定向覆盖。
- **无内容过滤**：不要用它传递密码等敏感信息（与原版 README 的免责声明一致）。
- **无备份、无回收站**：空内容即 `unlink`，不可恢复。
- **无跨进程协调**：写队列、限流计数、容量缓存都只在单进程内生效，PM2 cluster 多 worker 需要外部存储或换引擎。

## 前端交互：净化、防抖与错误提示

改动集中在 `public/script.js` 与 `public/styles.css`，原目录同名文件不动。

### Markdown 净化（防存储型 XSS）

Showdown 按「可信输入」模型工作，**原样透传原始 HTML**。本项目笔记是公开可写的，`render()` 若直接 `innerHTML = converter.makeHtml(value)` 会形成存储型 XSS。现在：

- `converter.makeHtml()` 的输出先经 `DOMPurify.sanitize(html, PURIFY_CONFIG)` 再写入 DOM；`copy()` 复制渲染后 HTML 的路径同样净化。
- `PURIFY_CONFIG` 保留 `target` / `rel`，`hardenLinks()` 给手写原始 HTML 的 `a[target=_blank]` 补 `rel="noopener noreferrer"`。
- **fail-closed**：DOMPurify 未加载（CDN 故障 / 被拦截）时降级为 `textContent` 纯文本，绝不注入未净化的 HTML。
- 实测验证：`<img src=x onerror=...>` 与 `<script>` 被清除，标题、表格、任务列表复选框、外链 `rel` 全部保留。

模板中 `onclick="copy()"` 改为 `id="copyBtn"` + `addEventListener`，因为严格 CSP 禁止内联事件处理器——复制按钮功能不变。

### 输入防抖

- `input` 事件仍**即时渲染预览**（不加延迟，保持原有体验）。
- 保存走统一的 `debounce(uploadContent, 500)`：连续输入只在最后一次输入 500ms 后发一次请求。
- **单飞请求**：同一时刻只允许一个保存请求在飞；回包时若用户又输入了新内容，由 `scheduleSave()` 补发一次，避免并发、乱序与请求堆积。
- 回包时若内容已变则跳过 `convert()`，避免把预览回退到旧内容。
- 失败时不推进 `content` 快照，1 秒后重试（沿用原 `onerror` 节奏），不会把失败误判为已保存。

### 网络错误气泡

页面唯一的业务网络请求是保存（`POST` 当前 URL），所有失败路径都会弹气泡：

| 失败路径 | 气泡文案 |
| --- | --- |
| HTTP 非 2xx（如 `403` / `413` / `429` / `507` / `500`） | 服务器返回 HTTP xxx |
| 网络中断 / DNS 失败（`error`） | 网络异常，请检查连接 |
| 请求超时（10s，`timeout`） | 请求超时 |
| 请求被中断（`abort`） | 请求已中断 |

- 复用现有 `.message-alert` 的定位、形状与过渡，动态创建 `.message-danger` 节点；带 `role="alert"` 与 `aria-live="assertive"`，深色模式有独立配色。
- **3 秒自动消失**；连续报错复用同一个气泡并重新计时，不叠加提示。
- 与「已复制」成功气泡互不干扰（两者是独立节点）。

可调参数都在 `public/script.js` 顶部：`SAVE_DEBOUNCE_MS`(500) / `TOAST_DURATION_MS`(3000) / `SAVE_RETRY_MS`(1000) / `REQUEST_TIMEOUT_MS`(10000)。

## P0 安全加固

`limits.js` 与 `server.js` 的三层写入防护，按请求顺序执行：

| 层 | 机制 | 关键实现 |
| --- | --- | --- |
| 1 | 来源校验 | `Sec-Fetch-Site` 只接受 `same-origin` / `none`；否则校验 `Origin` 的 host 与 `Host` 一致（或命中 `ALLOWED_ORIGINS`）。**无 Origin 的 curl / wget 放行**，保持原有用法 |
| 2 | 每 IP 滑动窗口 | 60s 内 30 次写入、10 次新建；超限返回 `429` + `Retry-After`。IP 取自 `socket.remoteAddress`，仅在 `TRUST_PROXY=1` 时采信 `X-Forwarded-For` |
| 3 | 全局容量水位线 | `store.usage()` 统计文件数与总字节，缓存 30s，写成功后增量更新；超限返回 `507`。被拒绝的尝试同样计入限流窗口 |

响应头（`server.js` 的 `securityHeaders()`，对所有响应生效）：

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self';
  form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
```

`Referrer-Policy: no-referrer` 对本项目尤其重要——**笔记 URL 本身就是访问凭证**，不能通过 Referer 泄漏给外链。`style-src` 保留 `unsafe-inline` 是为了不破坏分屏拖拽用的 CSS 变量与笔记内联样式；`script-src` 严格不放开内联脚本，这才是 XSS 的主防线。

## 配置

全部通过环境变量覆盖，见 `config.js`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | 监听地址与端口 |
| `DATA_DIR` | `new/data` | 笔记数据目录 |
| `STATIC_DIR` | `new/public` | 静态资源目录 |
| `LOWERCASE_IDS` | 关闭 | 设为 `1` 开启笔记名小写归一 |
| `ALLOWED_ORIGINS` | 空 | 反代场景额外放行的 Origin host，逗号分隔 |
| `TRUST_PROXY` | 关闭 | 设为 `1` 才采信 `X-Forwarded-For` / `X-Real-IP` |
| `RATE_WINDOW_MS` | `60000` | 限流窗口长度 |
| `RATE_MAX_WRITES` | `30` | 每 IP 窗口内最大写入次数 |
| `RATE_MAX_NEW_NOTES` | `10` | 每 IP 窗口内最大新建笔记数 |
| `RATE_EXEMPT_IPS` | 空 | 豁免限流的 IP，逗号分隔（内网健康检查等） |
| `QUOTA_MAX_BYTES` | 512 MiB | 数据目录总字节上限 |
| `QUOTA_MAX_FILES` | `10000` | 笔记文件数上限 |

示例：

```bash
PORT=8080 npm start
TRUST_PROXY=1 ALLOWED_ORIGINS=note.example.com npm start  # Nginx 反代后
DATA_DIR=/var/lib/note npm start                          # 数据放到独立路径
```

> 反代部署**必须**开 `TRUST_PROXY=1`，否则所有请求的 `remoteAddress` 都是代理 IP，限流会把全部用户算成同一个来源。同时确保代理会覆盖（而非拼接）客户端传入的 `X-Forwarded-For`，否则可伪造绕过限流。
>
> `STATIC_DIR=..` 会指向**未增强**的原版前端，失去净化、防抖与错误气泡，不建议用于生产。

## 数据存储

采用「一 note 一文件」：`data/<笔记名>` 的内容就是笔记正文。选它而不是 SQLite 的原因：数据模型是纯 KV（URL 名 → 整段文本），无关联查询、无元数据、无事务需求，现有 102 篇 / 587 KB 的体量下文件系统更直接，且旧数据零迁移。

读写统一收敛到 `store.js` 的 `get / put / remove / list / stat / usage`，业务代码不接触 `fs`。将来若需要全文搜索、历史版本、访问密码或多实例事务，只需替换 `store.js` 的实现（例如换成 SQLite 表 `notes(id, content, updated_at)`），`server.js` 不用改。

旧数据导入：

```bash
npm run import
```

源目录 `_tmp/` 全程只读，目标已存在的文件不覆盖；实测导入 101 篇，按规则跳过 `.htaccess` 与 `README` 两项。

## 安全说明

| 已加固 | 说明 |
| --- | --- |
| 服务端 HTML 转义 | 对齐 `htmlspecialchars(..., ENT_QUOTES, 'UTF-8')`，textarea 与 title 均转义 |
| Markdown 净化 | DOMPurify + 严格 CSP，防公开笔记的存储型 XSS；CDN 故障 fail-closed |
| 路径校验 | 正则白名单 + `path.resolve` 目录越界双重检查 |
| 静态白名单 | 只有 5 个静态路径可访问，数据目录无法 HTTP 直读（不再依赖 `.htaccess`） |
| 写入来源校验 | 拒绝跨站表单覆盖 / 清空笔记，兼容 curl |
| 限流与配额 | 每 IP 滑动窗口 + 全局容量水位线，防刷爆磁盘 |
| body 上限 | 防止单条笔记打爆内存 |
| 原子写 | 避免半截内容与临时文件残留 |
| 安全响应头 | CSP / nosniff / no-referrer / DENY，防注入、嗅探、凭证外泄与点击劫持 |
| 错误提示 | 只展示概括性文案，不暴露服务端堆栈 |

未做（属于后续 P1/P2）：CDN 脚本 SRI、慢速请求体超时、访问日志、HTTPS 终止（交给反向代理）、访问令牌与软删除备份、多实例写协调。

## 部署提示

- PHP 版由 Apache 提供 80/443，Node 版默认 3000，前面挂 Nginx 反代或改 `PORT`；反代记得配 `TRUST_PROXY=1`。
- 建议 PM2 **fork 单实例**运行；上 cluster 前需先解决跨进程写协调与限流状态共享。
- `public/` 已含增强后的前端：改了这里的 `styles.css` / `script.js` 后，记得同步递增 `config.js` 的 `assetVersion`（当前 `20261112a`），避免浏览器缓存旧文件。
- 升级 DOMPurify 时同步改 `config.js` 的 `dompurifyVersion` 与模板引用，并跑一次 `npm test`。
- 备份即打包 `data/` 目录。

## 验证

```bash
npm run check
npm test
```

`npm test` 会真实启动 `server.js`（使用系统临时目录作为 `DATA_DIR`，结束自动清理），覆盖：302 随机 ID、静态资源、页面结构、中文读写、HTML 转义、curl UA、空内容删除、路径穿越、非法 ID、1 MiB body 上下边界、并发写、数据隔离，以及 P0 三项（CSP 与安全响应头、跨站 `403` / 同源与 curl 兼容、限流 `429` 与水位线 `507`）。

其中三项关键校验：

- 把 `renderPage()` 输出与原 `index.php` 模板**逐字比对**：PHP 片段、资源版本号、内联事件改外部绑定、新增净化库脚本行做归一化，其余任何结构、属性或节点被删改都会失败。
- 在隔离环境 + 受控时钟里**真实执行**前端 `debounce()` 与 `showNetworkError()`，验证连续 5 次输入只触发 1 次保存、气泡 3s 自动消失、连续报错复用同一节点并重新计时。
- 在 jsdom 里**真实加载 showdown + DOMPurify** 跑净化实证，确认 `onerror` / `<script>` 被清除，而标题、表格、任务列表、外链 `rel` 保留。环境无 jsdom 或 CDN 不可达时自动跳过，不引入项目依赖、不影响离线回归。
