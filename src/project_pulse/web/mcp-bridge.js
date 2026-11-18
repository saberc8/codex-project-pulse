/* MCP Apps standard bridge. This file is included only in the plugin UI resource. */
(() => {
  let serial = 0;
  const pending = new Map();
  const notify = (method, params) => parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('插件面板连接超时，请重新打开插件')); }, 20000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.jsonrpc !== '2.0') return;
    const msg = event.data;
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id); clearTimeout(request.timer);
    if (msg.error) request.reject(new Error(msg.error.message || '插件操作失败'));
    else request.resolve(msg.result);
  });
  const ready = rpc('ui/initialize', {
    appInfo: { name: 'Project Pulse', version: '0.2.2' },
    appCapabilities: {}, protocolVersion: '2026-01-26'
  }).then(() => notify('ui/notifications/initialized', {}));
  // A host may initialize before the main UI asks for data.
  ready.catch(() => {});
  async function tool(name, args = {}) {
    await ready;
    const reply = await rpc('tools/call', { name, arguments: args });
    if (reply.isError) throw new Error(reply.content?.find(c => c.type === 'text')?.text || '插件操作失败');
    if (reply.structuredContent) return reply.structuredContent;
    const value = reply.content?.find(c => c.type === 'text')?.text;
    return value ? JSON.parse(value) : {};
  }
  window.PulseHost = {
    async request(path, body) {
      if (body) return tool('dashboard_action', { action: path.slice('/api/'.length), values: body });
      if (path === '/api/bootstrap') return { token: 'mcp-host', data: await tool('dashboard_snapshot') };
      if (path === '/api/snapshot') return tool('dashboard_snapshot');
      if (path.startsWith('/api/sessions/')) return tool('dashboard_session', { sessionId: decodeURIComponent(path.split('/').pop()) });
      if (path === '/api/export') {
        const data = await tool('dashboard_snapshot');
        return { version: 1, exportedAt: Date.now() / 1000, todos: data.todos, projects: data.projects.map(({id,name,pinned}) => ({id,name,pinned})) };
      }
      throw new Error('未知面板请求');
    }
  };
})();
