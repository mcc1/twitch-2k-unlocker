# Security review

日期: 2026-11-19. 狀態: ready for you to test.

來源: ddaccu/twitch-2k-unlocker f98af75eb95ee07e9f37493d62b78a0616560e40.
Fork: https://github.com/mcc1/twitch-2k-unlocker.
使用者已授權將 2.1.0 commit/push 至 fork 的 main. Cloudflare 由使用者自行部署, 本次未部署.

## 原問題與驗證

- 原版 handler 在模擬上游測試中接受 example.com query 含 usher.ttvnw.net 的網址, 以及偽裝子網域和 userinfo 的網址.
- 修改後相同類型全部拒絕, 不觸發上游 fetch.
- npm test: 8/8 組通過. 含目的地、GraphQL 重建、驗證、限流拒絕、大小限制、redirect、key 隔離、帳號轉送選擇和頁面直連回退.
- 獨立 reviewer ROUND 1/3 發現 null token 被誤當成功. 修正後檢查 value/signature 與 batch 對應, reviewer 重跑同一案例, native fetch 由 0 次變為 1 次並回傳 DIRECT. 本輪沒有開放 blocking.
- Wrangler 4.164.0 deploy --dry-run 通過, 未上傳或部署.
- Wrangler/workerd 本機實測: 未帶 key HTTP 401; 非允許目的地 HTTP 400; 非播放操作 HTTP 400. 沒有使用真實 Twitch 憑證或發送上游請求.
- 本機 runtime 發現當日 compatibility date 尚未被支援, 已改為 2026-11-01 並成功啟動測試. 測試服務已停止.
- JavaScript syntax checks 和 git diff --check 通過.

## 變更目標

- Worker: worker.js, wrangler.toml.
- 擴充套件: background.js, content.js, page.js, manifest.json, popup.js, popup.html, popup.css.
- 文件與測試: README.md, CHANGELOG.md, SECURITY-REVIEW.md, package.json, worker.test.js, extension.test.js, .gitignore.
- GitHub: 安全強化版本目標為 mcc1/twitch-2k-unlocker 的 main, 保留上游歷史.

## 待使用者驗收

1. 依 README 在自己的 CF 設定 RELAY_SECRET 和 RELAY_RATE_LIMITER 並部署. 不要提交金鑰.
2. 載入新版擴充套件, 設定 URL 和 key, 明確授予該 relay 網域權限.
3. 重新整理 Twitch, 檢查直播、VOD、畫質選單, 以及 relay 故障後的直連回退.
4. 如需訂閱限定內容, 開啟憑證轉送後另測. 預設關閉.
5. 確認 Twitch 頁面 DOM、postMessage 和 console 不含 relay key.

未完成真實瀏覽器安裝、Cloudflare 線上 binding、實際 Twitch 播放或 1440p 驗證. 不保證出口地區或畫質解鎖.
Cloudflare 限流只限制各機房的近似速率, 不能當作全球配額或費用上限.
Relay key 使用擴充套件本機 storage, 不抵抗本機設定檔遭控制; Twitch 同源網頁可觸發允許範圍的 metadata 請求.
