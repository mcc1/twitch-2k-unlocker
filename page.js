// MAIN world, document_start: install before Twitch captures fetch or creates workers.
(function () {
 'use strict';
 const ORIGIN = 'https://www.twitch.tv';
 const pending = new Map();
 const prefix = crypto.randomUUID();
 let sequence = 0;
 window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== ORIGIN) return;
  const msg = event.data;
  if (!msg || msg.source !== 'twitch-2k-response' || !pending.has(msg.id)) return;
  const {resolve, timer} = pending.get(msg.id);
  clearTimeout(timer); pending.delete(msg.id); resolve(msg.result);
 });
 async function relay(payload) {
  if (pending.size >= 8) throw new Error('Busy');
  const id = `${prefix}:${++sequence}`;
  const result = await new Promise((resolve, reject) => {
   const timer = setTimeout(() => { pending.delete(id); reject(new Error('Relay timeout')); }, 13000);
   pending.set(id, {resolve, timer});
   window.postMessage({source: 'twitch-2k-request', id, payload}, ORIGIN);
  });
  if (!result?.ok || typeof result.body !== 'string') throw new Error('Relay unavailable');
  return result;
 }
 // Self-contained so the same interceptor can be installed in a dedicated worker.
 function installFetch(scope, send, base) {
  const nativeFetch = scope.fetch.bind(scope);
  scope.fetch = async function (input, init) {
   try {
    const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) return nativeFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), base);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let payload;
    if (url.origin === 'https://gql.twitch.tv' && url.pathname === '/gql' && method === 'POST') {
     const text = init?.body !== undefined ? (typeof init.body === 'string' ? init.body : null) : input instanceof Request ? await input.clone().text() : null;
     if (text && text.length <= 12000) {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      if (items.length && items.length <= 4 && items.every(item => ['PlaybackAccessToken', 'PlaybackAccessToken_Template'].includes(item?.operationName))) {
       const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
       payload = {type: 'gql', body: text, auth: headers.get('Authorization') || ''};
      }
     }
    } else if (url.origin === 'https://usher.ttvnw.net' && method === 'GET' &&
     /^\/(?:api\/(?:v2\/)?channel\/hls\/[a-zA-Z0-9_]{1,25}|vod\/[0-9]{1,20})\.m3u8$/.test(url.pathname)) {
     payload = {type: 'usher', url: url.href};
    }
    if (payload) {
     // Reading a cloned Request body is asynchronous; abort may have happened
     // while reading it, before an abort listener could be installed.
     if (signal?.aborted) return nativeFetch(input, init);
     const result = signal ? await new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) { abort(); return; }
      (async () => {
       try { resolve(await send(payload)); }
       catch (err) { reject(err); }
       finally { signal.removeEventListener('abort', abort); }
      })();
     }) : await send(payload);
     return new Response(result.body, {headers: {'Content-Type': result.contentType, 'Cache-Control': 'no-store'}});
    }
   } catch { console.warn('[Twitch 2K] Relay unavailable; using direct playback.'); }
   return nativeFetch(input, init);
  };
 }
 installFetch(window, relay, location.href);
 function workerBootstrap(channel, install) {
  const originalPost = self.postMessage.bind(self);
  const waiting = new Map();
  let serial = 0;
  self.addEventListener('message', event => {
   const data = event.data;
   if (!data || data.channel !== channel || data.kind !== 'twitch-2k-result') return;
   event.stopImmediatePropagation();
   const entry = waiting.get(data.id);
   if (!entry) return;
   waiting.delete(data.id); clearTimeout(entry.timer);
   data.result?.ok ? entry.resolve(data.result) : entry.reject(new Error('Relay unavailable'));
  });
  install(self, payload => new Promise((resolve, reject) => {
   if (waiting.size >= 8) { reject(new Error('Busy')); return; }
   const id = ++serial;
   const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Relay timeout')); }, 14000);
   waiting.set(id, {resolve, reject, timer});
   originalPost({channel, kind: 'twitch-2k-relay', id, payload});
  }), 'https://www.twitch.tv/');
 }
 const NativeWorker = window.Worker;
 const NativeXHR = window.XMLHttpRequest;
 if (!NativeWorker || !NativeXHR) return;
 window.Worker = new Proxy(NativeWorker, {
  construct(Target, args, newTarget) {
   const [input, options] = args;
   const url = new URL(String(input), location.href);
   if (url.protocol !== 'blob:' || url.origin !== ORIGIN || options?.type === 'module') return Reflect.construct(Target, args, newTarget);
   // Twitch revokes its loader blob immediately after construction. Copy its small,
   // same-origin classic-worker loader synchronously before that URL is revoked.
   let original;
   try {
    const xhr = new NativeXHR();
    xhr.open('GET', url.href, false); xhr.send();
    if (xhr.status !== 200 || xhr.responseText.length > 1048576) return Reflect.construct(Target, args, newTarget);
    original = xhr.responseText;
   } catch { return Reflect.construct(Target, args, newTarget); }
   const channel = crypto.randomUUID();
   // Import a retained copy as its own script: preserve the original directive
   // prologue ('use strict'), globals and importScripts semantics.
   const loaderUrl = URL.createObjectURL(new Blob([original], {type: 'text/javascript'}));
   const script = `(${workerBootstrap.toString()})(${JSON.stringify(channel)}, ${installFetch.toString()});\ntry { importScripts(${JSON.stringify(loaderUrl)}); } finally { self.postMessage({channel:${JSON.stringify(channel)},kind:'twitch-2k-loaded'}); }`;
   const wrappedUrl = URL.createObjectURL(new Blob([script], {type: 'text/javascript'}));
   let retained = true;
   const cleanup = () => { if (retained) { URL.revokeObjectURL(loaderUrl); retained = false; } };
   let worker;
   try { worker = Reflect.construct(Target, [wrappedUrl, options], newTarget); }
   catch (err) { cleanup(); throw err; }
   finally { URL.revokeObjectURL(wrappedUrl); }
   worker.addEventListener('error', cleanup, {once: true});
   const terminate = worker.terminate;
   worker.terminate = function () { cleanup(); return terminate.call(this); };
   let active = 0;
   worker.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.channel !== channel) return;
    if (data.kind === 'twitch-2k-loaded') { event.stopImmediatePropagation(); cleanup(); return; }
    if (data.kind !== 'twitch-2k-relay') return;
    event.stopImmediatePropagation();
    if (!Number.isSafeInteger(data.id) || active >= 8) return;
    active++;
    (async () => {
     let result;
     try { result = await relay(data.payload); }
     catch { result = {ok: false}; }
     finally { active--; }
     worker.postMessage({channel, kind: 'twitch-2k-result', id: data.id, result});
    })();
   });
   return worker;
  },
 });
})();
