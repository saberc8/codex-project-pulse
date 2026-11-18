const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('a pending todo with only a project exposes Start in the todo list', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/project_pulse/web/app.js'), 'utf8');
  const snapshot = {
    source: { canStartTodoInCodex: true },
    projects: [{ id: 'p1', name: 'Example', roots: ['/work/app'] }],
    sessions: [],
    todos: [{ id: 't1', projectId: 'p1', title: 'Plan export', sessionId: null, status: 'todo' }],
  };
  const context = vm.createContext({
    document: { querySelector: () => ({}), addEventListener() {}, body: { style: {} } },
    window: { addEventListener() {}, PulseHost: { request: () => new Promise(() => {}) } },
    location: { hash: '#todos' },
    PulseControls: { destroy() {} },
    URLSearchParams,
    setInterval() {},
    snapshot,
  });
  vm.runInContext(source, context);
  const html = vm.runInContext('state.data = snapshot; todosView();', context);

  assert.match(html, /data-action="start-todo" data-id="t1"/);
});
