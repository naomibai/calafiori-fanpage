// 本地登录态采集 X / Instagram 的动态，合并进 data/social.json
// 原理：用你本机 Edge 打开一个独立浏览器档案（登录状态持久保存），
//       访问目标账号主页提取帖子，不依赖任何 API、不需要把账号密码交给脚本。
// 用法：npm run fetch-social（首次运行需在弹出的浏览器里登录 X 和 Instagram）
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { info, warn, readJsonOr, writeJsonIfChanged } from './lib/json-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'social.json');
const SOURCES_PATH = path.join(ROOT, 'scripts', 'social-sources.json');
// USE_REAL_PROFILE=1 时使用你日常 Edge 的登录态（需先关闭所有 Edge 窗口）
const PROFILE_DIR = process.env.USE_REAL_PROFILE === '1'
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data')
    : path.join(os.homedir(), '.calafiori-social-profile');
// 产品定位是「最新消息采集器」：只保留最近 7 天发布的内容，过期直接下掉
const RETENTION_DAYS = 7;
const ITEM_CAP = 60;
const MAX_POSTS_PER_ACCOUNT = 20; // 只取最近的帖子（7 天窗口一般 10 条以内就够）
const SCROLLS_PER_ACCOUNT = 3;
const POST_FETCH_CONCURRENCY = 6; // 并发读取帖子页，大幅缩短耗时

const itemId = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

function readSources() {
    if (!existsSync(SOURCES_PATH)) {
        throw new Error(`找不到 ${SOURCES_PATH}，请先创建账号清单`);
    }
    return JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
}

// ---------- Instagram ----------

// 并发池：限制同时进行的异步任务数量
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const i = index++;
            try {
                results[i] = await fn(items[i]);
            } catch {
                results[i] = null;
            }
        }
    });
    await Promise.all(workers);
    return results;
}

async function collectInstagram(page, context, handle, type) {
    const url = `https://www.instagram.com/${handle}/`;
    info(`Instagram @${handle} …`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(4000); // 等网格渲染（IG 懒加载，等待太短会采到 0 条）

    // 滚动加载更多帖子，直到攒够 20 个链接或达到最大滚动次数
    for (let i = 0; i < 5; i++) {
        const count = await page.evaluate(() => document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length);
        if (count >= 20) break;
        await page.mouse.wheel(0, 1500);
        await page.waitForTimeout(1500);
    }

    const postUrls = await page.evaluate(() => {
        const urls = new Set();
        for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
            // IG 帖子链接带用户名段，如 /arsenal/reel/DdNHXCMq-NR/
            const match = a.href.match(/https:\/\/www\.instagram\.com\/[^/]+\/(p|reel|tv)\/[A-Za-z0-9_-]+/);
            if (match) urls.add(match[0]);
        }
        return [...urls].slice(0, 60);
    });

    // 并发在浏览器标签页里打开帖子页，从 DOM 的 og 标签取文案/图片/日期
    // （IG 的 og 标签由 JS 渲染，直接用 HTTP 抓原始 HTML 拿不到）
    const parsed = await mapWithConcurrency(postUrls.slice(0, MAX_POSTS_PER_ACCOUNT), POST_FETCH_CONCURRENCY, async (postUrl) => {
        const tab = await context.newPage();
        try {
            await tab.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await tab.waitForTimeout(2000);
            const data = await tab.evaluate(() => {
                const meta = (property) => {
                    const el = document.querySelector(`meta[property="${property}"]`);
                    return el ? el.getAttribute('content') || '' : '';
                };
                const timeEl = document.querySelector('time');
                return {
                    ogTitle: meta('og:title'),
                    ogImage: meta('og:image'),
                    ogDescription: meta('og:description'),
                    time: timeEl ? timeEl.getAttribute('datetime') || '' : ''
                };
            });
            // og:title 形如 'Instagram 用户 arsenal : "正文"'，取引号内文案
            let text = '';
            const quoted = data.ogTitle.match(/:\s*"([\s\S]*)"\s*$/);
            if (quoted) text = quoted[1];
            else text = data.ogTitle.split(':').slice(1).join(':').trim();
            const dateFromDesc = (data.ogDescription.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/) || [])[0];
            const dateRaw = data.time.slice(0, 10) || (dateFromDesc ? new Date(dateFromDesc).toISOString().slice(0, 10) : '');
            if (!text && !dateRaw) return null;
            return {
                id: itemId(postUrl),
                platform: 'Instagram',
                type,
                text: text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').slice(0, 500),
                url: postUrl,
                date: dateRaw || new Date().toISOString().slice(0, 10),
                imageUrl: data.ogImage || null
            };
        } catch {
            return null;
        } finally {
            await tab.close();
        }
    });

    const items = parsed.filter(Boolean);
    info(`  Instagram @${handle}: ${items.length} 条`);
    return items;
}

// ---------- X (Twitter) ----------

