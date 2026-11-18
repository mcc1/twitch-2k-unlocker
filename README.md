# Twitch 2K Private Relay

這是 [ddaccu/twitch-2k-unlocker](https://github.com/ddaccu/twitch-2k-unlocker) 的安全強化 fork.
只代理 Twitch 播放 token 和 master playlist, 影片片段仍由瀏覽器直接下載.

## 安全變更

- Worker 必須設定 RELAY_SECRET 和限流 binding, 缺少時拒絕服務.
- 精確限制 HTTPS、usher.ttvnw.net 和直播/VOD playlist 路徑. 拒絕重新導向.
- GraphQL 由 Worker 重建成固定的播放 token query. 不轉送任意 query、mutation 或 persisted hash.
- Relay key 只保存在擴充套件的 trusted local storage, 由背景 service worker 使用. 不放進 DOM、page.js 或頁面訊息.
- Twitch 帳號憑證預設不轉送. 不轉送 Device-ID. 如需帳號限定播放, 可明確選擇允許轉送憑證.
- 設定時只要求指定 relay 網域的 optional host permission. 不預先授予所有 HTTPS 網站存取權限.
- 請求上限 16 KiB, 上游回應上限 256 KiB, 上游等待上限 10 秒. 回應禁止快取, 不回傳內部錯誤細節.
- Worker 不提供 CORS grant. 擴充套件背景直接請求 relay, 不依賴 Twitch 網頁的跨來源權限.

## Setup

本 fork 不能只換 worker.js: Worker 與擴充套件必須一起更新.

1. 在自己的 Cloudflare 帳號建立 Worker. 建議使用 Wrangler 4.36.0 或更新版, 讀取本 repo 的 wrangler.toml.
2. 使用密碼管理器產生 48 個隨機英數字元作為 relay key. 不要提交到 Git.
3. 在預定部署前設定 secret: `wrangler secret put RELAY_SECRET`. 同一把 key 稍後填入擴充套件.
4. wrangler.toml 已設定 RELAY_RATE_LIMITER, 每個 Cloudflare 機房約 120 次/60 秒. namespace_id 必須在自己的帳號內選用未與其他專案共用的值.
5. 經確認後部署 Worker: `wrangler deploy`. 若直接使用 dashboard, 仍須手動建立相同的 secret 和 rate limiting binding.
6. 在 Chrome 或 Edge 的擴充套件頁面開啟開發人員模式, 載入本 repo 資料夾. 更新後按重新載入.
7. 開啟 popup, 填入自己的 HTTPS Worker URL 和 relay key, 勾選啟用並儲存. 瀏覽器只會要求這個 relay 網域的權限.
8. 重新整理 Twitch, 確認正常播放和畫質選單. 停用後也請重新整理既有 Twitch 分頁.

一般播放先保持帳號憑證轉送關閉. 訂閱限定等內容若需要授權, 可選擇轉送, 但 relay 經營者能讀到 Twitch 憑證.
更換 relay 網域後, 舊網域的 optional permission 可從瀏覽器擴充套件網站存取權設定撤銷.

## 限制與待驗證

- **不保證 1440p**. 主播、Twitch 授權和實際出口位置都會影響結果. 本 repo 已設定 placement.region = "aws:us-east-1", 讓 Cloudflare 選擇對美國東部區域延遲最低的機房. 這不固定某台主機, 也不保證 Twitch 對出口 IP 的國家判定; 部署後請查看 placement 日誌驗收.
- 只攔截頁面主執行緒的 window.fetch. Twitch Web Worker 或其他播放器路徑不一定經過這個攔截器.
- 僅支援 PlaybackAccessToken 和 PlaybackAccessToken_Template, 最多 4 筆純播放 token batch. 混合其他 operation 的 batch 直接使用原始 Twitch 請求.
- Relay 失敗或回傳 GraphQL errors 時回退到原始直連, 可能失去高畫質選項. 設定頁的已啟用不代表已驗證解鎖.
- Twitch 網頁本身可觸發允許範圍內的播放 metadata 請求, 但不能取得 relay key 或指定任意上游. 頁面 bridge 不是對 Twitch 頁面的身分驗證邊界.
- 本機儲存區不是加密保險庫. 能控制此瀏覽器設定檔的人仍可能取得 relay key.
- Cloudflare 限流是各機房的近似限制, 不是全球每日配額或費用上限. 未授權請求也會進入 Worker, 不能保證不消耗呼叫配額. 部署前自行檢查帳號方案與費用.
- 未在真實 Cloudflare 部署或 Twitch 播放驗證. 自動測試只驗證離線的程式行為.

## Verification

### 查看機房位置

在 Cloudflare 開啟此 Worker 的即時日誌, 再重新整理 Twitch 或開啟 Worker URL 產生請求.
尋找 `[Twitch relay location]`, 其中 ingressColo 是請求進入的機房代碼;
placement 在啟用 Placement 時可能顯示例如 remote-LHR 的路由執行位置, 沒有該標頭時為 null.
未授權或 GET 請求仍會留下位置日誌, 但不會因此取得代理權限.
這些值不保證 Twitch 對出口 IP 的國家判定. 本機模擬環境的 ingressColo 可能為 null 或測試值.

需要 Node.js 20 或更新版, 不需安裝相依套件:

```sh
npm test
```

手動驗收: 未帶 key 應回 401; 非 playlist URL 應回 400; 正常直播與 VOD 可播放; relay 故障時可直連; 頁面 DOM、頁面訊息和 console 不含 relay key; 開啟帳號憑證轉送後測試訂閱限定內容.

## References

- [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Cloudflare rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Chrome cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

MIT. 保留上游 LICENSE.
