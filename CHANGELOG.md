# Changelog

## 2.2.0

- 在 document_start 的 MAIN world 同步安裝攔截, 移除等待設定後才動態注入腳本的時序空窗.
- 支援 Twitch 同源 classic blob Web Worker 的播放 metadata 攔截, 保留原始 loader 的 strict mode 與一般訊息, 影片片段保持直連.
- 精確允許 /api/v2/channel/hls/ 路徑, 保留 HTTPS、hostname、路徑及 redirect 限制.
- AbortSignal 取消時立即結束呼叫端等待. 已送出的背景 metadata 請求仍可能完成, 受原有逾時和大小限制約束.
- 本機新版已在 Edge 載入驗證. 真實播放器自然產生 token relay 成功與 v2 playlist relay 嘗試; 線上舊 Worker 尚未支援 v2, 完整播放仍待新版部署驗收.

## Worker diagnostics (2026-11-19)

- 明確啟用 observability 並設定完整取樣, 將 Workers Logs 開關納入 Git 管理, 避免只在控制台設定而與自動部署設定不一致.
- 將 placement.region 從 aws:us-east-1 改為 aws:ap-northeast-1, 改用日本東京區域作為執行位置提示.
- 將 Wrangler Worker 名稱統一為 twitch-2k-unlocker, 與 Cloudflare 已連接的自動部署專案一致.
- 指定 placement.region 為 aws:us-east-1, 讓 Cloudflare 選擇靠近美國東部區域的執行機房. 不保證 Twitch 對出口 IP 的國家判定.
- 每次呼叫記錄 ingressColo 和 cf-placement, 用於查看入口機房與 Placement 路由位置. 不記錄請求網址、內容或憑證.

## 2.1.0

- 驗證 relay key、限制上游目的地、固定播放 token query、拒絕重新導向.
- 將 relay 請求移至擴充套件背景, 限制設定與金鑰存取, 加入指定網域權限要求.
- 預設不轉送 Twitch 帳號憑證, 移除 Device-ID 和遠端字型請求.
- 加入請求/回應大小與等待上限、Cloudflare 限流設定、安全回歸測試.
- 修正啟用狀態文字, 不宣稱已成功解鎖. 真實播放和 Cloudflare 部署尚待驗收.
