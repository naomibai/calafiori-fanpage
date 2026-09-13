# Riccardo Calafiori Fanpage

这是一个静态单页粉丝网站，赛程数据通过独立 Node.js 服务从 API-Football 获取。

## 本地运行后端

1. 安装 Node.js 18 或更高版本。
2. 在项目根目录复制 `.env.example` 为 `.env`。
3. 在 `.env` 中填写 API-Football 密钥：

```env
API_FOOTBALL_KEY=你的_API_Football_密钥
PORT=3000
CORS_ORIGIN=https://naomibai.github.io
```

4. 安装依赖并启动：

```bash
npm install
npm start
```

健康检查：`http://localhost:3000/health`

赛程接口：`http://localhost:3000/api/fixtures`

接口会分别请求阿森纳（team 42）和意大利国家队（team 768）的未来 3 场比赛，并根据两队最近一场未来比赛的距离动态缓存：

- 没有未来比赛：24 小时
- 距离下一场少于 24 小时：30 分钟
- 距离下一场 24 至 72 小时：4 小时
- 距离下一场 72 至 168 小时：12 小时
- 距离下一场超过 168 小时：24 小时

响应中的 `cacheTtlMs` 和 `cacheExpiresAt` 会显示当前缓存策略。后端还会合并并发刷新请求，且 API-Football 临时失败时优先返回上一次成功的缓存，避免重复消耗每日额度。API 密钥只存在后端环境变量中，不会发送给浏览器。

## 免费部署后端到 Cloudflare Workers

Cloudflare Workers 版本在 `worker.js`，不需要 Render，也不需要绑定银行卡。部署前安装 Node.js，然后在项目根目录执行：

```bash
npm install -g wrangler
wrangler login
wrangler secret put API_FOOTBALL_KEY
wrangler deploy
```

执行 `wrangler secret put API_FOOTBALL_KEY` 后，按照终端提示直接粘贴 API-Football 密钥。密钥不会写入代码或 GitHub。

部署完成后，Cloudflare 会提供类似下面的地址：

```text
https://calafiori-fixtures.<你的Cloudflare账号>.workers.dev
```

然后把前端 `index.html` 中的 `SCHEDULE_API_URL` 改成：

```javascript
const SCHEDULE_API_URL = 'https://你的Worker地址/api/fixtures';
```

`wrangler.toml` 已经把 `CORS_ORIGIN` 设置为 `https://naomibai.github.io`。Worker 使用 Cloudflare Cache API，按照下一场比赛距离动态缓存 30 分钟至 24 小时，并通过 `X-Fixtures-Cache` 标记命中或未命中。

GitHub Pages 继续托管静态前端，Cloudflare Worker 只负责安全地调用 API-Football。

## 视频采访工作流（转写 → 中文稿 → 标题）

上传一条采访视频后，一条命令自动完成：音轨提取 → Cloudflare Workers AI（Whisper）语音转写 → DeepSeek 生成英文标题 + 中文采访稿 → 更新网页卡片。

### 首次配置

1. 注册 DeepSeek 并充值少量余额：<https://platform.deepseek.com>，创建 API Key。
2. 在 `.env` 中填写（参见 `.env.example`）：

```env
DEEPSEEK_API_KEY=你的DeepSeek密钥
TRANSCRIBE_TOKEN=一段随机令牌
TRANSCRIBE_WORKER_URL=https://calafiori-fixtures.你的账号.workers.dev
```

3. 把同一个令牌设为 Worker 密钥并重新部署（`[ai]` binding 已在 wrangler.toml 中声明）：

```bash
npx wrangler secret put TRANSCRIBE_TOKEN
npx wrangler deploy
```

### 处理视频

把视频命名为 `interview-3.mp4`（或 1、2、4）放进 `assets/video/interviews/`，然后：

```bash
npm install
npm run video -- assets/video/interviews/interview-3.mp4
```

脚本会依次：提取音频 → 上传转写（约 1-2 分钟）→ 截取封面 → DeepSeek 生成英文杂志风标题和完整中文采访稿 → 更新 `assets/video/videos.json` → 重写 `index.html`。最后提交并推送，GitHub Pages 自动发布。

- 视频元数据（标题、标签、中文稿）的单一数据源是 `assets/video/videos.json`，手动修改后运行 `npm run video -- --regenerate` 即可重建页面卡片。
- 视频文件需小于 100 MB（GitHub 单文件上限）。
- 转写端点有 10 MB 音频上限（约 20 分钟音轨），超出会被拒绝。

## 自动数据采集（赛程 + 新闻）

借鉴 F1 粉丝站 piasnews 的模式：**所有数据以静态 JSON 提交在仓库，GitHub Actions 定时抓取 → 提交 → Pages 自动发布，前端运行时读取 JSON**。

### 架构

```
GitHub Actions (每 6 小时 / 手动触发)
  ├─ npm run fetch-fixtures → API-Football（season 参数，免费版兼容）→ data/fixtures.json
  ├─ npm run fetch-news     → Google News RSS → 官方/媒体分类 → DeepSeek 翻译标题 → data/news.json
  └─ 数据有变化才 commit+push；抓取失败保留旧数据，workflow 保持绿色
前端 index.html（cache: no-store + ?v= 时间戳）
  ├─ News 区块（无数据时隐藏）
  ├─ 赛程区读 data/fixtures.json，失败回退内置 fallback 数据
  └─ Fan Sources 区块（data/social.json 有内容才显示）
```

### 首次配置

在 GitHub 仓库设置两个 Secrets（Settings → Secrets and variables → Actions）：

```bash
gh secret set API_FOOTBALL_KEY --repo naomibai/calafiori-fanpage   # 必需，赛程
gh secret set DEEPSEEK_API_KEY --repo naomibai/calafiori-fanpage   # 可选，新闻标题中文翻译
```

然后手动触发一次 Actions → Update Data → Run workflow，验证数据提交。

### 本地干跑

```bash
npm run fetch-fixtures   # 读取 .env 中的 API_FOOTBALL_KEY，生成 data/fixtures.json
npm run fetch-news       # 读取 .env 中的 DEEPSEEK_API_KEY（可选），生成 data/news.json
```

### 数据文件说明

- `data/fixtures.json`：`{version, updatedAt, source, arsenal: [{date, comp, opp, venue, status, isHome, opponentId}], italy: [...]}`，每队最多未来 5 场（页面显示 3 场）。免费版 API-Football 不支持 `next` 参数，脚本用 `season` 参数拉全赛季后本地过滤。
- `data/news.json`：`{version, updatedAt, items: [{id, url, title, titleZh, source, sourceType: "official"|"media", publishedAt, imageUrl}]}`。官方域名白名单：arsenal.com / figc.it / legaseriea.it。保留 7 天、上限 100 条。链接为 Google News 跳转链接（可正常打开原文）。
- `data/social.json`（**仅手动维护**，脚本不会写它）：`{version, items: [{id, platform, text, url, date}]}`。创建这个文件并 push 后，页面会出现 "From The Stands" 区块；删除或清空则区块隐藏。

## 安全注意事项

- `.env` 不要提交到 GitHub。
- API-Football 的密钥不要写入 `index.html`。
- `TRANSCRIBE_TOKEN` 只存在 Worker 密钥和本地 `.env` 中，不要提交。
- 如果公开仓库中发现密钥，应立即在 API-Football 控制台撤销并重新生成。
