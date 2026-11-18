const toggle = document.getElementById('toggle');
const proxyInput = document.getElementById('proxy-url');
const keyInput = document.getElementById('relay-key');
const authInput = document.getElementById('forward-auth');
const status = document.getElementById('status');
const save = document.getElementById('save');
function show(text, enabled = false) {
 status.textContent = text;
 status.className = 'status ' + (enabled ? 'active' : 'inactive');
}
(async () => {
 try {
  const res = await chrome.runtime.sendMessage({action: 'getStatus'});
  toggle.checked = !!res.enabled;
  proxyInput.value = res.proxyUrl || '';
  keyInput.value = res.relaySecret || '';
  authInput.checked = !!res.forwardAuth;
  show(res.enabled ? '已啟用, 畫質仍需實測' : '已停用', !!res.enabled);
 } catch { show('讀取設定失敗'); }
})();
save.addEventListener('click', async () => {
 save.disabled = true;
 try {
  let res;
  if (!toggle.checked) res = await chrome.runtime.sendMessage({action: 'disable'});
  else {
   const url = new URL(proxyInput.value.trim());
   if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('請填入可信任的 HTTPS Worker URL, 不可含帳密或查詢參數.');
   if (!/^[a-zA-Z0-9_-]{32,128}$/.test(keyInput.value.trim())) throw new Error('Relay key 需為 32-128 個英文字母、數字、底線或連字號.');
   // Call before an async gap to preserve the user's permission gesture.
   const granted = await chrome.permissions.request({origins: [url.origin + '/*']});
   if (!granted) throw new Error('需要允許存取這個 Worker 網域.');
   res = await chrome.runtime.sendMessage({action: 'enable', proxyUrl: url.href, relaySecret: keyInput.value.trim(), forwardAuth: authInput.checked});
  }
  if (!res?.ok) throw new Error(res?.error || '設定儲存失敗');
  show(toggle.checked ? '已儲存並啟用, 請重新整理 Twitch' : '已停用, 請重新整理 Twitch', toggle.checked);
 } catch (err) { show(err.message); }
 finally { save.disabled = false; }
});
document.getElementById('setup-link').addEventListener('click', event => {
 event.preventDefault();
 chrome.tabs.create({url: 'https://github.com/mcc1/twitch-2k-unlocker#setup'});
});
