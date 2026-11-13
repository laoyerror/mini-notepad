/*! Minimalist Web Notepad | https://github.com/pereorga/minimalist-web-notepad */
/*! 交互层：三态视图 / 即时预览 / 分屏拖拽 / 滚动同步
    数据保存：统一防抖 + 单飞请求 + 失败气泡；剪贴板、打印、showdown 配置沿用原实现 */

/* ------------------------------------------------------------
   数据保存：事件防抖 / 单飞请求 / 网络错误气泡
   ------------------------------------------------------------ */
var SAVE_DEBOUNCE_MS = 500;   // 最后一次输入后多久发起保存
var SAVE_RETRY_MS = 1000;     // 失败后的重试间隔（沿用原 onerror 节奏）
var TOAST_DURATION_MS = 3000; // 错误气泡 3 秒自动消失
var REQUEST_TIMEOUT_MS = 10000;

var inFlight = false;
var retryTimer = null;
var toastTimer = null;
var errorToast = null;

// 通用事件防抖：频繁输入时只在最后一次输入后触发一次保存
function debounce(fn, wait) {
  var timer = null;
  return function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      fn();
    }, wait);
  };
}

// 复用现有 .message-alert 气泡的定位与过渡，动态创建节点，不改动页面模板
function showNetworkError(detail) {
  if (!errorToast) {
    errorToast = document.createElement("div");
    errorToast.className = "message-alert message-danger";
    errorToast.setAttribute("role", "alert");
    errorToast.setAttribute("aria-live", "assertive");
    errorToast.appendChild(document.createElement("strong"));
    errorToast.appendChild(document.createElement("span"));
    (document.querySelector(".actions") || document.body).appendChild(errorToast);
  }
  errorToast.querySelector("strong").textContent = "保存失败";
  errorToast.querySelector("span").textContent = detail;
  errorToast.classList.add("is-visible");

  // 连续报错时复用同一个气泡并重新计时，不会叠加多个提示
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    errorToast.classList.remove("is-visible");
    toastTimer = null;
  }, TOAST_DURATION_MS);
}

function uploadContent() {
  // 同一时刻只保留一个在飞请求；回包后若内容又变了，由 scheduleSave 补发
  if (inFlight || content === textarea.value) return;

  var temp = textarea.value;
  inFlight = true;

  var request = new XMLHttpRequest();
  request.open("POST", window.location.href, true);
  request.setRequestHeader(
    "Content-Type",
    "application/x-www-form-urlencoded; charset=UTF-8"
  );
  request.timeout = REQUEST_TIMEOUT_MS;

  function settle(errorMessage) {
    inFlight = false;
    if (!errorMessage) {
      content = temp;
      if (content !== textarea.value) {
        // 保存期间又有新输入：预览已由 input 事件即时渲染，不回退到旧内容
        scheduleSave();
      } else {
        convert();
      }
      return;
    }
    showNetworkError(errorMessage);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      uploadContent();
    }, SAVE_RETRY_MS);
  }

  request.onload = function () {
    if (request.status >= 200 && request.status < 300) settle(null);
    else settle("服务器返回 HTTP " + request.status);
  };
  request.onerror = function () { settle("网络异常，请检查连接"); };
  request.ontimeout = function () { settle("请求超时"); };
  request.onabort = function () { settle("请求已中断"); };
  request.send("text=" + encodeURIComponent(temp));

  // Make the content available to print.
  printable.removeChild(printable.firstChild);
  printable.appendChild(document.createTextNode(temp));
}

var scheduleSave = debounce(uploadContent, SAVE_DEBOUNCE_MS);

var textarea = document.getElementById("content");
var printable = document.getElementById("printable");
var message = document.querySelector(".message-alert");
var content = textarea.value;
var isStatus = false; // true = 编辑/分屏，false = 纯预览（沿用 copy 的原判断语义）
var markdown = document.querySelector(".markdown");
// 原 timer 的职责由上方 debounce() 统一接管，避免多处各自维护防抖句柄

/* 滚动联动状态（提前声明，render / setView / applySplit 都会用到） */
var paneMax = [0, 0];          // 缓存两侧可滚动距离，scroll 路径不再读 scrollHeight
var measureFrame = 0;
var stackedLayout = isVertical(); // 缓存上下分屏状态，避免每次 scroll 调 matchMedia
var scrollWrites = [];        // 最近的程序化滚动写入，用来吸收跟随侧的 scroll 事件
var converter = new showdown.Converter({
  tables: true,
  openLinksInNewWindow: true,
  emoji: true,
  noHeaderId: true,
  simplifiedAutoLink: true,
  strikethrough: true,
  tasklists: true,
});
converter.setFlavor("github");

