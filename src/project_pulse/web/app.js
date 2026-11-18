"use strict";
const app = document.querySelector("#app");
const overlay = document.querySelector("#overlay");
const state = {
  data: null,
  token: "",
  view: "overview",
  filter: "all",
  project: null,
  query: "",
  limit: 40,
  error: "",
  modal: null,
  showDone: false,
  fromList: false,
  busy: false,
  manualSync: false,
};
let composing = false;

const labels = {
  running: "正在运行",
  completed: "本轮完成",
  failed: "运行失败",
  interrupted: "已中断",
  unknown: "状态未知",
};

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name, cls = "") =>
  `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const icons = () =>
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
const project = (id) => state.data?.projects.find((p) => p.id === id);
const session = (id) => state.data?.sessions.find((s) => s.id === id);
const pname = (id) => project(id)?.name || "项目已移除";

const relative = (seconds) => {
  if (!seconds) return "暂无动态";
  const d = Math.max(0, Date.now() / 1000 - seconds);
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 604800) return `${Math.floor(d / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
};

const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const activeTodos = () => state.data.todos.filter((t) => t.status !== "done");
const unreadTotal = () =>
  state.data.source.readStateAvailable === false
    ? null
    : state.data.sessions.filter((s) => s.needsReview).length;

function sortedProjects() {
  return [...state.data.projects].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.unread > 0) - (a.unread > 0) ||
      (b.running > 0) - (a.running > 0) ||
      (b.todoCount > 0) - (a.todoCount > 0) ||
      b.updatedAt - a.updatedAt,
  );
}

