// 最小 CDP 客户端：Node >= 22，零依赖
export async function connect(port = 9222, match = /./) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find(t => t.type === 'page' && match.test(t.url)) || list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    } else events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send, events, page, close: () => ws.close() };
}

export async function evaluate(c, expression, awaitPromise = true) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) {
    return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  }
  return { value: r.result.value };
}

export async function waitFor(c, expression, timeout = 15000, interval = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evaluate(c, expression);
    if (r.value) return true;
    await new Promise(res => setTimeout(res, interval));
  }
  return false;
}
