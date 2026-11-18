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

test('classic Twitch blob workers relay v2 playlists, preserve messages and keep segments direct', async () => {
 const blobs=new Map(),messages=[],direct=[],workerResults=[],revoked=[],application=[];
 let created;
 class BlobURL extends URL {
  static createObjectURL(blob){const url='blob:https://www.twitch.tv/wrapped-'+blobs.size;blobs.set(url,blob);return url;}
  static revokeObjectURL(url){revoked.push(url);}
 }
 class XHR {
  open(method,url,async){assert.equal(async,false);this.url=url;}
  send(){this.status=200;this.responseText="'use strict'; self.originalLoaderRan = true; self.postMessage({kind:'app',strict:(function(){return this===undefined})()});";}
 }
 class Worker {
  constructor(url,options){this.url=url;this.options=options;this.listeners=[];created=this;}
  addEventListener(type,fn){if(type==='message')this.listeners.push(fn);}
  postMessage(data){workerResults.push(data);}
  terminate(){this.terminated=true;}
 }
 const listeners=[];
 const win={Worker,XMLHttpRequest:XHR,fetch:async()=>new Response('main-direct'),addEventListener:(type,fn)=>listeners.push(fn),postMessage:(data,origin)=>messages.push({data,origin})};
 vm.runInNewContext(source,{window:win,location:{href:'https://www.twitch.tv/example'},crypto,Request,Response,Headers,URL:BlobURL,Blob,console,setTimeout,clearTimeout});
 const original='blob:https://www.twitch.tv/original';
 const w=new win.Worker(original,{name:'player'});
 assert.ok(w instanceof Worker);
 assert.equal(w.options.name,'player');
 assert.equal(created,w);
 assert.ok(revoked.includes(w.url));
 const workerListeners=[];
 const scope={fetch:async(...args)=>{direct.push(args);return new Response('segment');},postMessage:data=>{
  if(data.kind==='app')application.push(data);
  for(const fn of w.listeners)fn({data,stopImmediatePropagation(){}});
 },addEventListener:(type,fn)=>workerListeners.push(fn)};
 const texts=new Map(await Promise.all([...blobs].map(async([url,blob])=>[url,await blob.text()])));
 const context=vm.createContext({self:scope,crypto,Request,Response,Headers,URL,console,setTimeout,clearTimeout});
 context.importScripts=url=>vm.runInContext(texts.get(url),context);
 vm.runInContext(texts.get(w.url),context);
 assert.equal(scope.originalLoaderRan,true);
 assert.equal(application[0].strict,true);
 assert.equal(application[0].kind,'app');
 assert.ok(revoked.includes([...blobs.keys()][0]));
 const response=scope.fetch('https://usher.ttvnw.net/api/v2/channel/hls/example.m3u8?sig=test');
 assert.equal(messages.length,1);
 assert.equal(messages[0].data.payload.type,'usher');
 assert.equal(messages[0].origin,'https://www.twitch.tv');
 const {id}=messages[0].data;
 for(const fn of listeners)fn({source:win,origin:'https://www.twitch.tv',data:{source:'twitch-2k-response',id,result:{ok:true,body:'#EXTM3U',contentType:'application/vnd.apple.mpegurl'}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(workerResults.length,1);
 for(const fn of workerListeners)fn({data:workerResults[0],stopImmediatePropagation(){}});
 assert.equal(await (await response).text(),'#EXTM3U');
 assert.equal(await (await scope.fetch('https://video-weaver.example/segment.ts')).text(),'segment');
 assert.equal(direct.length,1);
 w.terminate(); assert.equal(w.terminated,true);
 const untouched=new win.Worker('https://www.twitch.tv/other.js');
 assert.equal(untouched.url,'https://www.twitch.tv/other.js');
 const moduleWorker=new win.Worker(original,{type:'module'});
 assert.equal(moduleWorker.url,original);
});

test('aborted metadata fetch rejects promptly without waiting for relay response', async () => {
 const messages=[],listeners=[];
 const win={fetch:async(input,init)=>{if(init?.signal?.aborted)throw new DOMException('Aborted','AbortError');return new Response('direct');},addEventListener:(type,fn)=>listeners.push(fn),postMessage:data=>messages.push(data)};
 vm.runInNewContext(source,{window:win,location:{href:'https://www.twitch.tv/example'},crypto,Request,Response,Headers,URL,DOMException,console:{warn(){}},setTimeout,clearTimeout});
 const controller=new AbortController();
 const p=win.fetch('https://usher.ttvnw.net/api/v2/channel/hls/example.m3u8',{signal:controller.signal});
 controller.abort();
 await assert.rejects(Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Did not abort promptly')),100))]),{name:'AbortError'});
 for(const fn of listeners)fn({source:win,origin:'https://www.twitch.tv',data:{source:'twitch-2k-response',id:messages[0].id,result:{ok:false}}});
});

test('Request-body abort during asynchronous clone read does not dispatch relay', async () => {
 const messages=[],listeners=[];
 const win={fetch:async input=>{if(input.signal?.aborted)throw new DOMException('Aborted','AbortError');return new Response('direct');},addEventListener:(type,fn)=>listeners.push(fn),postMessage:data=>messages.push(data)};
 vm.runInNewContext(source,{window:win,location:{href:'https://www.twitch.tv/example'},crypto,Request,Response,Headers,URL,DOMException,console:{warn(){}},setTimeout,clearTimeout});
 const controller=new AbortController();
 const body=JSON.stringify({operationName:'PlaybackAccessToken',variables:{isLive:true,isVod:false,login:'example',vodID:'',playerType:'site'}});
 const p=win.fetch(new Request('https://gql.twitch.tv/gql',{method:'POST',body,signal:controller.signal}));
 controller.abort();
 await assert.rejects(p,{name:'AbortError'});
 assert.equal(messages.length,0);
});