/* ------------------------------------------------------------
   Markdown 净化：showdown 保留原始 HTML，写入 innerHTML 前必须过滤
   ------------------------------------------------------------ */
var PURIFY_CONFIG = {
  ADD_ATTR: ["target", "rel"],
  USE_PROFILES: { html: true },
};

// 返回 null 表示净化库不可用；调用方必须 fail-closed，绝不注入原始 HTML
function sanitizeHtml(html) {
  if (typeof DOMPurify === "undefined") return null;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

// 手写原始 HTML 的外链不走 showdown，补上 rel 防 tabnabbing / referrer 外泄
function hardenLinks(root) {
  var links = root.querySelectorAll('a[target="_blank"]');
  for (var i = 0; i < links.length; i++) {
    if (!links[i].getAttribute("rel")) {
      links[i].setAttribute("rel", "noopener noreferrer");
    }
  }
}

/* ------------------------------------------------------------
   渲染层：输入即渲染，不等保存回包
   ------------------------------------------------------------ */
var EMPTY_HTML =
  '<div class="empty-state">' +
    '<span class="empty-mark" aria-hidden="true">#</span>' +
    '<span class="empty-title">这里还是空的</span>' +
    '<span class="empty-hint">写下 Markdown，这里会即时渲染</span>' +
  '</div>';
var countMeta = document.getElementById("countMeta");

function updateCount(value) {
  countMeta.textContent = value.length + " 字";
}

/* 表格默认铺满正文宽度（见 styles.css）；外层容器负责内容超出时的内部横向滚动。
   容器带 role / aria-label / tabindex，键盘用户也能聚焦后左右滚动查看完整表格；
   同时幂等补齐表格语义，保证任何渲染路径下可访问性都完整。 */
function setupTables(root) {
  var tables = root.querySelectorAll("table");
  for (var i = 0; i < tables.length; i++) {
    var table = tables[i];
    var parent = table.parentNode;
    if (!parent || !parent.classList || !parent.classList.contains("table-scroll")) {
      var wrap = document.createElement("div");
      wrap.className = "table-scroll";
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", "表格，可横向滚动");
      wrap.tabIndex = 0;
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    }

    if (!table.hasAttribute("role")) table.setAttribute("role", "table");
    var setRole = function (selector, role) {
      var nodes = table.querySelectorAll(selector);
      for (var j = 0; j < nodes.length; j++) {
        if (!nodes[j].hasAttribute("role")) nodes[j].setAttribute("role", role);
      }
    };
    setRole("tr", "row");
    setRole("th", "columnheader");
    setRole("td", "cell");
  }
}

/* ------------------------------------------------------------
   纯预览模式的标题导航（1 / 2 / 3 级标题）
   - 只在左侧留白足够时浮出，绝对定位不参与正文布局
   - 标题位置在 rAF 里一次性缓存，滚动时只读缓存，不触发布局
   ------------------------------------------------------------ */
var toc = document.getElementById("toc");
var tocHeadings = [];
var tocTops = [];
var tocSignature = "";
var tocActive = -1;
var tocScrollFrame = 0;

function buildToc() {
  var hs = markdown.querySelectorAll("h1, h2, h3");
  var parts = [];
  for (var i = 0; i < hs.length; i++) parts.push(hs[i].tagName + ":" + hs[i].textContent);
  var signature = parts.join("|");

  // 正文变了但标题没变时不重建 DOM，避免逐字输入时反复创建按钮
  if (signature !== tocSignature) {
    tocSignature = signature;
    tocHeadings = [];
    tocActive = -1;
    toc.textContent = "";
    if (hs.length) {
      var label = document.createElement("div");
      label.className = "toc-title";
      label.textContent = "目录";
      toc.appendChild(label);

      for (var j = 0; j < hs.length; j++) {
        (function (heading, index) {
          if (!heading.id) heading.id = "toc-h-" + index;
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "toc-item";
          btn.setAttribute("data-level", heading.tagName.charAt(1));
          btn.textContent = heading.textContent.trim() || "（无标题）";
          btn.title = btn.textContent;
          btn.addEventListener("click", function () { scrollToHeading(index); });
          toc.appendChild(btn);
          tocHeadings.push({ el: heading, btn: btn });
        })(hs[j], j);
      }
    }
  }

  // markdown.innerHTML 每次渲染都会重建所有标题节点：目录按钮可以复用，
  // 但 tocHeadings 里缓存的 el 会变成脱离文档的旧节点，导致跳转位置算错。
  // 无论目录 DOM 是否重建，都把引用重新指向本次渲染的标题节点。
  for (var k = 0; k < tocHeadings.length; k++) {
    if (hs[k]) {
      tocHeadings[k].el = hs[k];
      if (!hs[k].id) hs[k].id = "toc-h-" + k;
    }
  }

  scheduleMeasure(); // 复用统一的 rAF，内容/尺寸变化后重算标题位置与显隐
}

function measureTocTops() {
  if (!tocHeadings.length) { tocTops = []; return; }
  var mdTop = markdown.getBoundingClientRect().top;
  var base = markdown.scrollTop;
  tocTops = tocHeadings.map(function (item) {
    return item.el.getBoundingClientRect().top - mdTop + base;
  });
}

function layoutToc() {
  if (currentView !== "preview" || stackedLayout || !tocHeadings.length) {
    toc.hidden = true;
    return;
  }
  var padLeft = parseFloat(getComputedStyle(markdown).paddingLeft) || 0;
  var available = padLeft - 32; // 自身 left 16px + 与正文之间至少留 16px
  if (available < 150) { toc.hidden = true; return; }
  toc.style.setProperty("--toc-w", Math.min(210, Math.round(available)) + "px");
  toc.hidden = false;
}

function setTocActive(index) {
  if (index === tocActive) return;
  if (tocActive >= 0 && tocHeadings[tocActive]) {
    tocHeadings[tocActive].btn.classList.remove("is-active");
    tocHeadings[tocActive].btn.removeAttribute("aria-current");
  }
  tocActive = index;
  if (index >= 0 && tocHeadings[index]) {
    tocHeadings[index].btn.classList.add("is-active");
    tocHeadings[index].btn.setAttribute("aria-current", "location");
  }
}

function updateTocActive() {
  if (!tocHeadings.length || toc.hidden) return;
  var y = markdown.scrollTop + 28;
  var idx = 0;
  for (var i = 0; i < tocTops.length; i++) {
    if (tocTops[i] <= y) idx = i;
    else break;
  }
  setTocActive(idx);
}

function scrollToHeading(index) {
  var item = tocHeadings[index];
  if (!item) return;
  var top = item.el.getBoundingClientRect().top - markdown.getBoundingClientRect().top + markdown.scrollTop - 20;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  markdown.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  setTocActive(index);
}

markdown.addEventListener("scroll", function () {
  if (toc.hidden || tocScrollFrame) return;
  tocScrollFrame = requestAnimationFrame(function () {
    tocScrollFrame = 0;
    updateTocActive();
  });
}, { passive: true });

function render(value) {
  if (value.trim()) {
    var cleaned = sanitizeHtml(converter.makeHtml(value));
    if (cleaned === null) {
      // 净化库未加载：降级为纯文本，不注入任何 HTML
      markdown.textContent = value;
    } else {
      markdown.innerHTML = cleaned;
      hardenLinks(markdown);
    }
  } else {
    markdown.innerHTML = EMPTY_HTML;
  }
  setupTables(markdown);
  buildToc();
  updateCount(value);
  scheduleMeasure(); // 内容高度变了，下一帧统一重算两侧可滚动距离
}

(function fun() {
  render(content);
})();

// 沿用原函数名：保存回包后按已保存内容再渲染一次
function convert() {
  render(content);
}

textarea.addEventListener("input", function () {
  render(textarea.value); // 即时预览（保持原有体验，不加延迟）
  scheduleSave();         // 保存统一走防抖：连续输入只在最后一次后发一次请求
});

/* ------------------------------------------------------------
   三态视图：编辑 / 分屏 / 预览
   ------------------------------------------------------------ */
var VIEWS = ["edit", "split", "preview"];
var currentView = "preview";
var viewButtons = document.querySelectorAll(".view-btn");

function setView(view) {
  if (VIEWS.indexOf(view) === -1) return;
  currentView = view;
  document.body.setAttribute("data-view", view);
  isStatus = view !== "preview";
  scrollWrites.length = 0; // 切视图后清掉历史写入，避免误吸收
  scheduleMeasure();

  for (var i = 0; i < viewButtons.length; i++) {
    viewButtons[i].setAttribute(
      "aria-pressed",
      String(viewButtons[i].getAttribute("data-view") === view)
    );
  }
}

for (var i = 0; i < viewButtons.length; i++) {
  viewButtons[i].addEventListener("click", function () {
    setView(this.getAttribute("data-view"));
  });
}

// 兼容旧入口：保留 preview() 名称，改为三态循环
function preview() {
  setView(VIEWS[(VIEWS.indexOf(currentView) + 1) % VIEWS.length]);
}

/* ------------------------------------------------------------
   分屏中缝：拖拽 / 键盘 / 双击复位
   ------------------------------------------------------------ */
var workspace = document.querySelector(".container");
var divider = document.getElementById("divider");
var splitPct = 50;
var dragging = false;
var dragPointer = null;
var grabOffset = 0;
var pendingPct = 50;
var rafId = 0;

function isVertical() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function applySplit(pct, loose) {
  var min = loose ? 22 : 25;
  var max = loose ? 78 : 75;
  splitPct = Math.max(min, Math.min(max, pct));
  workspace.style.setProperty("--split", splitPct + "%");
  divider.setAttribute("aria-valuenow", String(Math.round(splitPct)));
  scheduleMeasure(); // 分屏比例改变会改变面板高度
}

// 越界时递增阻力，不硬停
function rubberband(raw) {
  if (raw < 25) return 25 - (25 - raw) * 0.22;
  if (raw > 75) return 75 + (raw - 75) * 0.22;
  return raw;
}

function pctFromPointer(event) {
  var rect = workspace.getBoundingClientRect();
  var raw = isVertical()
    ? ((event.clientY - grabOffset - rect.top) / rect.height) * 100
    : ((event.clientX - grabOffset - rect.left) / rect.width) * 100;
  return rubberband(raw);
}

divider.addEventListener("pointerdown", function (event) {
  if (currentView !== "split") return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (dragging) return; // 多指保护

  dragging = true;
  dragPointer = event.pointerId;
  var rect = divider.getBoundingClientRect();
  grabOffset = isVertical()
    ? event.clientY - rect.top
    : event.clientX - rect.left;

  divider.setPointerCapture(event.pointerId);
  divider.classList.add("is-dragging");
  document.body.classList.add("is-resizing");
  event.preventDefault();
});

divider.addEventListener("pointermove", function (event) {
  if (!dragging || event.pointerId !== dragPointer) return;
  pendingPct = pctFromPointer(event);
  if (!rafId) {
    rafId = requestAnimationFrame(function () {
      applySplit(pendingPct, true);
      rafId = 0;
    });
  }
});

function endDrag(event) {
  if (!dragging || (event && event.pointerId !== dragPointer)) return;
  dragging = false;
  dragPointer = null;
  divider.classList.remove("is-dragging");
  document.body.classList.remove("is-resizing");
  applySplit(Math.abs(splitPct - 50) < 1.5 ? 50 : splitPct); // 靠近中线时吸附
}
divider.addEventListener("pointerup", endDrag);
divider.addEventListener("pointercancel", endDrag);
divider.addEventListener("lostpointercapture", endDrag);

divider.addEventListener("dblclick", function () {
  applySplit(50);
});

divider.addEventListener("keydown", function (event) {
  var step = event.shiftKey ? 10 : 2;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    applySplit(splitPct - step);
  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    applySplit(splitPct + step);
  } else if (event.key === "Home") {
    applySplit(50);
  } else {
    return;
  }
  event.preventDefault();
});

