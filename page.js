(function () {
 'use strict';
 const nativeFetch = window.fetch.bind(window);
 const pending = new Map();
 const prefix = crypto.randomUUID();
 let sequence = 0;
 window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== 'https://www.twitch.tv') return;
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
   window.postMessage({source: 'twitch-2k-request', id, payload}, 'https://www.twitch.tv');
  });
  if (!result?.ok || typeof result.body !== 'string') throw new Error('Relay unavailable');
  return new Response(result.body, {headers: {'Content-Type': result.contentType, 'Cache-Control': 'no-store'}});
 }
 window.fetch = async function (input, init) {
  try {
   const url = new URL(input instanceof Request ? input.url : String(input), location.href);
   const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
   if (url.origin === 'https://gql.twitch.tv' && url.pathname === '/gql' && method === 'POST') {
    const text = init?.body !== undefined ? (typeof init.body === 'string' ? init.body : null) : input instanceof Request ? await input.clone().text() : null;
    if (text && text.length <= 12000) {
     const body = JSON.parse(text);
     const items = Array.isArray(body) ? body : [body];
     if (items.length > 0 && items.length <= 4 && items.every(item => ['PlaybackAccessToken', 'PlaybackAccessToken_Template'].includes(item?.operationName))) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      return await relay({type: 'gql', body: text, auth: headers.get('Authorization') || ''});
     }
    }
   }
   if (url.origin === 'https://usher.ttvnw.net' && method === 'GET') return await relay({type: 'usher', url: url.href});
  } catch { console.warn('[Twitch 2K] Relay unavailable; using direct playback.'); }
  return nativeFetch(input, init);
 };
})();
