// FOR TESTS: injected into every page before its scripts, like WKWebView injects its message handler: the bridge to the fake native
// side (worker.mjs). Also reports every API answer >= 500 of the app host as a console line the test collects (in app mode no request
// goes over the network, so the page's response events see nothing).
(() => {
  const worker = new SharedWorker('/__fake/worker.mjs', { type: 'module', name: 'mahlwerk-native' });
  const pending = new Map();
  let next = 1;
  worker.port.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
  };
  worker.port.start();
  // the page goes (reload, navigation, close): its transaction, if one is open, is rolled back, its waiting ops are dropped
  addEventListener('pagehide', () => worker.port.postMessage({ bye: true }));
  const postMessage = (msg) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.port.postMessage({ id, msg });
  });
  window.webkit = { messageHandlers: { mahlwerkNative: { postMessage } } };
  let local;
  Object.defineProperty(window, 'mahlwerkLocal', {
    configurable: true,
    get: () => local,
    set(f) {
      local = async (url, init) => {
        const r = await f(url, init);
        if (r.status >= 500) console.error(`MW-5XX HTTP ${r.status} ${init?.method ?? 'GET'} ${url}`);
        return r;
      };
    },
  });
})();
