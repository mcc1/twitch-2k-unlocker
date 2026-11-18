# Playback interception diagnosis

日期: 2026-11-19. 狀態: ready_for_user, 真實直播 relay 與 1440p 已驗證, 待使用者驗收.
基準: ed013b0350abdc0d48fa4f7403c6c0260c890f1f.

## 使用者症狀

開啟 Twitch 播放後, Cloudflare Worker 沒有出現來自擴充套件的日誌.

## 實測證據

- 已載入擴充套件 2.1.0, enabled = true. Worker URL 正確, 已授予該網域權限, relay key 已設定. 未記錄或輸出金鑰內容.
- 舊的 Twitch 分頁收到診斷 postMessage 後 15 秒無回覆. 新測試分頁可在約 515 ms 經 content/background/CF 取得播放 token.
- 原分頁重新整理後, 相同診斷橋接測試約 322 ms 成功. 此結果只驗證橋接與 relay, 不證明播放器本身經過攔截.
- 經 CDP 唯讀檢查 Twitch 的 blob Web Worker resource timing, 確認其中一個 worker 以 fetch 請求 usher.ttvnw.net/api/v2/channel/hls/lice0424.m3u8. 未保存 URL query、播放 token 或帳號憑證.
- page.js 只改寫 window.fetch, 無 Web Worker 內的 fetch 攔截, 因此上述播放器請求不會到 relay.
- worker.js 的 usherUrl 只允許 /api/channel/hls/... 或 /vod/..., 不接受實際使用的 /api/v2/channel/hls/.... 直接執行 usherUrl 已確認回報 Invalid playlist URL.
- 瀏覽器亦捕捉到 PlaybackAccessToken_Template 原始 GQL 請求直接到 Twitch. 為何主頁 token 請求未經 hook 尚未定位, 不能直接宣稱是 Web Worker 或時序問題.
- CF 的即時日誌已實際顯示診斷 POST 請求, 因此日誌與基本 relay 路徑可運作.

## 後續修正驗收

1. 處理實際播放器執行環境的請求攔截, 保持 relay key 只在擴充套件背景中使用.
2. 精確允許實際觀測到的 /api/v2/channel/hls 路徑, 保留 HTTPS/hostname/路徑驗證和 redirect 拒絕.
3. 處理重載擴充套件後既有 Twitch 分頁的失效情況, 或清楚要求重新整理.
4. 驗收必須讓真實播放器自然產生 CF POST 和日誌, 並證明取得可播放的 playlist; 人工 postMessage 不算完成.
5. 分開驗證匿名與登入播放, 再檢查畫質. 目前不宣稱已解鎖 1440p.

## 本機修正與回讀

- manifest 改以 document_start 同步注入 ISOLATED bridge 和 MAIN interceptor. 不再等設定查詢後才載入腳本.
- page.js 包裝 Twitch 同源 classic blob Worker, 在其 fetch 層攔截播放 metadata, relay key 仍只由背景使用.
- 原始 loader 作為獨立 script 載入, 保留 strict mode, 並處理載入完成、錯誤與 terminate 時的 blob 釋放.
- 新增 v2 路徑、worker relay、strict mode、segment 直連、等待中取消及 Request body 讀取期間取消回歸案例. npm test 11/11 通過, Wrangler 4.164.0 dry-run 通過.
- 已在使用者現有 Edge 重新載入本機擴充套件 2.2.0-dev, 保留設定. 真實 Twitch 頁面重新整理後自然產生 gql relay 成功, 並攔到 GET /api/v2/channel/hls/lice0424.m3u8 的 usher relay.
- 部署前線上 Worker 仍是 ed013b0 的舊路徑限制, usher relay 被拒絕並回退直連. 該階段未宣稱完整 relay 播放已通過.
- 暫時 DEBUG 訊息已移除. 真實播放的最終驗收需新版 Worker 上線後重跑, 並在 CF 中確認自然 POST 與播放結果.
- 最後一版本機擴充套件重新載入並重整實際 Twitch 後, CF 即時畫面顯示 03:37:34 (Asia/Taipei) 的自然 POST 與位置日誌. 該輪未發送人工 postMessage.
- 獨立 reviewer ROUND 3/3 重跑原始 Request 取消競態已通過, 未發現剩餘程式 blocking. 線上 v2 playlist 與實際 relay 播放仍 pending, 不將 GQL 成功混同為整條播放成功.

## GitHub 自動部署後驗收

- 修正 commit d265cc6fa5821c30454068dadd62b3751fc1c587 已推送 main. GitHub 的 Workers Builds check 已確認 success.
- 生產 Worker version: bee2d30f-b1f9-48ae-9ae2-43f160d2b6c8. 本機 Edge 擴充套件重新載入為 2.2.0, 保留 enabled、relay URL、key 與帳號轉送設定.
- 03:43:00.892 和 03:43:01.462 (Asia/Taipei) 的真實 Twitch 啟播自然 POST 在 CF 即時日誌可見, 展開各筆 invocation 均為 response.status = 200、outcome = ok. 該輪未人工發送 metadata 橋接訊息.
- 影片持續播放至 currentTime 28.850096, paused = false, readyState = 4, videoWidth = 2560, videoHeight = 1440, video.error = null.
- 日本東京 placement 設定保留在 Wrangler. 該輪 HTTP 回應未提供 Cf-Placement, 因此本輪未重新證明實際執行機房.
- 本次只驗證該直播的現有登入播放. 匿名、VOD、訂閱限定、其他播放器與 module Worker 仍未實測. 不宣稱所有 Twitch 情境通過.
- 診斷期間曾反覆建立 CDP 連線而造成多次允許提示; 使用者指出後已停止該方式, 改用既有 agent-browser 連線. 沒有調低瀏覽器安全設定.