function sortedTodos(items) {
  return [...items].sort(
    (a, b) =>
      (a.status === "done") - (b.status === "done") ||
      (b.priority === "high") - (a.priority === "high") ||
      (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
      b.createdAt - a.createdAt,
  );
}

function sortedProjectSessions(projectId) {
  return state.data.sessions
    .filter((s) => s.projectId === projectId)
    .sort(
      (a, b) =>
        Number(b.needsReview) - Number(a.needsReview) ||
        (b.status === "running") - (a.status === "running") ||
        b.updatedAt - a.updatedAt,
    );
}

function statusState(s) {
  return s.needsReview ? "unread" : s.status || "unknown";
}

function statusText(s) {
  const tone = s.needsReview
    ? "unread"
    : s.status === "running"
      ? "running"
      : s.status === "failed"
        ? "failed"
        : "muted";
  const text = s.needsReview ? "待看结果" : labels[s.status] || "状态未知";
  return `<span class="state-text ${tone}">${esc(text)}</span>`;
}

const agentCounts = new WeakMap();
function multiAgent() {
  const d = state.data;
  if (!d) return false;
  if (!agentCounts.has(d))
    agentCounts.set(
      d,
      new Set(d.sessions.map((s) => s.agent || "codex")).size,
    );
  return agentCounts.get(d) > 1;
}

// Which agent a chat belongs to; shown only when more than one agent has sessions.
function agentLabel(s) {
  return multiAgent() ? s.agentLabel || "Codex" : "";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Embedded panels may not grant clipboard access; fall back to a selection copy.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function request(url, body, retried = false) {
  if (window.PulseHost) return window.PulseHost.request(url, body);
  const res = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Pulse-Token": state.token,
          },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  let value;
  try {
    value = await res.json();
  } catch {
    throw Error("服务暂时不可用，请重试");
  }
  if (res.status === 403 && body && !retried) {
    // A restarted local server rotates its token. The rejected write did not run,
    // so refresh credentials once and retry without losing the user's form.
    const boot = await request("/api/bootstrap");
    state.token = boot.token;
    state.data = boot.data;
    return request(url, body, true);
  }
  if (!res.ok) throw Error(value.error || "请求失败");
  return value;
}

async function refresh(initial = false, manual = false) {
  if (state.busy) return;
  state.busy = true;
  state.manualSync = manual;
  if (manual) render();
  try {
    if (initial || !state.token) {
      const boot = await request("/api/bootstrap");
      state.token = boot.token;
      state.data = boot.data;
    } else {
      state.data = await request("/api/snapshot");
    }
    state.error = "";
    render();
  } catch (e) {
    state.error = e.message;
    render();
  } finally {
    state.busy = false;
    state.manualSync = false;
  }
}

function route(view, projectId = null, filter = "all") {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (filter !== "all") params.set("filter", filter);
  const value = `#${view}${params.size ? "?" + params : ""}`;
  if (location.hash === value) {
    readRoute();
    render();
  } else location.hash = value;
}

function readRoute() {
  const [view, query] = (location.hash.slice(1) || "overview").split("?");
  state.view = ["overview", "attention", "sessions", "todos"].includes(view)
    ? view
    : "overview";
  const q = new URLSearchParams(query);
  state.project = q.get("project");
  state.filter = q.get("filter") || "all";
  state.query = "";
  state.limit = 40;
  closeOverlay();
}

function rememberFocus() {
  const el = document.activeElement;
  return el?.id
    ? { id: el.id, start: el.selectionStart, end: el.selectionEnd }
    : null;
}

function restoreFocus(f) {
  if (!f) return;
  const el = document.getElementById(f.id);
  el?.focus({ preventScroll: true });
  if (el?.setSelectionRange && typeof f.start === "number")
    el.setSelectionRange(f.start, f.end);
}

function todoToggle() {
  const open = activeTodos();
  const due = open.some((t) => t.dueDate && t.dueDate <= today());
  return `<button class="secondary todo-toggle ${state.view === "todos" && !state.project ? "active" : ""}" data-action="todos" aria-haspopup="dialog" title="查看待办 (T)">${icon("list-checks")}<span>待办</span><span class="todo-count ${due ? "due" : open.length ? "has" : ""}">${open.length}</span></button>`;
}

function navigation() {
  const d = state.data;
  const unread = unreadTotal();
  const hasBadge =
    !state.error && d.unreadBadge?.known && d.unreadBadge.count > 0;
  const nav = [
    ["overview", "layout-grid", "项目总览", d.projects.length, false],
    ["attention", "inbox", "待我处理", unread, Boolean(unread && unread > 0)],
    ["sessions", "messages-square", "全部会话", d.sessions.length, false],
  ];
  return `<header class="top-nav"><button class="brand-home" data-action="nav" data-view="overview" title="${hasBadge ? `${d.unreadBadge.count} 个未读会话` : "回到项目总览"}"><span class="nav-brand" aria-hidden="true"><span class="brand-mark"></span>${hasBadge ? '<span class="unread-indicator"></span>' : ""}</span><span class="brand-wordmark">Project Pulse</span></button><nav class="nav" aria-label="主导航">${nav
    .map(
      ([v, i, t, n, alert]) =>
        `<button data-action="nav" data-view="${v}" class="${state.view === v && !state.project ? "active" : ""} ${alert ? "has-alert" : ""}" ${state.view === v && !state.project ? 'aria-current="page"' : ""}>${icon(i)}<span>${t}</span><span class="count">${n === null ? "?" : n}</span></button>`,
    )
    .join("")}</nav><div class="header-actions"><span class="sync-label" title="最近同步时间">${relative(d.source.updatedAt)}同步</span><button class="icon-btn ${state.manualSync ? "spinning" : ""}" data-action="refresh" aria-label="刷新项目状态" title="刷新 (R)">${icon("refresh-cw")}</button><button class="icon-btn" data-action="settings" aria-label="连接与数据设置" title="连接与数据">${icon("sliders-horizontal")}</button>${todoToggle()}<button class="primary" data-action="new-todo" aria-label="新建待办" title="新建待办 (N)" ${state.project ? `data-project="${esc(state.project)}"` : ""}>${icon("plus")}<span>新建待办</span></button></div></header>`;
}

function projectMasthead(p) {
  const path = (p.roots[0] || "").replace(/^\/Users\/[^/]+\//, "~/");
  const openTodoCount = state.data.todos.filter(
    (t) => t.projectId === p.id && t.status !== "done",
  ).length;
  return `<section class="project-masthead" aria-label="当前项目"><div class="project-masthead-main"><button class="back-btn" data-action="nav" data-view="overview" aria-label="返回项目总览">${icon("arrow-left")}<span>返回总览</span></button><div class="project-masthead-titles"><h1 title="${esc(p.name)}">${esc(p.name)}</h1><span class="project-masthead-path" title="${esc(p.roots.join("\n"))}">${esc(path)}</span></div><button class="icon-btn pin ${p.pinned ? "pinned" : ""}" data-action="pin" data-id="${esc(p.id)}" aria-label="${p.pinned ? "取消置顶" : "置顶"} ${esc(p.name)}" title="${p.pinned ? "取消置顶" : "置顶"}">${icon("pin")}</button></div><div class="project-mode-switch" role="group" aria-label="项目视图切换"><button data-action="project-view" data-id="${esc(p.id)}" data-view="sessions" class="${state.view !== "todos" ? "active" : ""}">会话 ${p.sessionCount}</button><button data-action="project-view" data-id="${esc(p.id)}" data-view="todos" class="${state.view === "todos" ? "active" : ""}">待办 ${openTodoCount}</button></div></section>`;
}

function searchBox(placeholder) {
  return `<label class="search">${icon("search")}<input id="main-search" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(state.query)}">${state.query ? `<button type="button" class="icon-btn search-clear" data-action="clear-search" aria-label="清除搜索" title="清除">${icon("x")}</button>` : '<span class="search-kbd" aria-hidden="true">/</span>'}</label>`;
}

function controls(tabs, placeholder, extra = "") {
  return `<div class="controls"><div class="tabs" role="group" aria-label="筛选">${tabs
    .map(
      ([v, t, count, tone]) =>
        `<button data-action="filter" data-filter="${v}" class="${state.filter === v ? "active" : ""} ${count === 0 ? "is-zero" : ""}" aria-pressed="${state.filter === v}"><span>${t}</span>${count !== undefined && count !== null ? `<span class="tab-count ${tone && count > 0 ? tone : ""}">${count}</span>` : ""}</button>`,
    )
    .join("")}</div><div class="control-actions">${searchBox(placeholder)}${extra}</div></div>`;
}

function attentionItems() {
  const since = Date.now() / 1000 - 86400;
  const byTime = (a, b) => b.updatedAt - a.updatedAt;
  const sessions = state.data.sessions;
  return [
    ...sessions.filter((s) => s.needsReview).sort(byTime),
    ...sessions
      .filter((s) => !s.needsReview && s.status === "failed" && s.updatedAt > since)
      .sort(byTime),
  ];
}

function attentionRow(s) {
  const failed = !s.needsReview;
  return `<li class="attention-row ${failed ? "" : "is-unread"}"><span class="status-dot ${failed ? "failed" : "unread"}"></span><button class="attention-title" data-action="open" data-id="${esc(s.id)}" title="打开对话：${esc(s.title)}">${esc(s.title)}</button><span class="tag ${failed ? "failed" : "unread"}">${failed ? "运行失败" : "新结果"}</span><button class="attention-project" data-action="project" data-id="${esc(s.projectId)}">${esc(pname(s.projectId))}</button><time>${relative(s.updatedAt)}</time><button class="icon-btn row-add" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(s.title)}" title="关联待办">${icon("plus")}</button></li>`;
}

function attention() {
  const items = attentionItems();
  if (!items.length) return "";
  const more =
    items.length > 5
      ? `<button class="text-btn" data-action="nav" data-view="attention">还有 ${items.length - 5} 项${icon("arrow-right")}</button>`
      : "";
  return `<section class="attention" aria-label="待看结果"><div class="section-label"><h2>待看结果</h2><span>${items.length}</span>${more}</div><ul class="attention-list">${items
    .slice(0, 5)
    .map(attentionRow)
    .join("")}</ul></section>`;
}

function todoLine(t) {
  const done = t.status === "done";
  const due = !t.dueDate || done
    ? ""
    : t.dueDate === today()
      ? '<span class="tag failed">今天到期</span>'
      : t.dueDate < today()
        ? `<span class="tag failed">逾期 ${esc(t.dueDate.slice(5))}</span>`
        : `<span>截止 ${esc(t.dueDate.slice(5))}</span>`;
  const linked = t.sessionId ? session(t.sessionId) : null;
  return `<li class="todo-line"><button class="check ${done ? "done" : ""}" data-action="toggle-todo" data-id="${esc(t.id)}" aria-label="${done ? "重新打开" : "完成"}待办：${esc(t.title)}" title="${done ? "重新打开" : "完成"}"><span class="check-box">${done ? icon("check") : ""}</span></button><div class="todo-line-main"><button class="todo-line-title ${done ? "done" : ""}" data-action="edit-todo" data-id="${esc(t.id)}" title="编辑待办">${esc(t.title)}</button><div class="todo-line-meta"><button data-action="project-view" data-id="${esc(t.projectId)}" data-view="todos">${esc(pname(t.projectId))}</button>${!done && t.priority === "high" ? '<span class="tag todo">高优先</span>' : ""}${!done && t.status === "doing" ? "<span>进行中</span>" : ""}${due}${
    t.sessionId
      ? `<button class="todo-link" data-action="open" data-id="${esc(t.sessionId)}" title="打开关联会话：${esc(linked?.title || "关联会话")}" aria-label="打开关联会话">${icon("message-square")}</button>`
      : ""
  }</div></div></li>`;
}

function projectSignals(p) {
  const signals = [
    [p.unread, "unread", "待看", "sessions", "unread"],
    [p.running, "running", "运行中", "sessions", "running"],
    [p.todoCount, "todo", "待办", "todos", ""],
  ].filter(([n]) => n > 0);
  return signals.length
    ? `<div class="signals">${signals
        .map(
          ([n, tone, label, view, filter]) =>
            `<button class="signal ${tone}" data-action="project-view" data-id="${esc(p.id)}" data-view="${view}" ${filter ? `data-filter="${filter}"` : ""}>${n} ${label}</button>`,
        )
        .join("")}</div>`
    : "";
}

function pinButton(p) {
  return `<button class="icon-btn pin ${p.pinned ? "pinned" : ""}" data-action="pin" data-id="${esc(p.id)}" aria-label="${p.pinned ? "取消置顶" : "置顶"} ${esc(p.name)}" title="${p.pinned ? "取消置顶" : "置顶"}">${icon("pin")}</button>`;
}

function cardSession(s) {
  return `<li class="card-session ${s.needsReview ? "is-unread" : ""}"><span class="status-dot ${esc(statusState(s))}" title="${esc(s.needsReview ? "待看结果" : labels[s.status] || "状态未知")}"></span><button class="card-session-title" data-action="open" data-id="${esc(s.id)}" title="打开对话：${esc(s.title)}">${esc(s.title)}</button><time>${relative(s.updatedAt)}</time><button class="icon-btn row-add" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(s.title)}" title="关联待办">${icon("plus")}</button></li>`;
}

function projectCard(p) {
  const tone = p.unread ? "unread" : p.running ? "running" : p.todoCount ? "todo" : "quiet";
  const sessions = sortedProjectSessions(p.id).slice(0, tone !== "quiet" || p.pinned ? 3 : 1);
  const path = (p.roots[0] || "").replace(/^\/Users\/[^/]+\//, "~/");
  return `<article class="project-card" data-state="${tone}" aria-label="${esc(p.name)}"><header class="card-head"><h3><button class="project-name" data-action="project" data-id="${esc(p.id)}" title="进入 ${esc(p.name)}">${esc(p.name)}</button></h3>${projectSignals(p)}${pinButton(p)}</header><span class="project-path" title="${esc(p.roots.join("\n"))}">${esc(path)}</span>${
    sessions.length
      ? `<ul class="card-sessions">${sessions.map(cardSession).join("")}</ul>`
      : '<p class="card-empty">暂无会话</p>'
  }<footer class="card-foot"><span>${p.sessionCount ? `${p.sessionCount} 条会话 · ${relative(p.updatedAt)}` : "暂无动态"}</span><button class="icon-btn" data-action="new-todo" data-project="${esc(p.id)}" aria-label="为 ${esc(p.name)} 添加待办" title="添加待办">${icon("plus")}</button><button class="text-btn" data-action="project" data-id="${esc(p.id)}">全部${icon("arrow-right")}</button></footer></article>`;
}

function empty(title, iconName = "inbox") {
  return `<div class="empty-state">${icon(iconName)}<p>${title}</p></div>`;
}

function overview() {
  const all = sortedProjects();
  const q = state.query.toLowerCase();
  let items = all.filter((p) => (p.name + " " + p.roots.join(" ")).toLowerCase().includes(q));
  if (state.filter === "running") items = items.filter((p) => p.running > 0);
  if (state.filter === "unread") items = items.filter((p) => p.unread > 0);
  if (state.filter === "todo") items = items.filter((p) => p.todoCount > 0);
  if (state.filter === "pinned") items = items.filter((p) => p.pinned);
  const pinned = all.filter((p) => p.pinned).length;
  const count = (fn) => all.filter(fn).length;
  return `<div class="overview">${attention()}<section class="projects" aria-label="项目"><div class="section-label"><h2>项目</h2></div>${controls(
    [
      ["all", "全部", all.length],
      ["unread", "待看结果", count((p) => p.unread > 0), "unread"],
      ["running", "运行中", count((p) => p.running > 0), "running"],
      ["todo", "有待办", count((p) => p.todoCount > 0), "todo"],
      ["pinned", "置顶", pinned],
    ],
    "搜索项目或路径",
  )}${
    items.length
      ? `<div class="project-grid">${items.map(projectCard).join("")}</div>`
      : empty("没有匹配的项目", "folder-search")
  }</section></div>`;
}

function sessionRow(s) {
  const agent = agentLabel(s);
  const openHint =
    s.agent === "claude"
      ? "终端恢复"
      : s.agent && s.agent !== "codex"
        ? "复制命令"
        : "打开对话";
  return `<article class="session-row ${s.needsReview ? "is-unread" : s.status === "running" ? "is-running" : ""}"><span class="status-dot ${esc(statusState(s))}"></span><div class="session-main"><button class="session-title" data-action="open" data-id="${esc(s.id)}" title="${openHint}：${esc(s.title)}">${esc(s.title)}</button><div class="session-sub">${
    !state.project
      ? `<button class="session-project-btn" data-action="project" data-id="${esc(s.projectId)}">${esc(pname(s.projectId))}</button><span>·</span>`
      : ""
  }${agent ? `<span>${esc(agent)}</span><span>·</span>` : ""}${statusText(s)}<span>·</span><time>${relative(s.updatedAt)}</time></div></div><div class="row-actions"><button class="icon-btn" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(s.title)}" title="关联待办">${icon("plus")}</button><button class="icon-btn" data-action="open" data-id="${esc(s.id)}" aria-label="${openHint}：${esc(s.title)}" title="${openHint}">${icon("arrow-up-right")}</button></div></article>`;
}

function sessionsView() {
  const attention = state.view === "attention";
  const base = state.data.sessions.filter(
    (s) => !state.project || s.projectId === state.project,
  );
  let items = base.filter((s) =>
    (s.title + " " + pname(s.projectId) + " " + (s.agentLabel || ""))
      .toLowerCase()
      .includes(state.query.toLowerCase()),
  );
  if (attention)
    items = items.filter((s) =>
      state.filter === "failed" ? s.status === "failed" : s.needsReview,
    );
  else if (state.filter !== "all")
    items = items.filter((s) =>
      state.filter === "unread" ? s.needsReview : s.status === state.filter,
    );
  items.sort(
    (a, b) =>
      Number(b.needsReview) - Number(a.needsReview) ||
      (b.status === "running") - (a.status === "running") ||
      b.updatedAt - a.updatedAt,
  );

  const tabs = attention
    ? [
        ["all", "待看结果", base.filter((s) => s.needsReview).length, "unread"],
        [
          "failed",
          "运行失败",
          base.filter((s) => s.status === "failed").length,
        ],
      ]
    : [
        ["all", "全部", base.length],
        [
          "running",
          "正在运行",
          base.filter((s) => s.status === "running").length,
          "running",
        ],
        [
          "unread",
          "待看结果",
          base.filter((s) => s.needsReview).length,
          "unread",
        ],
        [
          "completed",
          "本轮完成",
          base.filter((s) => s.status === "completed").length,
        ],
        [
          "unknown",
          "状态未知",
          base.filter((s) => s.status === "unknown").length,
        ],
      ];

  return `${controls(tabs, "搜索会话标题或项目…")}${
    items.length
      ? `<div class="list-surface">${items.slice(0, state.limit).map(sessionRow).join("")}</div>${items.length > state.limit ? `<button class="more-btn" data-action="more">加载更多（剩余 ${items.length - state.limit} 条）</button>` : ""}`
      : empty(
          attention
            ? state.filter === "failed"
              ? "当前没有运行失败的会话"
              : state.data.source.readStateAvailable === false
                ? "当前无法读取桌面未读状态"
                : "所有已完成会话的结果都已查看完毕"
            : "没有找到匹配的会话",
          attention ? "check-circle-2" : "messages-square",
        )
  }`;
}

function todoItem(t) {
  const overdue = t.dueDate && t.dueDate < today() && t.status !== "done";
  const linked = t.sessionId ? session(t.sessionId) : null;
  return `<article class="todo-item"><button class="check ${t.status === "done" ? "done" : ""}" data-action="toggle-todo" data-id="${esc(t.id)}" aria-label="${t.status === "done" ? "重新打开" : "完成"}待办：${esc(t.title)}"><span class="check-box">${t.status === "done" ? icon("check") : ""}</span></button><div class="todo-info"><button class="todo-title ${t.status === "done" ? "done" : ""}" data-action="edit-todo" data-id="${esc(t.id)}">${esc(t.title)}</button><div class="todo-meta">${
    !state.project
      ? `<button data-action="project-view" data-id="${esc(t.projectId)}" data-view="todos">${esc(pname(t.projectId))}</button>`
      : ""
  }${t.sessionId ? `<button class="todo-session-link" data-action="open" data-id="${esc(t.sessionId)}" title="打开关联会话：${esc(linked?.title || "关联会话")}">${icon("link-2")}<span>${esc(linked?.title || "关联会话")}</span></button>` : ""}${t.priority === "high" ? '<span class="high">高优先</span>' : ""}${t.status === "doing" ? "<span>进行中</span>" : ""}${t.dueDate ? `<span class="${overdue ? "overdue" : ""}">${overdue ? "已逾期 " : "截止 "}${esc(t.dueDate.slice(5))}</span>` : ""}</div></div><div class="row-actions"><button class="icon-btn" data-action="edit-todo" data-id="${esc(t.id)}" aria-label="编辑待办：${esc(t.title)}" title="编辑">${icon("pencil")}</button></div></article>`;
}

function todosView() {
  const base = state.data.todos.filter(
    (t) => !state.project || t.projectId === state.project,
  );
  let todos = base.filter((t) =>
    (t.title + " " + pname(t.projectId))
      .toLowerCase()
      .includes(state.query.toLowerCase()),
  );
  if (state.filter === "all") todos = todos.filter((t) => t.status !== "done");
  else if (state.filter === "high")
    todos = todos.filter((t) => t.priority === "high" && t.status !== "done");
  else if (state.filter === "done")
    todos = todos.filter((t) => t.status === "done");
  else if (state.filter === "doing")
    todos = todos.filter((t) => t.status === "doing");
  todos = sortedTodos(todos);

  return `${controls(
    [
      ["all", "未完成", base.filter((t) => t.status !== "done").length],
      [
        "high",
        "高优先",
        base.filter((t) => t.priority === "high" && t.status !== "done").length,
      ],
      ["doing", "进行中", base.filter((t) => t.status === "doing").length],
      ["done", "已完成", base.filter((t) => t.status === "done").length],
    ],
    "搜索待办内容…",
    `<button class="secondary" data-action="export" title="导出待办 JSON">${icon("download")}<span>导出</span></button>`,
  )}${
    todos.length
      ? `<div class="list-surface todo-list">${todos.map(todoItem).join("")}</div>`
      : empty(
          state.filter === "done"
            ? "还没有已完成的待办记录"
            : "当前没有待办事项",
          "check-square",
        )
  }`;
}

function render() {
  PulseBrand.update(state.data, Boolean(state.error));
  const focus = rememberFocus();
  if (!state.data) {
    app.innerHTML = `<div class="boot"><span class="brand-mark boot-logo" aria-label="Project Pulse"></span><p>${esc(state.error || "正在读取本机项目状态…")}</p>${state.error ? '<button class="secondary" data-action="refresh">重试连接</button>' : ""}</div>`;
    icons();
    return;
  }
  const viewName = {
    overview: "项目总览",
    attention: "待我处理",
    sessions: "全部会话",
    todos: "我的待办",
  }[state.view];
  const selectedProject = project(state.project);
  app.innerHTML = `<div class="shell">${navigation()}<main class="main" aria-label="${esc(viewName)}"><div class="content">${state.error ? `<div class="notice" role="alert">${esc(state.error)} · 当前展示上次同步结果</div>` : ""}<section class="board">${selectedProject ? projectMasthead(selectedProject) : ""}${state.view === "overview" ? overview() : state.view === "todos" ? todosView() : sessionsView()}</section></div></main></div>`;
  icons();
  restoreFocus(focus);
}

let beforeOverlay = null;
function closeOverlay() {
  PulseControls.destroy();
  state.modal = null;
  overlay.innerHTML = "";
  document.body.style.overflow = "";
  const previous = beforeOverlay;
  const target = previous?.isConnected
    ? previous
    : previous?.dataset.action
      ? [...app.querySelectorAll("[data-action]")].find((el) =>
          ["action", "id", "project", "session"].every(
            (key) => el.dataset[key] === previous.dataset[key],
          ),
        )
      : null;
  target?.focus({ preventScroll: true });
  beforeOverlay = null;
}

function mountOverlay(html) {
  PulseControls.destroy();
  if (!overlay.children.length) beforeOverlay = document.activeElement;
  overlay.innerHTML = html;
  document.body.style.overflow = "hidden";
  icons();
  const focus =
    overlay.querySelector("[autofocus]") || overlay.querySelector("button");
  focus?.focus({ preventScroll: true });
}

function dismiss() {
  if (state.modal === "todo" && state.fromList) {
    state.fromList = false;
    showTodos();
  } else closeOverlay();
}

function showTodos() {
  state.modal = "todos";
  const open = sortedTodos(activeTodos());
  const done = state.data.todos
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  mountOverlay(
    `<div class="overlay-backdrop" data-action="close"></div><section class="dialog todos-dialog" role="dialog" aria-modal="true" aria-labelledby="todos-title"><div class="dialog-head"><h2 id="todos-title">待办<span class="dialog-count">${open.length}</span></h2><button class="icon-btn" data-action="close" aria-label="关闭待办">${icon("x")}</button></div><div class="todos-body">${
      open.length
        ? `<ul class="todo-list-compact">${open.map(todoLine).join("")}</ul>`
        : '<p class="todos-empty">没有未完成的待办</p>'
    }${
      done.length
        ? `<button class="todo-card-more" data-action="toggle-done" aria-expanded="${state.showDone}"><span>已完成 ${done.length}</span>${icon(state.showDone ? "chevron-up" : "chevron-down")}</button>${
            state.showDone ? `<ul class="todo-list-compact">${done.slice(0, 30).map(todoLine).join("")}</ul>` : ""
          }`
        : ""
    }</div><div class="todos-foot"><button class="text-btn" data-action="nav" data-view="todos">筛选与导出${icon("arrow-right")}</button></div></section>`,
  );
}

function showTodo(id = null, projectId = null, sessionId = null) {
  const t = state.data.todos.find((v) => v.id === id);
  state.fromList = state.modal === "todos" || (state.modal === "todo" && state.fromList);
  state.modal = "todo";
  const selected = t?.projectId || projectId || state.project || "";
  const selectedSession = t?.sessionId || sessionId || "";
  const projects = sortedProjects().map((p) => ({
    value: p.id,
    text: p.name,
    detail: (p.roots[0] || "").split("/").slice(-2).join("/"),
  }));
  if (t && !projects.some((p) => p.value === selected))
    projects.unshift({ value: selected, text: "项目已移除" });
  const fields = PulseControls;
  mountOverlay(
    `<div class="overlay-backdrop" data-action="close"></div><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="todo-dialog-title"><div class="dialog-head"><h2 id="todo-dialog-title">${t ? "编辑待办" : "新建待办"}</h2><button class="icon-btn" data-action="close" aria-label="关闭待办表单">${icon("x")}</button></div><form id="todo-form" data-id="${esc(t?.id || "")}" novalidate>
    ${fields.textField({ id: "todo-title", name: "title", label: "待办内容", value: t?.title || "", placeholder: "例如：压测新接口并回归边界用例", required: true, autofocus: true })}
    ${fields.selectField({ id: "todo-project", name: "projectId", label: "关联项目", value: selected, options: [{ value: "", text: "选择项目" }, ...projects], placeholder: "选择项目", searchable: true, required: true })}
    ${fields.selectField({ id: "todo-session", name: "sessionId", label: "关联会话", value: selectedSession, options: sessionOptions(selected, selectedSession), placeholder: selected ? "只绑定项目" : "先选择项目", searchable: true, optional: true, disabled: !selected })}
    <div class="form-row">${fields.selectField({
      id: "todo-priority",
      name: "priority",
      label: "优先级",
      value: t?.priority || "normal",
      options: [
        { value: "normal", text: "普通" },
        { value: "high", text: "高" },
        { value: "low", text: "低" },
      ],
    })}${fields.dateField({ id: "todo-due", name: "dueDate", label: "截止日期", value: t?.dueDate || "" })}</div>
    ${
      t
        ? fields.selectField({
            id: "todo-status",
            name: "status",
            label: "当前状态",
            value: t.status,
            options: [
              { value: "todo", text: "待开始" },
              { value: "doing", text: "进行中" },
              { value: "done", text: "已完成" },
            ],
          })
        : ""
    }
    <p class="dialog-error" id="form-error" role="alert"></p><div class="dialog-footer">${t ? `<button type="button" class="secondary" data-action="delete-todo" data-id="${esc(t.id)}">删除</button>` : ""}<button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">${t ? "保存修改" : "添加待办"}</button></div></form></section>`,
  );
  PulseControls.mount(overlay);
}

function sessionOptions(projectId, selected = "") {
  const choices = state.data.sessions
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({ value: s.id, text: s.title }));
  if (selected && !choices.some((s) => s.value === selected))
    choices.unshift({ value: selected, text: "已归档的关联会话" });
  return [{ value: "", text: "只绑定项目" }, ...choices];
}

function settings() {
  state.modal = "settings";
  const activeSources = (state.data.source.sources || [])
    .filter((s) => s.ok)
    .map((s) => `${s.label} (${s.count})`)
    .join(" · ");
  mountOverlay(
    `<div class="overlay-backdrop" data-action="close"></div><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div class="dialog-head"><h2 id="settings-title" class="settings-title"><span class="brand-mark" aria-hidden="true"></span>连接与数据</h2><button class="icon-btn" data-action="close" aria-label="关闭设置">${icon("x")}</button></div><div class="settings-copy"><div class="source-line">${icon("shield-check")}<span>本机只读连接 · ${esc(activeSources || "Codex")}</span></div><p>${esc(state.data.source.scope)}</p><p>点击会话标题可直接回到原对话：Codex 唤起桌面应用，Claude Code 在终端恢复，其他工具复制恢复命令。个人待办与置顶独立保存在本机 SQLite。</p><ul>${state.data.source.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p>快捷键：按 / 搜索，按 N 新建待办，按 R 立即刷新。</p><button class="secondary" data-action="export">${icon("download")}<span>导出待办与项目清单</span></button></div></section>`,
  );
}

async function actionClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const { action, id, view, filter } = button.dataset;
  try {
    switch (action) {
      case "nav":
        route(view);
        break;
      case "project":
        route("sessions", id);
        break;
      case "project-view":
        route(view, id, filter || "all");
        break;
      case "toggle-done":
        state.showDone = !state.showDone;
        showTodos();
        break;
      case "todos":
        showTodos();
        break;
      case "filter":
        state.filter = filter;
        state.limit = 40;
        render();
        break;
      case "clear-search":
        state.query = "";
        state.limit = 40;
        render();
        document.querySelector("#main-search")?.focus();
        break;
      case "refresh":
        await refresh(false, true);
        toast(state.error || "已同步最新状态");
        break;
      case "pin":
        await request("/api/pin", { id, pinned: !project(id)?.pinned });
        await refresh();
        break;
      case "open":
        button.disabled = true;
        try {
          const opened = await request("/api/open", { id });
          if (opened?.dispatched === false && opened.command) {
            toast(
              (await copyText(opened.command))
                ? "已复制恢复命令，请在终端粘贴运行"
                : opened.command,
            );
          } else {
            toast(opened?.command ? "已在终端恢复对话" : "已请求打开对话");
          }
        } finally {
          button.disabled = false;
        }
        break;
      case "new-todo":
        showTodo(null, button.dataset.project, button.dataset.session);
        break;
      case "edit-todo":
        showTodo(id);
        break;
      case "toggle-todo": {
        const t = state.data.todos.find((item) => item.id === id);
        if (!t) break;
        button.disabled = true;
        await request("/api/todo", {
          id,
          status: t.status === "done" ? "todo" : "done",
        });
        await refresh();
        if (state.modal === "todos") showTodos();
        toast(t.status === "done" ? "待办已重新打开" : "待办已完成");
        break;
      }
      case "delete-todo":
        button.dataset.action = "confirm-delete";
        button.textContent = "确认删除";
        break;
      case "confirm-delete":
        await request("/api/delete-todo", { id });
        await refresh();
        dismiss();
        toast("待办已删除");
        break;
      case "settings":
        settings();
        break;
      case "close":
        dismiss();
        break;
      case "more":
        state.limit += 40;
        render();
        break;
      case "export": {
        const data = await request("/api/export");
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = `project-pulse-${today()}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("待办清单已导出");
        break;
      }
    }
  } catch (e) {
    button.disabled = false;
    toast(e.message);
  }
}

document.addEventListener("click", (event) => {
  actionClick(event);
});

document.addEventListener("compositionstart", (event) => {
  if (event.target.id === "main-search") composing = true;
});

document.addEventListener("compositionend", (event) => {
  if (event.target.id === "main-search") {
    composing = false;
    state.query = event.target.value;
    state.limit = 40;
    render();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "todo-title") PulseControls.setError(event.target);
  if (event.target.id === "main-search" && !composing && !event.isComposing) {
    state.query = event.target.value;
    state.limit = 40;
    render();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "todo-project") {
    PulseControls.replaceOptions(
      document.querySelector("#todo-session"),
      sessionOptions(event.target.value),
      "",
      !event.target.value,
    );
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "todo-form") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("[type=submit]");
  document.querySelector("#form-error").textContent = "";
  if (!PulseControls.validate(form)) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  if (form.dataset.id) values.id = form.dataset.id;
  try {
    await request("/api/todo", values);
    await refresh();
    dismiss();
    toast("待办已保存");
  } catch (e) {
    document.querySelector("#form-error").textContent = e.message;
    button.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  const tag = document.activeElement?.tagName;
  const typing =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    document.activeElement?.isContentEditable;

  if (event.key === "Escape") {
    if (overlay.children.length) {
      dismiss();
      return;
    }
    if (state.query) {
      state.query = "";
      render();
      return;
    }
  }

  if (event.key === "Tab" && overlay.children.length) {
    const elements = PulseControls.focusable(overlay);
    const first = elements[0],
      last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
    return;
  }

  if (
    !overlay.children.length &&
    !typing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    if (event.key === "/") {
      const search = document.querySelector("#main-search");
      if (search) {
        event.preventDefault();
        search.focus();
      }
    } else if (event.key === "t" || event.key === "T") {
      event.preventDefault();
      showTodos();
    } else if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      showTodo(null, state.project);
    } else if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      refresh(false, true).then(() => toast(state.error || "已同步最新状态"));
    }
  }
});

window.addEventListener("hashchange", () => {
  readRoute();
  render();
  window.scrollTo({ top: 0 });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

readRoute();
refresh(true);
setInterval(() => {
  if (!document.hidden) refresh();
}, 8000);
