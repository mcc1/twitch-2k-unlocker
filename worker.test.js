import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {tokenBody, usherUrl} from './worker.js';
const secret = 'a'.repeat(48);
const env = {RELAY_SECRET: secret, RELAY_RATE_LIMITER: {limit: async () => ({success: true})}};
const token = {operationName: 'PlaybackAccessToken', variables: {isLive: true, isVod: false, login: 'example', vodID: '', playerType: 'site'}};
const playlist = 'https://usher.ttvnw.net/api/channel/hls/example.m3u8?sig=test';
function request(payload, auth = `Bearer ${secret}`) {
 return new Request('https://relay.example/', {method: 'POST', headers: {Authorization: auth}, body: typeof payload === 'string' ? payload : JSON.stringify(payload)});
}
test('malicious destinations are rejected', () => {
 for (const url of ['https://example.com/?tag=usher.ttvnw.net', 'https://usher.ttvnw.net.example.com/test',
  'https://usher.ttvnw.net@example.com/test', 'http://usher.ttvnw.net/api/channel/hls/example.m3u8',
  'https://usher.ttvnw.net:444/api/channel/hls/example.m3u8', 'https://usher.ttvnw.net/other',
  'https://user:pass@usher.ttvnw.net/api/channel/hls/example.m3u8', playlist + '#fragment']) assert.throws(() => usherUrl(url));
 assert.equal(usherUrl(playlist), playlist);
 assert.equal(usherUrl('https://usher.ttvnw.net/vod/123.m3u8'), 'https://usher.ttvnw.net/vod/123.m3u8');
});
test('arbitrary GraphQL cannot be forwarded by disguising operationName', () => {
 const out = JSON.parse(tokenBody(JSON.stringify({...token, query: 'mutation { deleteAccount }', extensions: {persistedQuery: {sha256Hash: 'evil'}}})));
 assert.match(out.query, /^query PlaybackAccessToken/);
 assert.doesNotMatch(out.query, /deleteAccount/);
 assert.equal(out.extensions, undefined);
 assert.throws(() => tokenBody(JSON.stringify({...token, operationName: 'DeleteAccount'})));
 assert.throws(() => tokenBody(JSON.stringify([token, {operationName: 'Other'}])));
 assert.throws(() => tokenBody('[]'));
 assert.throws(() => tokenBody(JSON.stringify({...token, variables: {...token.variables, login: '../evil'}})));
 assert.ok(Array.isArray(JSON.parse(tokenBody(JSON.stringify([token])))));
});
test('reject requests before any upstream access', async t => {
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not fetch'); });
 assert.equal((await worker.fetch(request({type:'usher',url:playlist}), {})).status, 503);
 assert.equal((await worker.fetch(request({type:'usher',url:playlist}, ''), env)).status, 401);
 assert.equal((await worker.fetch(request({type:'usher',url:playlist}, 'Bearer wrong'), env)).status, 401);
 assert.equal((await worker.fetch(request({type:'usher',url:playlist}), {RELAY_SECRET:secret})).status, 503);
 assert.equal((await worker.fetch(request({type:'usher',url:playlist}), {...env,RELAY_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);
 assert.equal((await worker.fetch(request('{bad'), env)).status,400);
 assert.equal((await worker.fetch(request('x'.repeat(17000)), env)).status,413);
 assert.equal((await worker.fetch(request({type:'usher',url:'https://example.com/?usher.ttvnw.net'}), env)).status,400);
 assert.equal((await worker.fetch(new Request('https://relay.example/'),env)).status,405);
 assert.equal(calls,0);
});
test('playlist request stays on allowlisted host and does not follow redirects', async t => {
 let seen;
 t.mock.method(globalThis, 'fetch', async (url, init) => { seen={url,init}; return new Response('#EXTM3U\n#test'); });
 const res = await worker.fetch(request({type:'usher',url:playlist}),env);
 assert.equal(res.status,200);
 assert.equal(seen.url,playlist);
 assert.equal(seen.init.redirect,'manual');
 assert.equal(seen.init.headers,undefined);
 assert.equal(res.headers.get('access-control-allow-origin'),null);
 assert.equal(res.headers.get('cache-control'),'no-store');
 assert.match(await res.text(),/^#EXTM3U/);
});
test('redirects, non-playlists, oversized responses and internal errors fail safely', async t => {
 for (const response of [new Response('',{status:302,headers:{Location:'https://example.com'}}),
  new Response('not a playlist'),new Response('x'.repeat(262145))]) {
  const mock = t.mock.method(globalThis,'fetch',async()=>response);
  assert.notEqual((await worker.fetch(request({type:'usher',url:playlist}),env)).status,200);
  mock.mock.restore();
 }
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('SECRET-INTERNAL-DETAIL');});
 const res = await worker.fetch(request({type:'usher',url:playlist}),env);
 assert.equal(res.status,502);
 assert.doesNotMatch(await res.text(),/SECRET-INTERNAL-DETAIL/);
});
test('GQL uses fixed endpoint and client id, without device id or relay key', async t => {
 let seen;
 t.mock.method(globalThis,'fetch',async(url,init)=>{seen={url,init};return new Response('{"data":{}}');});
 const res=await worker.fetch(request({type:'gql',body:JSON.stringify(token),clientId:'evil',deviceId:'tracking'}),env);
 assert.equal(res.status,200);
 assert.equal(seen.url,'https://gql.twitch.tv/gql');
 assert.equal(seen.init.headers['Client-ID'],'kimne78kx3ncx6brgo4mv6wki5h1ko');
 assert.equal(seen.init.headers.Authorization,undefined);
 assert.equal(seen.init.headers['Device-ID'],undefined);
});
