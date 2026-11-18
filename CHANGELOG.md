# Changelog

## 2.1.0

- 驗證 relay key、限制上游目的地、固定播放 token query、拒絕重新導向.
- 將 relay 請求移至擴充套件背景, 限制設定與金鑰存取, 加入指定網域權限要求.
- 預設不轉送 Twitch 帳號憑證, 移除 Device-ID 和遠端字型請求.
- 加入請求/回應大小與等待上限、Cloudflare 限流設定、安全回歸測試.
- 修正啟用狀態文字, 不宣稱已成功解鎖. 真實播放和 Cloudflare 部署尚待驗收.
