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

## 安全注意事项

- `.env` 不要提交到 GitHub。
- API-Football 的密钥不要写入 `index.html`。
- 如果公开仓库中发现密钥，应立即在 API-Football 控制台撤销并重新生成。