function updateDividerOrientation() {
  stackedLayout = isVertical();
  divider.setAttribute("aria-orientation", stackedLayout ? "horizontal" : "vertical");
  scheduleMeasure();
}
window.addEventListener("resize", updateDividerOrientation);

/* ------------------------------------------------------------
   横向分屏时按比例同步两侧滚动（移动端上下分屏不启用）
   - 缓存可滚动距离：scroll 路径不再读 scrollHeight / clientHeight，避免强制同步布局掉帧
   - 记录程序化写入值来吸收跟随侧的 scroll 事件，其余一律视为用户主动滚动；
     不依赖输入事件认领，也不依赖单帧布尔锁的时序，既无回环也不丢联动
   - 写入整数 + 0.5px 死区，消除子像素来回修正造成的抖动
   ------------------------------------------------------------ */
var panes = [textarea, markdown];
var WRITE_WINDOW = 160; // ms：程序化写入值的有效匹配窗口

function measurePanes() {
  paneMax[0] = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
  paneMax[1] = Math.max(0, markdown.scrollHeight - markdown.clientHeight);
}

function scheduleMeasure() {
  if (measureFrame) return;
  measureFrame = requestAnimationFrame(function () {
    measureFrame = 0;
    measurePanes();
    measureTocTops(); // 正文高度变化后，标题位置与当前章节一起重算
    layoutToc();
    updateTocActive();
  });
}