async function collectX(page, handle, type) {
    const url = `https://x.com/${handle}`;
    info(`X @${handle} …`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    for (let i = 0; i < SCROLLS_PER_ACCOUNT; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(1500);
    }

    const tweets = await page.evaluate(() => {
        const result = [];
        const seen = new Set();
        for (const article of document.querySelectorAll('article')) {
            const statusLink = article.querySelector('a[href*="/status/"]');
            if (!statusLink) continue;
            const href = statusLink.href.split('?')[0];
            if (seen.has(href)) continue;
            seen.add(href);
            // 过滤掉点赞数/浏览量（纯数字行）和时间标签等 UI 噪声
            const text = (article.innerText || '')
                .split('\n')
                .filter(line => !/^\d[\d.,]*(K|M)?$/.test(line) && !/^\d+[hm]$/.test(line))
                .slice(0, 5)
                .join(' ')
                .slice(0, 400);
            const timeEl = article.querySelector('time');
            const date = timeEl?.getAttribute('datetime')?.slice(0, 10) || null;
            const img = article.querySelector('img[src*="media"]');
            result.push({ href, text, date, imageUrl: img ? img.src : null });
            if (result.length >= 30) break;
        }
        return result;
    });

    const items = tweets.map(tweet => ({
        id: itemId(tweet.href),
        platform: 'X',
        type,
        text: tweet.text,
        url: tweet.href,
        date: tweet.date || new Date().toISOString().slice(0, 10),
        imageUrl: tweet.imageUrl
    }));
    info(`  X @${handle}: ${items.length} 条`);
    return items;
}

// ---------- 主流程 ----------

async function main() {
    const sources = readSources();
    const igSources = sources.instagram || [];
    const xSources = sources.x || [];
    if (igSources.length === 0 && xSources.length === 0) {
        warn('scripts/social-sources.json 里没有账号，先填上要监测的账号再运行');
        return;
    }

    info('启动浏览器（首次运行请在弹出的窗口里登录 Instagram 和 X，之后会自动保持登录）…');
    // 优先用本机 Edge 的绝对路径（避免 channel 查找失败）；不存在则回退 Chrome，再回退 Playwright 内置 Chromium
    const browserCandidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(p => existsSync(p));
    const launchOptions = {
        headless: false,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        // 降低自动化特征，避免 Instagram 登录页反复跳转
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    };
    if (browserCandidates.length > 0) {
        launchOptions.executablePath = browserCandidates[0];
        info(`使用浏览器: ${browserCandidates[0]}`);
    }
    // 真实档案模式下 Edge 必须完全退出；若被占用（如 Edge 启动增强偷偷复活），自动强关后重试一次
    let context;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
            break;
        } catch (error) {
            if (process.env.USE_REAL_PROFILE !== '1' || attempt === 1) {
                if (process.env.USE_REAL_PROFILE === '1') {
                    throw new Error('无法打开 Edge 档案：Edge 进程无法完全退出，请手动关闭 Edge 后重试');
                }
                throw error;
            }
            warn('Edge 仍占用档案，自动强制关闭后重试…');
            try { execSync('taskkill /F /IM msedge.exe', { stdio: 'ignore' }); } catch {}
            await new Promise(resolve => setTimeout(resolve, 3000));
            try { rmSync(path.join(PROFILE_DIR, 'lockfile'), { force: true }); } catch {}
        }
    }
    // 隐藏 webdriver 标记（在后续页面加载前生效）
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = context.pages()[0] || await context.newPage();

    // 首次运行：等用户完成登录后再继续（EOF/管道环境下直接继续，便于自动化测试）
    if (!existsSync(PROFILE_DIR) && !process.env.SKIP_LOGIN_WAIT) {
        console.log('\n══════════════════════════════════════════');
        console.log('请在刚打开的浏览器窗口里登录 Instagram 和 X，');
        console.log('登录完成后回到这里按回车继续…');
        console.log('══════════════════════════════════════════\n');
        await new Promise(resolve => {
            process.stdin.resume();
            const done = () => {
                process.stdin.pause();
                resolve();
            };
            process.stdin.once('data', done);
            process.stdin.once('end', done);
        });
    }

    // 按账号配置的关键词过滤：配置了 keywords 的账号只保留命中关键词的帖子
    // （例如 Arsenal 大号只收提到 calafiori 的；本人账号不配置则全部收录）
    const filterByKeywords = (items, source) => {
        if (!source.keywords || source.keywords.length === 0) return items;
        const keywords = source.keywords.map(k => k.toLowerCase());
        const filtered = items.filter(item => keywords.some(k => item.text.toLowerCase().includes(k)));
        if (filtered.length < items.length) {
            info(`  ${source.handle}: 关键词过滤 ${items.length} → ${filtered.length} 条`);
        }
        return filtered;
    };

    let collected = [];
    try {
        for (const source of igSources) {
            try {
                const items = await collectInstagram(page, context, source.handle, source.type);
                collected.push(...filterByKeywords(items, source));
            } catch (error) {
                warn(`Instagram @${source.handle} 采集失败（${error.message}），检查是否已登录`);
            }
        }
        for (const source of xSources) {
            try {
                const items = await collectX(page, source.handle, source.type);
                collected.push(...filterByKeywords(items, source));
            } catch (error) {
                warn(`X @${source.handle} 采集失败（${error.message}），检查是否已登录`);
            }
        }
    } finally {
        await context.close();
    }

    if (collected.length === 0) {
        warn('没有采集到任何动态（多半是未登录或页面结构变化），保留现有 data/social.json');
        return;
    }

    // 去重合并：按 url 去重；新旧数据一视同仁，超过 7 天的直接下掉
    const existing = readJsonOr(OUT_PATH, { version: 1, items: [] });
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const kept = (existing.items || []).filter(item => (item.date || '9999') >= cutoff);
    const seen = new Set(kept.map(item => item.url));
    const fresh = collected.filter(item => {
        if ((item.date || '') < cutoff) return false; // 新采到的过期帖子也不入库
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
    info(`新增 ${fresh.length} 条（已有 ${kept.length} 条保留）`);

    const items = [...fresh, ...kept]
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .slice(0, ITEM_CAP);

    // 仅当内容变化时才写入
    if (JSON.stringify(existing.items ?? []) === JSON.stringify(items)) {
        info('data/social.json 无变化，跳过写入');
    } else {
        writeJsonIfChanged(OUT_PATH, { version: 1, updatedAt: new Date().toISOString(), items });
    }
    info(`social.json 共 ${items.length} 条`);
}

await main().catch(error => {
    warn(`未预期错误: ${error instanceof Error ? error.message : error}`);
});
