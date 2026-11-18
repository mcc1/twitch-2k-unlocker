// Private metadata relay. Set RELAY_SECRET with `wrangler secret put`.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TOKEN_QUERY = `query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
 streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }
 videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature }
}`;
const HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
class RelayError extends Error {
 constructor(status, message) { super(message); this.status = status; }
}
function reject(condition, message) { if (condition) throw new RelayError(400, message); }
export async function readLimited(message, limit) {
 if (!message.body) return '';
 const reader = message.body.getReader();
 const chunks = [];
 let size = 0;
 try {
  while (true) {
   const {done, value} = await reader.read();
   if (done) break;
   size += value.byteLength;
   if (size > limit) { await reader.cancel(); throw new RelayError(413, 'Body too large'); }
   chunks.push(value);
  }
 } finally { reader.releaseLock(); }
 const bytes = new Uint8Array(size);
 let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
 return new TextDecoder().decode(bytes);
}
export function usherUrl(value) {
 reject(typeof value !== 'string' || value.length > 12000, 'Invalid playlist URL');
 let url;
 try { url = new URL(value); } catch { throw new RelayError(400, 'Invalid playlist URL'); }
 reject(url.protocol !== 'https:' || url.hostname !== 'usher.ttvnw.net' || url.port !== '' ||
  url.username !== '' || url.password !== '' || url.hash !== '' ||
  !/^\/(?:api\/channel\/hls\/[a-zA-Z0-9_]{1,25}|vod\/[0-9]{1,20})\.m3u8$/.test(url.pathname), 'Invalid playlist URL');
 return url.href;
}
export function tokenBody(body) {
 reject(typeof body !== 'string' || body.length > 12000, 'Invalid token body');
 let parsed;
 try { parsed = JSON.parse(body); } catch { throw new RelayError(400, 'Invalid token JSON'); }
 const batch = Array.isArray(parsed);
 const items = batch ? parsed : [parsed];
 reject(items.length === 0 || items.length > 4, 'Invalid token batch');
 const operations = items.map(item => {
  reject(!item || !['PlaybackAccessToken', 'PlaybackAccessToken_Template'].includes(item.operationName), 'Unsupported operation');
  const v = item.variables;
  reject(!v || typeof v.isLive !== 'boolean' || typeof v.isVod !== 'boolean' || v.isLive === v.isVod, 'Invalid token variables');
  reject(v.isLive && (typeof v.login !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(v.login)), 'Invalid channel');
  reject(v.isVod && (typeof v.vodID !== 'string' || !/^[0-9]{1,20}$/.test(v.vodID)), 'Invalid VOD');
  reject(typeof v.playerType !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(v.playerType), 'Invalid player type');
  // Rebuild the operation: never forward untrusted queries, hashes or extra variables.
  return {operationName: 'PlaybackAccessToken', query: TOKEN_QUERY, variables: {
   isLive: v.isLive, isVod: v.isVod, login: v.isLive ? v.login : '', vodID: v.isVod ? v.vodID : '', playerType: v.playerType,
  }};
 });
 return JSON.stringify(batch ? operations : operations[0]);
}
function json(value, status) {
 return new Response(JSON.stringify(value), {status, headers: {...HEADERS, 'Content-Type': 'application/json'}});
}
export default {
 async fetch(request, env = {}) {
  // Location diagnostics only. Never log request bodies, URLs or credentials.
  console.info('[Twitch relay location]', {
   ingressColo: request.cf?.colo ?? null,
   placement: request.headers.get('cf-placement'),
  });
  // No CORS grant: the extension background fetches with an explicit host permission.
  if (request.method !== 'POST') return new Response(null, {status: 405, headers: {...HEADERS, Allow: 'POST'}});
  if (typeof env.RELAY_SECRET !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(env.RELAY_SECRET)) return json({error: 'Relay not configured'}, 503);
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 256) return json({error: 'Unauthorized'}, 401);
  const hash = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(supplied), hash(`Bearer ${env.RELAY_SECRET}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) return json({error: 'Unauthorized'}, 401);
  try {
   if (typeof env.RELAY_RATE_LIMITER?.limit !== 'function') return json({error: 'Rate limiter not configured'}, 503);
   const {success} = await env.RELAY_RATE_LIMITER.limit({key: 'private-relay'});
   if (!success) return json({error: 'Rate limit exceeded'}, 429);
   let payload;
   try { payload = JSON.parse(await readLimited(request, 16384)); }
   catch (err) { if (err instanceof RelayError) throw err; throw new RelayError(400, 'Invalid JSON'); }
   reject(!payload || typeof payload !== 'object' || Array.isArray(payload), 'Invalid payload');
   let url, init, contentType;
   if (payload.type === 'usher') {
    url = usherUrl(payload.url);
    init = {method: 'GET'};
    contentType = 'application/vnd.apple.mpegurl';
   } else if (payload.type === 'gql') {
    const body = tokenBody(payload.body);
    const headers = {'Content-Type': 'application/json', 'Client-ID': CLIENT_ID};
    reject(payload.auth !== undefined && typeof payload.auth !== 'string', 'Invalid Twitch authorization');
    if (payload.auth) {
     reject(!/^OAuth [a-zA-Z0-9]{1,256}$/.test(payload.auth), 'Invalid Twitch authorization');
     headers.Authorization = payload.auth;
    }
    url = 'https://gql.twitch.tv/gql';
    init = {method: 'POST', headers, body};
    contentType = 'application/json';
   } else { throw new RelayError(400, 'Unknown request type'); }
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), 10000);
   try {
    const resp = await fetch(url, {...init, redirect: 'manual', signal: controller.signal, cache: 'no-store'});
    if (!resp.ok) { await resp.body?.cancel(); throw new RelayError(502, 'Upstream request rejected'); }
    const body = await readLimited(resp, 262144);
    if (payload.type === 'usher' && !body.trimStart().startsWith('#EXTM3U')) throw new RelayError(502, 'Invalid upstream playlist');
    if (payload.type === 'gql') {
     try { JSON.parse(body); } catch { throw new RelayError(502, 'Invalid upstream response'); }
    }
    return new Response(body, {headers: {...HEADERS, 'Content-Type': contentType}});
   } finally { clearTimeout(timer); }
  } catch (err) {
   return json({error: err instanceof RelayError ? err.message : 'Relay request failed'}, err instanceof RelayError ? err.status : 502);
  }
 },
};