function isProgrammaticScroll(el, top) {
  var now = performance.now();
  for (var i = scrollWrites.length - 1; i >= 0; i--) {
    var w = scrollWrites[i];
    if (now - w.t > WRITE_WINDOW) break; // 队列按时间递增，更早的也必然过期
    if (w.el === el && Math.abs(top - w.top) <= 2) return true;
  }
  return false;
}

function followScroll(driver, top) {
  if (currentView !== "split" || stackedLayout) return;
  var i = driver === textarea ? 0 : 1;
  var j = 1 - i;
  var fromMax = paneMax[i];
  var toMax = paneMax[j];
  if (fromMax <= 0 || toMax <= 0) return; // 一侧不可滚时不强行拽动另一侧
  var ratio = Math.min(1, Math.max(0, top / fromMax));
  var next = Math.round(ratio * toMax);  // 整数写入，避免浮点累积误差
  var follower = panes[j];
  if (Math.abs(follower.scrollTop - next) < 0.5) return; // 死区，避免无意义写入
  scrollWrites.push({ el: follower, top: next, t: performance.now() });
  if (scrollWrites.length > 12) scrollWrites.shift();
  follower.scrollTop = next;
}

function onPaneScroll(event) {
  if (currentView !== "split" || stackedLayout) return;
  var el = event.currentTarget;
  var top = el.scrollTop;
  if (isProgrammaticScroll(el, top)) return; // 自己写入造成的，不反向同步
  followScroll(el, top);
}

