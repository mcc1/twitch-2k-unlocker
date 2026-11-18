// The page bridge carries only metadata requests, never the relay URL or key.
(async function () {
 try {
  const state = await chrome.runtime.sendMessage({action: 'getStatus'});
  if (!state?.enabled) return;
  let active = 0;
  window.addEventListener('message', async event => {
   if (event.source !== window || event.origin !== 'https://www.twitch.tv') return;
   const msg = event.data;
   if (!msg || msg.source !== 'twitch-2k-request' || typeof msg.id !== 'string' || msg.id.length > 100 || active >= 8) return;
   active++;
   try {
    const result = await chrome.runtime.sendMessage({action: 'relay', payload: msg.payload});
    window.postMessage({source: 'twitch-2k-response', id: msg.id, result}, 'https://www.twitch.tv');
   } catch {
    window.postMessage({source: 'twitch-2k-response', id: msg.id, result: {ok: false}}, 'https://www.twitch.tv');
   } finally { active--; }
  });
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
 } catch { console.warn('[Twitch 2K] Extension settings unavailable.'); }
})();
