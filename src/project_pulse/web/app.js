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
  draftTodo: "",
  limit: 40,
  restLimit: 8,
  error: "",
  modal: null,
  showDone: false,
  busy: false,
  manualSync: false,
};
let composing = false;
let inflight = null;

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
const sessionTitle = (s) => (s.title || "").trim() || "未命名会话";
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
const recentFailure = (s) => s.status === "failed" && s.updatedAt > Date.now() / 1000 - 86400;
const needsLook = (s) => s.needsReview || recentFailure(s);
const urgentTodo = (t) => t.priority === "high" || (t.dueDate && t.dueDate <= today());

function recentFailedCount(projectId) {
  return state.data.sessions.filter((s) => s.projectId === projectId && !s.needsReview && recentFailure(s)).length;
}

function projectReviewCount(p) {
  return (p.unread || 0) + recentFailedCount(p.id);
}

function sortedProjects() {
  return [...state.data.projects].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (projectReviewCount(b) > 0) - (projectReviewCount(a) > 0) ||
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

function statusState(s) {
  return s.needsReview ? "unread" : s.status || "unknown";
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

async function refresh(initial = false, manual = false, force = false) {
  if (inflight) {
    if (!force && !manual) return inflight;
    await inflight.catch(() => {});
  }
  state.busy = true;
  state.manualSync = manual;
  if (manual) render();
  inflight = (async () => {
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
      inflight = null;
    }
  })();
  return inflight;
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

const legacyFilters = { attention: "review", todos: "todo", sessions: "all", projects: "all" };
const listFilters = ["all", "review", "running", "todo", "done"];

function readRoute() {
  const [view, query] = (location.hash.slice(1) || "overview").split("?");
  const q = new URLSearchParams(query);
  const nextProject = q.get("project");
  if (nextProject !== state.project) state.draftTodo = "";
  state.view = "overview";
  state.project = nextProject;
  const filter = q.get("filter") || legacyFilters[view] || "all";
  state.filter = listFilters.includes(filter) ? filter : "all";
  state.query = "";
  state.limit = 40;
  state.restLimit = 8;
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
  const hasBadge =
    !state.error && d.unreadBadge?.known && d.unreadBadge.count > 0;
  return `<header class="top-nav"><button class="brand-home" data-action="nav" data-view="overview" title="${hasBadge ? `${d.unreadBadge.count} 个未读会话` : "回到总览"}"><span class="nav-brand" aria-hidden="true"><span class="brand-mark"></span>${hasBadge ? '<span class="unread-indicator"></span>' : ""}</span><span class="brand-wordmark">Project Pulse</span></button><div class="header-actions"><span class="sync-label" title="最近同步时间">${relative(d.source.updatedAt)}同步</span><button class="icon-btn ${state.manualSync ? "spinning" : ""}" data-action="refresh" aria-label="刷新项目状态" title="刷新 (R)">${icon("refresh-cw")}</button><button class="icon-btn" data-action="settings" aria-label="连接与数据设置" title="连接与数据">${icon("sliders-horizontal")}</button><button class="primary" data-action="new-todo" aria-label="新建待办" title="新建待办 (N)" ${state.project ? `data-project="${esc(state.project)}"` : ""}>${icon("plus")}<span>新建待办</span></button></div></header>`;
}

function projectMasthead(p) {
  const path = (p.roots[0] || "").replace(/^\/Users\/[^/]+\//, "~/");
  return `<section class="project-masthead" aria-label="当前项目"><div class="project-masthead-main"><button class="back-btn" data-action="project-view" data-filter="${esc(state.filter)}" aria-label="返回总览">${icon("arrow-left")}<span>返回总览</span></button><div class="project-masthead-titles"><h1 title="${esc(p.name)}">${esc(p.name)}</h1><span class="project-masthead-path" title="${esc(p.roots.join("\n"))}">${esc(path)}</span></div><button class="icon-btn pin ${p.pinned ? "pinned" : ""}" data-action="pin" data-id="${esc(p.id)}" aria-label="${p.pinned ? "取消置顶" : "置顶"} ${esc(p.name)}" title="${p.pinned ? "取消置顶" : "置顶"}">${icon("pin")}</button></div></section>`;
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

function sessionTags(s) {
  if (s.needsReview) return '<span class="tag blue">新结果</span>';
  if (s.status === "failed") return '<span class="tag red">运行失败</span>';
  if (s.status === "running") return '<span class="tag teal">运行中</span>';
  return `<span class="tag grey">${esc(labels[s.status] || "状态未知")}</span>`;
}

function todoTags(t) {
  const done = t.status === "done";
  if (done) return '<span class="tag grey">已完成</span>';
  const due = !t.dueDate
    ? ""
    : t.dueDate === today()
      ? '<span class="tag red">今天到期</span>'
      : t.dueDate < today()
        ? `<span class="tag red">逾期 ${esc(t.dueDate.slice(5))}</span>`
        : "";
  return `<span class="tag orange">${t.status === "doing" ? "进行中" : "待办"}</span>${t.priority === "high" ? '<span class="tag orange-solid">高优先</span>' : ""}${due}`;
}

function listModel() {
  const d = state.data;
  const inProject = (x) => !state.project || x.projectId === state.project;
  const q = state.query.toLowerCase();
  const matches = (text, projectId) => {
    if (!q) return true;
    const roots = project(projectId)?.roots.join(" ") || "";
    return (text + " " + pname(projectId) + " " + roots).toLowerCase().includes(q);
  };
  const sessions = d.sessions.filter((s) => inProject(s) && matches(s.title + " " + (s.agentLabel || ""), s.projectId));
  const todos = d.todos.filter((t) => inProject(t) && matches(t.title, t.projectId));
  const open = sortedTodos(todos.filter((t) => t.status !== "done"));
  const byTime = (a, b) => b.updatedAt - a.updatedAt;
  const look = sessions.filter(needsLook).sort(byTime);
  const running = sessions.filter((s) => !needsLook(s) && s.status === "running").sort(byTime);
  const completed = sessions.filter((s) => !needsLook(s) && s.status === "completed").sort(byTime);
  const rest = sessions.filter((s) => !needsLook(s) && s.status !== "running").sort(byTime);
  const S = (s) => ["s", s];
  const T = (t) => ["t", t];
  return {
    all: [
      ...look.map(S),
      ...open.filter(urgentTodo).map(T),
      ...running.map(S),
      ...open.filter((t) => !urgentTodo(t)).map(T),
      ...rest.map(S),
    ],
    review: look.map(S),
    running: running.map(S),
    todo: open.map(T),
    done: completed.map(S),
    doneTodos: todos
      .filter((t) => t.status === "done")
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .map(T),
  };
}

function emptyText(filter) {
  return {
    all: "这里还没有会话或待办",
    review: state.data.source.readStateAvailable === false ? "无法读取桌面未读状态" : "没有待查看的结果",
    running: "没有正在运行的会话",
    todo: "没有待办",
    done: "最近没有完成的会话",
  }[filter];
}

function inbox() {
  const m = listModel();
  const f = state.filter;
  const items = m[f] || m.all;
  const globalReview = state.data.sessions.filter(needsLook).length;
  const globalRunning = state.data.sessions.filter((s) => !needsLook(s) && s.status === "running").length;
  const urgent = globalReview + activeTodos().length;
  const headline = state.project
    ? ""
    : `<h1 class="headline">${
        urgent ? `有 ${urgent} 件事等你处理` : globalRunning ? `${globalRunning} 个会话正在运行` : "没有要你处理的事"
      }</h1>`;
  const tabs = [
    ["all", "全部", m.all.length],
    ["review", "待查看", m.review.length, "unread"],
    ["running", "运行中", m.running.length, "running"],
    ["todo", "待办", m.todo.length, "todo"],
    ["done", "最近完成", m.done.length],
  ];
  const doneTodos =
    f === "todo" && m.doneTodos.length
      ? `<button class="list-more" data-action="toggle-done" aria-expanded="${state.showDone}"><span>已完成的待办 ${m.doneTodos.length}</span>${icon(state.showDone ? "chevron-up" : "chevron-down")}</button>${
          state.showDone ? `<ul class="card-rows">${m.doneTodos.slice(0, 30).map(detailRow).join("")}</ul>` : ""
        }`
      : "";
  const bar = controls(tabs, state.project ? "搜索这个项目的会话或待办" : "搜索项目、会话或待办");
  if (!state.project) return `${headline}${bar}${projectBoard(items, f)}`;
  const quickAdd = `<form id="quick-add" class="quick-add" autocomplete="off">${icon("plus")}<input id="quick-add-input" name="title" maxlength="240" value="${esc(state.draftTodo)}" placeholder="输入待办，回车创建" aria-label="快速添加待办"><button class="primary" type="submit">添加</button></form>`;
  if (f === "all") {
    const rest = items.filter(([k, x]) => k === "s" && !needsLook(x) && x.status !== "running");
    const groupCard = ([title, target, list]) => {
      const open = target !== "";
      const cap = open ? 6 : state.restLimit;
      const more = list.length - Math.min(list.length, cap);
      return `<section class="detail-group"><header class="group-head"><h2>${title}<span class="group-count">${list.length}</span></h2>${
        open && more > 0 ? `<button class="text-btn" data-action="filter" data-filter="${target}">还有 ${more} 条${icon("arrow-right")}</button>` : ""
      }</header>${target === "todo" ? quickAdd : ""}<ul class="card-rows">${list.slice(0, cap).map(detailRow).join("")}</ul>${
        !open && more > 0
          ? `<button class="list-more" data-action="more-rest"><span>再显示 ${Math.min(40, more)} 条（共 ${list.length}）</span>${icon("chevron-down")}</button>`
          : ""
      }</section>`;
    };
    const groups = [
      ["待查看", "review", m.review],
      ["运行中", "running", m.running],
      ["待办", "todo", m.todo],
      ["其他会话", "", rest],
    ].filter(([, , l]) => l.length);
    return `${bar}<div class="detail-groups">${
      groups.length ? groups.map(groupCard).join("") : `<div class="detail-card"><p class="card-empty">${emptyText(f)}</p></div>`
    }</div>`;
  }
  return `${bar}${f === "todo" ? quickAdd : ""}<div class="detail-card">${
    items.length
      ? `<ul class="card-rows">${items.slice(0, state.limit).map(detailRow).join("")}</ul>`
      : `<p class="card-empty">${emptyText(f)}</p>`
  }${
    items.length > state.limit
      ? `<button class="list-more" data-action="more"><span>再显示 ${Math.min(40, items.length - state.limit)} 项（共 ${items.length}）</span>${icon("chevron-down")}</button>`
      : ""
  }${doneTodos}</div>`;
}

function projectSignals(p) {
  const failed = recentFailedCount(p.id);
  const signals = [
    [p.unread, "unread", "待查看", "review"],
    [failed, "failed", "运行失败", "review"],
    [p.running, "running", "运行中", "running"],
    [p.todoCount, "todo", "待办", "todo"],
  ].filter(([n]) => n > 0);
  return signals.length
    ? `<div class="signals">${signals
        .map(
          ([n, tone, label, filter]) =>
            `<button class="signal ${tone}" data-action="project-view" data-id="${esc(p.id)}" data-filter="${filter}">${n} ${label}</button>`,
        )
        .join("")}</div>`
    : "";
}

function pinButton(p) {
  return `<button class="icon-btn pin ${p.pinned ? "pinned" : ""}" data-action="pin" data-id="${esc(p.id)}" aria-label="${p.pinned ? "取消置顶" : "置顶"} ${esc(p.name)}" title="${p.pinned ? "取消置顶" : "置顶"}">${icon("pin")}</button>`;
}

function cardRow([kind, item]) {
  if (kind === "t") {
    const extra = todoTags(item).replace(/<span class="tag orange">[^<]*<\/span>/, "");
    return `<li class="card-row is-todo"><button class="check" data-action="toggle-todo" data-id="${esc(item.id)}" aria-label="完成待办：${esc(item.title)}" title="完成"><span class="check-box"></span></button><button class="card-row-title" data-action="edit-todo" data-id="${esc(item.id)}" title="编辑待办">${esc(item.title)}</button>${extra}</li>`;
  }
  const s = item;
  const tone = s.needsReview ? "unread" : recentFailure(s) ? "failed" : s.status === "running" ? "running" : "";
  const dotLabel = s.needsReview ? "新结果" : labels[s.status] || "状态未知";
  return `<li class="card-row ${tone ? `is-${tone}` : ""}"><span class="status-dot ${esc(tone || "idle")}" role="img" aria-label="${esc(dotLabel)}" title="${esc(dotLabel)}"></span><button class="card-row-title" data-action="open" data-id="${esc(s.id)}" title="打开对话：${esc(sessionTitle(s))}">${esc(sessionTitle(s))}</button>${tone ? sessionTags(s) : ""}<span class="row-end"><time>${relative(s.updatedAt)}</time><button class="icon-btn row-add" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(sessionTitle(s))}" title="关联待办">${icon("plus")}</button></span></li>`;
}

function detailRow([kind, item]) {
  if (kind === "t") {
    const t = item;
    const done = t.status === "done";
    const dueTime = t.dueDate && t.dueDate > today() && !done ? `<time>截止 ${esc(t.dueDate.slice(5))}</time>` : "";
    const sessionBtn = t.sessionId
      ? `<button class="icon-btn row-add" data-action="open" data-id="${esc(t.sessionId)}" title="打开关联会话：${esc(session(t.sessionId)?.title || "关联会话")}" aria-label="打开关联会话">${icon("message-square")}</button>`
      : "";
    return `<li class="card-row is-todo ${done ? "is-done" : ""}"><button class="check ${done ? "done" : ""}" data-action="toggle-todo" data-id="${esc(t.id)}" aria-label="${done ? "重新打开" : "完成"}待办：${esc(t.title)}" title="${done ? "重新打开" : "完成"}"><span class="check-box">${done ? icon("check") : ""}</span></button><button class="card-row-title" data-action="edit-todo" data-id="${esc(t.id)}" title="编辑待办">${esc(t.title)}</button>${todoTags(t)}${
      dueTime || sessionBtn ? `<span class="row-end ${dueTime && !sessionBtn ? "keep-time" : ""}">${dueTime}${sessionBtn}</span>` : ""
    }</li>`;
  }
  const s = item;
  const agent = agentLabel(s);
  const tone = s.needsReview ? "unread" : s.status === "failed" ? "failed" : s.status === "running" ? "running" : "";
  const dotLabel = s.needsReview ? "新结果" : labels[s.status] || "状态未知";
  return `<li class="card-row ${tone ? `is-${tone}` : ""}"><span class="status-dot ${esc(tone || "idle")}" role="img" aria-label="${esc(dotLabel)}" title="${esc(dotLabel)}"></span><button class="card-row-title" data-action="open" data-id="${esc(s.id)}" title="打开对话：${esc(sessionTitle(s))}">${esc(sessionTitle(s))}</button>${sessionTags(s)}${agent ? `<span class="row-agent">${esc(agent)}</span>` : ""}<span class="row-end"><time>${relative(s.updatedAt)}</time><button class="icon-btn row-add" data-action="new-todo" data-project="${esc(s.projectId)}" data-session="${esc(s.id)}" aria-label="关联待办：${esc(sessionTitle(s))}" title="关联待办">${icon("plus")}</button></span></li>`;
}

function projectCard(p, rows, more) {
  const failed = recentFailedCount(p.id);
  const tone = p.unread ? "unread" : failed ? "failed" : p.running ? "running" : p.todoCount ? "todo" : "quiet";
  const path = (p.roots[0] || "").replace(/^\/Users\/[^/]+\//, "~/");
  return `<article class="project-card" data-state="${tone}" aria-label="${esc(p.name)}"><header class="card-head"><h2><button class="project-name" data-action="project-view" data-id="${esc(p.id)}" data-filter="${esc(state.filter)}" title="进入 ${esc(p.name)}">${esc(p.name)}</button></h2>${projectSignals(p)}${pinButton(p)}</header><span class="project-path" title="${esc(p.roots.join("\n"))}">${esc(path)}</span>${
    rows.length ? `<ul class="card-rows">${rows.map(cardRow).join("")}</ul>` : '<p class="card-empty">暂无会话</p>'
  }<footer class="card-foot"><span>${more > 0 ? `还有 ${more} 条` : p.sessionCount ? `${p.sessionCount} 条会话 · ${relative(p.updatedAt)}` : "暂无动态"}</span><button class="icon-btn" data-action="new-todo" data-project="${esc(p.id)}" aria-label="为 ${esc(p.name)} 添加待办" title="添加待办">${icon("plus")}</button><button class="text-btn" data-action="project-view" data-id="${esc(p.id)}" data-filter="${esc(state.filter)}">全部${icon("arrow-right")}</button></footer></article>`;
}

function projectBoard(items, f) {
  const groups = new Map();
  items.forEach((entry) => {
    const id = entry[1].projectId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  });
  const q = state.query.toLowerCase();
  let projects = [...groups.keys()].map(project).filter(Boolean);
  if (f === "all")
    projects.push(
      ...sortedProjects().filter(
        (p) => !groups.has(p.id) && (!q || (p.name + " " + p.roots.join(" ")).toLowerCase().includes(q)),
      ),
    );
  projects.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  if (!projects.length) return empty(emptyText(f), f === "todo" ? "check-square" : "inbox");
  return `<div class="project-grid">${projects
    .map((p) => {
      const list = groups.get(p.id) || [];
      const busy = projectReviewCount(p) > 0 || p.running || p.todoCount || p.pinned || f !== "all";
      const rows = list.slice(0, busy ? 3 : 1);
      return projectCard(p, rows, list.length - rows.length);
    })
    .join("")}</div>`;
}

function empty(title, iconName = "inbox") {
  return `<div class="empty-state">${icon(iconName)}<p>${title}</p></div>`;
}

function render() {
  PulseBrand.update(state.data, Boolean(state.error));
  const focus = rememberFocus();
  if (!state.data) {
    app.innerHTML = `<div class="boot"><span class="brand-mark boot-logo" aria-label="Project Pulse"></span><p>${esc(state.error || "正在读取本机项目状态…")}</p>${state.error ? '<button class="secondary" data-action="refresh">重试连接</button>' : ""}</div>`;
    icons();
    return;
  }
  const viewName = state.project ? pname(state.project) : "总览";
  const selectedProject = project(state.project);
  app.innerHTML = `<div class="shell">${navigation()}<main class="main" aria-label="${esc(viewName)}"><div class="content">${state.error ? `<div class="notice" role="alert">${esc(state.error)} · 当前展示上次同步结果</div>` : ""}<section class="board">${selectedProject ? projectMasthead(selectedProject) : ""}${inbox()}</section></div></main></div>`;
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
    `<div class="overlay-backdrop" data-action="close"></div><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="todo-dialog-title"><div class="dialog-head"><h2 id="todo-dialog-title">${t ? "编辑待办" : "新建待办"}</h2><button class="icon-btn" data-action="close" aria-label="关闭待办表单">${icon("x")}</button></div><form id="todo-form" data-id="${esc(t?.id || "")}" novalidate>
    ${fields.textField({ id: "todo-title", name: "title", label: "待办内容", value: t?.title || "", placeholder: "例如：压测新接口并回归边界用例", required: true, autofocus: true })}
    ${fields.selectField({ id: "todo-project", name: "projectId", label: "项目", value: selected, options: [{ value: "", text: "选择项目" }, ...projects], placeholder: "选择项目", searchable: true, required: true })}
    ${fields.selectField({ id: "todo-session", name: "sessionId", label: "关联会话", value: selectedSession, options: sessionOptions(selected, selectedSession), placeholder: selected ? "只绑定项目" : "先选择项目", searchable: true, optional: true, disabled: !selected })}
    <div class="form-row">${fields.segmentedField({
      id: "todo-priority",
      name: "priority",
      label: "优先级",
      value: t?.priority || "normal",
      options: [
        { value: "low", text: "低" },
        { value: "normal", text: "普通" },
        { value: "high", text: "高" },
      ],
    })}${fields.dateField({ id: "todo-due", name: "dueDate", label: "截止日期", value: t?.dueDate || "" })}</div>
    ${
      t
        ? fields.segmentedField({
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
    <p class="dialog-error" id="form-error" role="alert"></p><div class="dialog-footer">${t ? `<button type="button" class="secondary" data-action="delete-todo" data-id="${esc(t.id)}">删除</button>` : ""}<button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">${t ? "保存修改" : "新建待办"}</button></div></form></section>`,
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
  return projectId ? [{ value: "", text: "不关联会话" }, ...choices] : choices;
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
        route("overview", id, state.filter);
        break;
      case "project-view":
        route("overview", id, filter || "all");
        break;
      case "toggle-done":
        state.showDone = !state.showDone;
        render();
        break;
      case "filter": {
        state.filter = filter;
        state.limit = 40;
        state.restLimit = 8;
        const params = new URLSearchParams();
        if (state.project) params.set("project", state.project);
        if (filter !== "all") params.set("filter", filter);
        history.replaceState(null, "", `#overview${params.size ? `?${params}` : ""}`);
        render();
        break;
      }
      case "clear-search":
        state.query = "";
        state.limit = 40;
        render();
        document.querySelector("#main-search")?.focus();
        break;
      case "refresh":
        await refresh(false, true, true);
        toast(state.error || "已同步最新状态");
        break;
      case "pin":
        await request("/api/pin", { id, pinned: !project(id)?.pinned });
        await refresh(false, false, true);
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
        await refresh(false, false, true);
        toast(t.status === "done" ? "待办已重新打开" : "待办已完成");
        break;
      }
      case "delete-todo":
        button.dataset.action = "confirm-delete";
        button.textContent = "确认删除";
        break;
      case "confirm-delete":
        await request("/api/delete-todo", { id });
        await refresh(false, false, true);
        closeOverlay();
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
      case "more-rest":
        state.restLimit += 40;
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
  if (event.target.id === "main-search" || event.target.id === "quick-add-input")
    composing = true;
});

document.addEventListener("compositionend", (event) => {
  if (event.target.id === "quick-add-input") {
    composing = false;
    state.draftTodo = event.target.value;
  }
  if (event.target.id === "main-search") {
    composing = false;
    state.query = event.target.value;
    state.limit = 40;
    render();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "todo-title") PulseControls.setError(event.target);
  if (event.target.id === "quick-add-input") state.draftTodo = event.target.value;
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
  if (event.target.id === "quick-add") {
    event.preventDefault();
    if (composing) return;
    const input = event.target.elements.namedItem("title");
    const title = input.value.trim();
    if (!title) return;
    input.disabled = true;
    try {
      await request("/api/todo", {
        title,
        projectId: state.project,
        priority: "normal",
        status: "todo",
      });
      state.draftTodo = "";
      await refresh(false, false, true);
      document.querySelector("#quick-add-input")?.focus();
      toast("待办已创建");
    } catch (e) {
      input.disabled = false;
      toast(e.message);
    }
    return;
  }
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
    await refresh(false, false, true);
    closeOverlay();
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
      closeOverlay();
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
      route("overview", state.project, "todo");
    } else if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      showTodo(null, state.project);
    } else if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      refresh(false, true, true).then(() => toast(state.error || "已同步最新状态"));
    }
  }
});

window.addEventListener("hashchange", () => {
  readRoute();
  render();
  window.scrollTo({ top: 0 });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !composing) refresh();
});

readRoute();
refresh(true);
setInterval(() => {
  if (!document.hidden && !composing) refresh();
}, 8000);