panes.forEach(function (el) {
  // 用户明确开始一次交互时清掉历史写入，避免主动滚动恰好撞上旧值被误吸收
  var clearWrites = function () { scrollWrites.length = 0; };
  el.addEventListener("wheel", clearWrites, { passive: true });
  el.addEventListener("pointerdown", clearWrites, { passive: true });
  el.addEventListener("touchstart", clearWrites, { passive: true });
  el.addEventListener("scroll", onPaneScroll, { passive: true });
});

// 内容/尺寸异步变化后重算缓存：图片加载、字体就绪、面板尺寸变化
markdown.addEventListener("load", scheduleMeasure, true);
if (window.ResizeObserver) {
  var paneObserver = new ResizeObserver(scheduleMeasure);
  paneObserver.observe(textarea);
  paneObserver.observe(markdown);
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMeasure);

// 兼容旧入口：仍允许显式触发一次同步
function syncScroll(from, to) {
  followScroll(from, from.scrollTop);
}

/* ------------------------------------------------------------
   复制（剪贴板逻辑原样，仅把显隐改为 class 驱动以支持过渡）
   ------------------------------------------------------------ */
function copy() {
  let value = "";
  if (isStatus) {
    value = content;
  } else {
    var cleaned = sanitizeHtml(converter.makeHtml(content));
    value = cleaned === null ? content : cleaned;
  }
  navigator.clipboard.writeText(value);
  message.classList.add("is-visible");
  setTimeout(() => {
    message.classList.remove("is-visible");
  }, 2000);
}

// 替代原内联 onclick="copy()"：CSP 禁止内联事件处理器，改为外部绑定
var copyBtn = document.getElementById("copyBtn");
if (copyBtn) copyBtn.addEventListener("click", copy);

// 禁用页面的 ctrl+s 保存功能（原有）
window.addEventListener("keydown", function (event) {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
  }
  // Alt + 1 / 2 / 3 快速切换视图
  if (event.altKey && !event.ctrlKey && !event.metaKey &&
      ["1", "2", "3"].indexOf(event.key) !== -1) {
    event.preventDefault();
    setView(VIEWS[Number(event.key) - 1]);
  }
});

// Make the content available to print.
printable.appendChild(document.createTextNode(content));

setView("preview"); // 打开页面默认只看预览，编辑 / 分屏由顶栏切换
applySplit(50);
updateDividerOrientation();

// 桌面自动聚焦编辑器；默认预览时编辑区隐藏，不能对隐藏元素聚焦，移动端也不弹键盘
if (!isVertical() && currentView !== "preview") textarea.focus();
