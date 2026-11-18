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
  busy: false,
  expandedProjects: new Set(),
};
const labels = {
  running: "进行中",
  completed: "本轮已完成",
  failed: "运行失败",
  interrupted: "已中断",
  unknown: "状态未知",
};
const todoStatuses = { todo: "待开始", doing: "进行中", done: "已完成" };
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
function badge(s) {
  const unread = s.needsReview;
  return `<span class="badge ${unread ? "unread" : esc(s.status)}">${icon(unread ? "mail" : s.status === "running" ? "loader-circle" : s.status === "completed" ? "check" : s.status === "failed" ? "circle-alert" : "circle")}${unread ? "完成未读" : labels[s.status] || "状态未知"}</span>`;
}
const agentCounts = new WeakMap();
function multiAgent() {
  const d = state.data;
  if (!d) return false;
  if (!agentCounts.has(d)) agentCounts.set(d, new Set(d.sessions.map((s) => s.agent || "codex")).size);
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
  toast.timer = setTimeout(() => el.classList.remove("show"), 3500);
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
async function refresh(initial = false) {
  if (state.busy) return;
  state.busy = true;
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
  state.expandedProjects.clear();
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
function navigation() {
  const d = state.data;
  const nav = [
    ["overview", "panels-top-left", "项目总览", d.projects.length],
    ["attention", "inbox", "待我处理", unreadTotal()],
    ["sessions", "messages-square", "全部会话", d.sessions.length],
    ["todos", "list-todo", "我的待办", activeTodos().length],
  ];
  return `<header class="top-nav"><nav class="nav" aria-label="主导航">${nav.map(([v, i, t, n]) => `<button data-action="nav" data-view="${v}" class="${state.view === v ? "active" : ""}" ${v === "overview" && !state.error && d.unreadBadge?.known && d.unreadBadge.count > 0 ? `title="${d.unreadBadge.count} 个未读会话"` : ""} ${state.view === v ? 'aria-current="page"' : ""}>${v === "overview" ? `<span class="nav-brand" aria-hidden="true"><span class="brand-mark"></span>${!state.error && d.unreadBadge?.known && d.unreadBadge.count > 0 ? '<span class="unread-indicator"></span>' : ""}</span>` : icon(i)}<span>${t}</span><span class="count">${n ?? "—"}</span></button>`).join("")}</nav><button class="icon-btn nav-settings" data-action="settings" aria-label="设置" title="设置">${icon("settings-2")}</button></header>`;
}
function stats() {
  const d = state.data;
  const items = [
    ["项目", d.projects.length, "folder", "", "overview", "all"],
    [
      "进行中",
      d.sessions.filter((s) => s.status === "running").length,
      "activity",
      "running",
      "sessions",
      "running",
    ],
    ["完成未读", unreadTotal(), "mail", "unread", "attention", "all"],
    ["待办", activeTodos().length, "list-todo", "todo", "todos", "all"],
  ];
  return `<section class="summary" aria-label="项目状态汇总">${items.map(([t, n, i, cls, v, f]) => `<button class="stat ${cls} ${n ? "has-value" : ""}" data-action="stat" data-view="${v}" data-filter="${f}">${icon(i)}<span>${t}</span><strong title="${n === null ? "阅读状态暂不可用" : t}">${n ?? "—"}</strong></button>`).join("")}</section>`;
}
function projectMetric(p, value, label, cls, view, filter = "all") {
  return `<button class="project-metric ${cls} ${value ? "has-value" : ""}" data-action="project-view" data-id="${esc(p.id)}" data-view="${view}" data-filter="${filter}" aria-label="${esc(p.name)}：${value === null ? "未知" : value} ${label}" title="${value === null ? "阅读状态暂不可用" : label}"><span class="metric-label">${label}</span><strong>${value === null ? "?" : value || "—"}</strong></button>`;
}
function projectCard(p) {
  const tone = p.unread
    ? "unread"
    : p.running
      ? "running"
      : p.todoCount
        ? "todo"
        : "quiet";
  const expanded = state.expandedProjects.has(p.id);
  const sessions = expanded
    ? state.data.sessions
        .filter((s) => s.projectId === p.id)
        .sort(
          (a, b) =>
            Number(b.needsReview) - Number(a.needsReview) ||
            (b.status === "running") - (a.status === "running") ||
            b.updatedAt - a.updatedAt,
        )
    : [];
  const path = (p.roots[0] || "").replace(/^\/Users\/[^/]+\//, "~/");
  return `<article class="project-card ${expanded ? "expanded" : ""}" data-state="${tone}" aria-label="${esc(p.name)}"><div class="project-card-heading"><span class="project-icon">${icon("folder")}</span><button class="project-name" title="${esc(p.name)}" data-action="project" data-id="${esc(p.id)}">${esc(p.name)}</button><button class="icon-btn pin ${p.pinned ? "pinned" : ""}" data-action="pin" data-id="${esc(p.id)}" aria-label="${p.pinned ? "取消置顶" : "置顶"} ${esc(p.name)}" title="${p.pinned ? "取消置顶" : "置顶"}">${icon("pin")}</button></div><span class="project-path" title="${esc(p.roots.join("\n"))}">${esc(path)}</span><div class="project-metrics">${projectMetric(p, p.running, "进行中", "running", "sessions", "running")}${projectMetric(p, p.unreadKnown === false ? null : p.unread, "未读", "unread", "sessions", "unread")}${projectMetric(p, p.todoCount, "待办", "todos", "todos")}${projectMetric(p, p.sessionCount, "会话", "session-count", "sessions")}</div><div class="project-card-footer"><time class="project-updated" title="最近活动">${p.updatedAt ? relative(p.updatedAt) : "—"}</time><div class="project-actions"><button class="icon-btn" data-action="new-todo" data-project="${esc(p.id)}" aria-label="为 ${esc(p.name)} 添加待办" title="添加待办">${icon("plus")}</button><button class="icon-btn expand-toggle" id="expand-${esc(p.id)}" data-action="expand-project" data-id="${esc(p.id)}" aria-label="${expanded ? "收起" : "展开"} ${esc(p.name)} 的会话" title="${expanded ? "收起会话" : "展开会话"}" aria-expanded="${expanded}" aria-controls="project-sessions-${esc(p.id)}">${icon(expanded ? "chevron-up" : "chevron-down")}</button></div></div><section class="project-sessions" id="project-sessions-${esc(p.id)}" aria-label="${esc(p.name)} 的会话" ${expanded ? "" : "hidden"}>${expanded ? `${sessions.length ? sessions.slice(0, 4).map(projectSessionRow).join("") : '<p class="inline-empty">暂无会话</p>'}<div class="project-sessions-footer"><button class="text-btn" data-action="project" data-id="${esc(p.id)}">全部会话 <span>${p.sessionCount}</span>${icon("arrow-right")}</button></div>` : ""}</section></article>`;
}
function projectSessionRow(s) {
  return `<article class="project-session"><div class="project-session-heading"><button class="project-session-title" data-action="open" data-id="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</button><button class="icon-btn" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(s.title)}" title="关联待办">${icon("plus")}</button></div><div class="project-session-meta">${badge(s)}<time>${agentLabel(s) ? `${esc(agentLabel(s))} · ` : ""}${relative(s.updatedAt)}</time></div></article>`;
}
function empty(title, iconName = "inbox") {
  return `<div class="empty-state">${icon(iconName)}<p>${title}</p></div>`;
}
function controls(tabs, placeholder, extra = "") {
  return `<div class="controls"><div class="tabs" role="group" aria-label="筛选">${tabs.map(([v, t]) => `<button data-action="filter" data-filter="${v}" class="${state.filter === v ? "active" : ""}" aria-pressed="${state.filter === v}">${t}</button>`).join("")}</div><div class="control-actions"><label class="search">${icon("search")}<input id="main-search" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(state.query)}"></label>${extra}</div></div>`;
}
function overview() {
  let items = sortedProjects().filter((p) =>
    (p.name + " " + p.roots.join(" "))
      .toLowerCase()
      .includes(state.query.toLowerCase()),
  );
  if (state.filter === "running") items = items.filter((p) => p.running);
  if (state.filter === "unread") items = items.filter((p) => p.unread);
  if (state.filter === "pinned") items = items.filter((p) => p.pinned);
  return `${controls(
    [
      ["all", "全部"],
      ["running", "进行中"],
      ["unread", "完成未读"],
      ["pinned", "已置顶"],
    ],
    "搜索项目",
  )}${items.length ? `<section class="project-grid" aria-label="项目列表">${items.map(projectCard).join("")}</section>` : empty("暂无匹配项目", "folder-search")}`;
}
function sessionRow(s) {
  return `<article class="session-row"><span class="dot ${s.needsReview ? "unread" : esc(s.status)}"></span><div class="session-main"><button data-action="open" data-id="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</button><p>${esc(pname(s.projectId))}${agentLabel(s) ? `<span> · ${esc(agentLabel(s))}</span>` : ""}<span> · ${relative(s.updatedAt)}</span></p></div>${badge(s)}<button class="icon-btn" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(s.title)}" title="关联待办">${icon("plus")}</button></article>`;
}
function sessionsView() {
  const attention = state.view === "attention";
  let items = state.data.sessions.filter(
    (s) =>
      (!state.project || s.projectId === state.project) &&
      (s.title + " " + pname(s.projectId))
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
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return `${controls(
    attention
      ? [
          ["all", "完成未读"],
          ["failed", "运行失败"],
        ]
      : [
          ["all", "全部"],
          ["running", "进行中"],
          ["unread", "未读"],
          ["completed", "本轮完成"],
          ["unknown", "未知"],
        ],
    "搜索会话",
  )}${items.length ? `<div class="list-surface">${items.slice(0, state.limit).map(sessionRow).join("")}</div>${items.length > state.limit ? '<button class="more-btn" data-action="more">加载更多</button>' : ""}` : empty(attention ? (state.filter === "failed" ? "暂无失败会话" : state.data.source.readStateAvailable === false ? "阅读状态暂不可用" : "暂无未读结果") : "暂无匹配会话", attention ? "inbox" : "messages-square")}`;
}
function todoItem(t) {
  const overdue = t.dueDate && t.dueDate < today() && t.status !== "done";
  const linkedSession = session(t.sessionId);
  const sessionTitle = linkedSession?.title || "关联会话";
  const canOpenLinkedChat = linkedSession?.agent === "codex" && linkedSession.url;
  const canOpenNewChat = !t.sessionId && project(t.projectId)?.roots.length > 0;
  const canStart = state.data.source.canStartTodoInCodex && t.status === "todo" && (canOpenLinkedChat || canOpenNewChat);
  const startHint = canOpenLinkedChat ? "打开原对话并复制开始指令" : "打开项目的新对话并预填开始指令";
  return `<article class="todo-item">
    <button class="check ${t.status === "done" ? "done" : ""}" data-action="toggle-todo" data-id="${esc(t.id)}" aria-label="${t.status === "done" ? "重新打开" : "完成"}待办：${esc(t.title)}"><span class="check-box">${t.status === "done" ? icon("check") : ""}</span></button>
    <div class="todo-info">
      <button class="todo-title ${t.status === "done" ? "done" : ""}" data-action="edit-todo" data-id="${esc(t.id)}">${esc(t.title)}</button>
      <div class="todo-meta">
        <span class="todo-status">${todoStatuses[t.status]}</span>
        <button data-action="project" data-id="${esc(t.projectId)}">${esc(pname(t.projectId))}</button>
        ${t.sessionId ? `<button class="todo-session-link" data-action="open" data-id="${esc(t.sessionId)}" title="${esc(sessionTitle)}">${icon("link-2")}<span>${esc(sessionTitle)}</span></button>` : ""}
        ${t.priority === "high" ? '<span class="high">优先</span>' : ""}
        ${t.dueDate ? `<span class="${overdue ? "overdue" : ""}">${overdue ? "逾期 " : ""}${esc(t.dueDate.slice(5))}</span>` : ""}
      </div>
    </div>
    ${canStart ? `<button class="secondary todo-start" data-action="start-todo" data-id="${esc(t.id)}" aria-label="开始处理 ${esc(t.title)}" title="${startHint}">开始</button>` : ""}
    <button class="icon-btn" data-action="edit-todo" data-id="${esc(t.id)}" aria-label="编辑待办：${esc(t.title)}" title="编辑">${icon("pencil")}</button>
  </article>`;
}
function todosView() {
  let todos = state.data.todos.filter(
    (t) =>
      (!state.project || t.projectId === state.project) &&
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
      ["all", "未完成"],
      ["high", "优先"],
      ["doing", "进行中"],
      ["done", "已完成"],
    ],
    "搜索待办",
    `<button class="icon-btn" data-action="export" aria-label="导出待办" title="导出待办">${icon("download")}</button>`,
  )}${todos.length ? `<div class="list-surface todo-list">${todos.map(todoItem).join("")}</div>` : empty("暂无待办", "list-todo")}`;
}
function render() {
  PulseBrand.update(state.data, Boolean(state.error));
  const focus = rememberFocus();
  if (!state.data) {
    app.innerHTML = `<div class="boot"><span class="brand-mark boot-logo" aria-label="Project Pulse"></span><p>${esc(state.error || "连接中…")}</p>${state.error ? '<button class="secondary" data-action="refresh">重试</button>' : ""}</div>`;
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
  app.innerHTML = `<div class="shell">${navigation()}<main class="main" aria-label="${esc(viewName)}"><div class="content">${state.error ? `<div class="notice" role="alert">${esc(state.error)} · 显示上次同步数据</div>` : ""}<div class="dashboard-toolbar">${stats()}<div class="toolbar-actions"><button class="icon-btn" data-action="refresh" aria-label="刷新项目状态" title="刷新 · 最近同步：${relative(state.data.source.updatedAt)}">${icon("refresh-cw")}</button><button class="primary" data-action="new-todo" aria-label="添加待办" title="添加待办" ${selectedProject ? `data-project="${esc(selectedProject.id)}"` : ""}>${icon("plus")}<span>添加待办</span></button></div></div><section class="board">${selectedProject ? `<div class="project-context"><button class="icon-btn" data-action="nav" data-view="overview" aria-label="返回项目总览" title="返回项目">${icon("arrow-left")}</button><h1 title="${esc(selectedProject.name)}">${esc(selectedProject.name)}</h1></div>` : ""}${state.view === "overview" ? overview() : state.view === "todos" ? todosView() : sessionsView()}</section></div></main></div>`;
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
function showTodo(id = null, projectId = null, sessionId = null) {
  const t = state.data.todos.find((v) => v.id === id);
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
    `<div class="overlay-backdrop" data-action="close"></div><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="todo-dialog-title"><div class="dialog-head"><h2 id="todo-dialog-title">${t ? "编辑待办" : "添加待办"}</h2><button class="icon-btn" data-action="close" aria-label="关闭待办表单">${icon("x")}</button></div><form id="todo-form" data-id="${esc(t?.id || "")}" novalidate>
    ${fields.textField({ id: "todo-title", name: "title", label: "待办内容", value: t?.title || "", placeholder: "输入待办内容", required: true, autofocus: true })}
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
            label: "状态",
            value: t.status,
            options: Object.entries(todoStatuses).map(([value, text]) => ({ value, text })),
          })
        : ""
    }
    <p class="dialog-error" id="form-error" role="alert"></p><div class="dialog-footer">${t ? `<button type="button" class="secondary" data-action="delete-todo" data-id="${esc(t.id)}">删除</button>` : ""}<button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">${t ? "保存" : "添加"}</button></div></form></section>`,
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
  mountOverlay(
    `<div class="overlay-backdrop" data-action="close"></div><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div class="dialog-head"><h2 id="settings-title" class="settings-title"><span class="brand-mark" aria-hidden="true"></span>连接与数据</h2><button class="icon-btn" data-action="close" aria-label="关闭设置">${icon("x")}</button></div><div class="settings-copy"><span class="source-badge">${icon("shield-check")}本机只读连接</span><p>${esc(state.data.source.scope)}</p><p>项目和会话来自当前电脑的 ${esc((state.data.source.sources || []).filter((s) => s.ok).map((s) => s.label).join("、") || "Codex")}。待办和置顶独立保存。</p><p>点击会话打开原对话：Codex 跳转桌面 App，Claude Code 在终端恢复，其他 agent 复制恢复命令。未读只跟随 Codex 桌面的阅读状态。</p><ul>${state.data.source.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p>不会上传项目和会话，不需要 API Key。请勿将此本机面板公开部署。</p><button class="secondary" data-action="export">${icon("download")}导出待办与项目清单</button></div></section>`,
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
      case "stat":
        route(view, null, filter);
        break;
      case "project":
        route("sessions", id);
        break;
      case "project-view":
        route(view, id, filter);
        break;
      case "expand-project": {
        const wasExpanded = state.expandedProjects.has(id);
        state.expandedProjects.clear();
        if (!wasExpanded) state.expandedProjects.add(id);
        render();
        break;
      }
      case "filter":
        state.filter = filter;
        state.limit = 40;
        render();
        break;
      case "refresh":
        await refresh();
        toast(state.error || "已同步");
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
            toast((await copyText(opened.command)) ? "已复制恢复命令，在终端粘贴运行" : opened.command);
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
      case "start-todo": {
        button.disabled = true;
        const opened = await request("/api/start-todo", { id });
        toast(opened.prefilled
          ? "已请求打开新对话。补充预填指令后发送。"
          : "已复制开始指令。粘贴到原对话，补充要求后发送。");
        button.disabled = false;
        break;
      }
      case "edit-todo":
        showTodo(id);
        break;
      case "toggle-todo": {
        const t = state.data.todos.find((t) => t.id === id);
        button.disabled = true;
        await request("/api/todo", {
          id,
          status: t.status === "done" ? "todo" : "done",
        });
        await refresh();
        toast(t.status === "done" ? "已重新打开" : "已完成");
        break;
      }
      case "delete-todo": {
        button.dataset.action = "confirm-delete";
        button.textContent = "确认删除";
        break;
      }
      case "confirm-delete":
        await request("/api/delete-todo", { id });
        closeOverlay();
        await refresh();
        toast("待办已删除");
        break;
      case "settings":
        settings();
        break;
      case "close":
        closeOverlay();
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
  const closeProject =
    state.expandedProjects.size &&
    !event.target.closest(".project-card.expanded, #overlay");
  if (closeProject) {
    state.expandedProjects.clear();
    // Hide immediately; actionClick can still use the original clicked element.
    document.querySelectorAll(".project-card.expanded").forEach((card) => {
      card.classList.remove("expanded");
      card.querySelector(".project-sessions").hidden = true;
      const toggle = card.querySelector(".expand-toggle");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute(
        "aria-label",
        `展开 ${project(toggle.dataset.id)?.name || "项目"} 的会话`,
      );
      toggle.title = "展开会话";
      toggle.innerHTML = icon("chevron-down");
    });
  }
  actionClick(event);
  if (closeProject) icons();
});
document.addEventListener("input", (event) => {
  if (event.target.id === "todo-title") PulseControls.setError(event.target);
  if (event.target.id === "main-search") {
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
    closeOverlay();
    await refresh();
    toast("待办已保存");
  } catch (e) {
    document.querySelector("#form-error").textContent = e.message;
    button.disabled = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") {
    if (overlay.children.length) closeOverlay();
    else if (state.expandedProjects.size) {
      const id = [...state.expandedProjects][0];
      state.expandedProjects.clear();
      render();
      document.getElementById(`expand-${id}`)?.focus({ preventScroll: true });
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
