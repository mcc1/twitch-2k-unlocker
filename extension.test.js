import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('./page.js', import.meta.url), 'utf8');

test('background isolates relay secrets and honors account opt-in', async t => {
 const state = {enabled:true, proxyUrl:'https://private.example/', relaySecret:'k'.repeat(48), forwardAuth:false};
 let listener, access, seen;
 globalThis.chrome = {
  storage:{local:{setAccessLevel:async value=>{access=value;}, get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in state).map(k=>[k,state[k]])),set:async values=>Object.assign(state,values)}},
  runtime:{id:'testid',getURL:path=>'chrome-extension://testid/'+path,onMessage:{addListener:fn=>{listener=fn;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},permissions:{contains:async()=>true},
 };
 t.after(()=>{delete globalThis.chrome;});
 await import('./background.js');
 const send=(msg,sender)=>new Promise(resolve=>listener(msg,sender,resolve));
 const twitch={id:'testid',url:'https://www.twitch.tv/example',tab:{id:1},frameId:0};
 const popup={id:'testid',url:'chrome-extension://testid/popup.html'};
 assert.deepEqual(await send({action:'getStatus'},twitch),{enabled:true});
 assert.deepEqual(access,{accessLevel:'TRUSTED_CONTEXTS'});
 assert.equal((await send({action:'getStatus'},popup)).relaySecret,state.relaySecret);
 assert.equal((await send({action:'getStatus'},{...twitch,url:'https://evil.example'})).ok,false);
 assert.equal((await send({action:'enable',relaySecret:'stolen'},twitch)).ok,false);
 const token={operationName:'PlaybackAccessToken',variables:{isLive:true,isVod:false,login:'example',vodID:'',playerType:'site'}};
 const payload={type:'gql',body:JSON.stringify(token),auth:'OAuth MOCK123',forwardAuth:true};
 t.mock.method(globalThis,'fetch',async(url,init)=>{seen={url,init};return new Response('{"data":{"streamPlaybackAccessToken":{"value":"v","signature":"s"}}}');});
 const result=await send({action:'relay',payload},twitch);
 assert.equal(result.ok,true);
 assert.equal(seen.init.headers.Authorization,`Bearer ${state.relaySecret}`);
 assert.equal(JSON.parse(seen.init.body).auth,undefined);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(state.relaySecret));
 assert.equal(seen.init.redirect,'error');
 state.forwardAuth=true;
 assert.equal((await send({action:'relay',payload},twitch)).ok,true);
 assert.equal(JSON.parse(seen.init.body).auth,'OAuth MOCK123');
 for (const invalid of [
  {data:{streamPlaybackAccessToken:null}},
  {data:{streamPlaybackAccessToken:{value:'',signature:'s'}}},
  {data:{videoPlaybackAccessToken:{value:'v',signature:'s'}}},
  [{data:{streamPlaybackAccessToken:{value:'v',signature:'s'}}}],
  {data:{streamPlaybackAccessToken:{value:'v',signature:'s'}},errors:[{message:'failed'}]},
 ]) {
  const mock = t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(invalid)));
  assert.equal((await send({action:'relay',payload},twitch)).ok,false);
  mock.mock.restore();
 }
 state.enabled=false;
 assert.equal((await send({action:'relay',payload},twitch)).ok,false);
});

test('page relays metadata and falls back to original fetch on failure', async () => {
 const messages=[],direct=[];
 const listeners=[];
 const win={fetch:async(...args)=>{direct.push(args);return new Response('direct');},addEventListener:(type,fn)=>listeners.push(fn),postMessage:(data,origin)=>messages.push({data,origin})};
 const sandbox={window:win,location:{href:'https://www.twitch.tv/example'},crypto,Request,Response,Headers,URL,console:{warn(){}},setTimeout,clearTimeout};
 vm.runInNewContext(source,sandbox);
 const input='https://usher.ttvnw.net/api/channel/hls/example.m3u8';
 const p=win.fetch(input);
 assert.equal(messages.length,1);
 assert.equal(messages[0].origin,'https://www.twitch.tv');
 assert.doesNotMatch(JSON.stringify(messages),/relaySecret|Bearer /);
 const reply={source:'twitch-2k-response',id:messages[0].data.id,result:{ok:true,body:'#EXTM3U',contentType:'application/vnd.apple.mpegurl'}};
 for(const fn of listeners) fn({source:win,origin:'https://evil.example',data:reply});
 for(const fn of listeners) fn({source:win,origin:'https://www.twitch.tv',data:reply});
 assert.equal(await (await p).text(),'#EXTM3U');
 assert.equal(direct.length,0);
 const fallback=win.fetch(input);
 for(const fn of listeners) fn({source:win,origin:'https://www.twitch.tv',data:{...reply,id:messages.at(-1).data.id,result:{ok:false}}});
 assert.equal(await (await fallback).text(),'direct');
 assert.equal(await (await win.fetch('https://video-weaver.example/segment.ts')).text(),'direct');
 assert.equal(messages.length,2);
 assert.equal(direct.length,2);
});
