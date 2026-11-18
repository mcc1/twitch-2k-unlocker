import {usherUrl, tokenBody, readLimited} from './worker.js';

// Content scripts must not read stored relay credentials.
const storageReady = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
export function relayEndpoint(value) {
 const url = new URL(value);
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use a trusted HTTPS Worker URL without credentials, query or fragment.');
 return url.href;
}
function isPopup(sender) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html'); }
function isTwitch(sender) {
 try { return sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && new URL(sender.url).origin === 'https://www.twitch.tv'; }
 catch { return false; }
}
async function badge(enabled) {
 await chrome.action.setBadgeText({text: enabled ? 'ON' : ''});
 await chrome.action.setBadgeBackgroundColor({color: '#9147FF'});
}
async function handle(msg, sender) {
 await storageReady;
 if (!msg || typeof msg !== 'object') throw new Error('Invalid message');
 if (isPopup(sender)) {
  if (msg.action === 'getStatus') return await chrome.storage.local.get(['enabled', 'proxyUrl', 'relaySecret', 'forwardAuth']);
  if (msg.action === 'disable') {
   await chrome.storage.local.set({enabled: false}); await badge(false); return {ok: true};
  }
  if (msg.action === 'enable') {
   const proxyUrl = relayEndpoint(msg.proxyUrl);
   if (!/^[a-zA-Z0-9_-]{32,128}$/.test(msg.relaySecret || '')) throw new Error('Relay key must contain 32-128 letters, digits, underscores or hyphens.');
   if (!await chrome.permissions.contains({origins: [new URL(proxyUrl).origin + '/*']})) throw new Error('Worker host permission is required.');
   await chrome.storage.local.set({enabled: true, proxyUrl, relaySecret: msg.relaySecret, forwardAuth: msg.forwardAuth === true});
   await badge(true); return {ok: true};
  }
 }
 if (!isTwitch(sender)) throw new Error('Unauthorized sender');
 const state = await chrome.storage.local.get(['enabled', 'proxyUrl', 'relaySecret', 'forwardAuth']);
 if (msg.action === 'getStatus') return {enabled: !!state.enabled};
 if (msg.action !== 'relay' || !state.enabled || !state.relaySecret) throw new Error('Relay is disabled or unconfigured');
 const p = msg.payload;
 if (!p || typeof p !== 'object') throw new Error('Invalid relay payload');
 let payload;
 if (p.type === 'usher') payload = {type: 'usher', url: usherUrl(p.url)};
 else if (p.type === 'gql') {
  payload = {type: 'gql', body: tokenBody(p.body)};
  // Anonymous by default. The page cannot turn account forwarding on.
  if (state.forwardAuth && typeof p.auth === 'string' && /^OAuth [a-zA-Z0-9]{1,256}$/.test(p.auth)) payload.auth = p.auth;
 } else throw new Error('Unsupported relay type');
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 12000);
 try {
  const resp = await fetch(relayEndpoint(state.proxyUrl), {
   method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${state.relaySecret}`},
   body: JSON.stringify(payload), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
   cache: 'no-store', signal: controller.signal,
  });
  if (!resp.ok) throw new Error('Relay rejected request');
  const body = await readLimited(resp, 262144);
  if (p.type === 'gql') {
   const parsed = JSON.parse(body);
   const items = Array.isArray(parsed) ? parsed : [parsed];
   const sent = JSON.parse(payload.body);
   const operations = Array.isArray(sent) ? sent : [sent];
   if (Array.isArray(parsed) !== Array.isArray(sent) || items.length !== operations.length || items.some((item, index) => {
    const name = operations[index].variables.isLive ? 'streamPlaybackAccessToken' : 'videoPlaybackAccessToken';
    const token = item?.data?.[name];
    return item?.errors?.length || typeof token?.value !== 'string' || !token.value.trim() ||
     typeof token?.signature !== 'string' || !token.signature.trim();
   })) throw new Error('Token request rejected');
  } else if (!body.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid playlist');
  return {ok: true, body, contentType: p.type === 'gql' ? 'application/json' : 'application/vnd.apple.mpegurl'};
 } finally { clearTimeout(timer); }
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
 (async () => {
  try { respond(await handle(msg, sender)); }
  catch { respond({ok: false, error: 'Relay unavailable. Check settings and refresh Twitch.'}); }
 })();
 return true;
});
async function restore() {
 await storageReady;
 const {enabled} = await chrome.storage.local.get('enabled');
 await badge(!!enabled);
}
chrome.runtime.onInstalled.addListener(() => { restore().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { restore().catch(() => {}); });
