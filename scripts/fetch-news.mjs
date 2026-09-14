// 从 Google News RSS 聚合卡拉菲奥里相关新闻，写入 data/news.json
// 流程：RSS 查询 → 解析 → batchexecute 解码跳转 URL → 官方/媒体分类 → 去重合并
//       → DeepSeek 批量翻译新标题 → 写回（无变化不写）
// 用法：npm run fetch-news（本地需要 .env 中的 DEEPSEEK_API_KEY，可选）
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import 'dotenv/config';
import { info, warn, readJsonOr, writeJsonIfChanged } from './lib/json-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'news.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Bing News RSS：返回条目直接带出版商原文链接（apiclick 的 url 参数），无需破解解码协议
const RSS_URL = (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=en`;
const QUERIES = [
    { q: '"Calafiori"' },
    { q: '"Riccardo Calafiori"' }
];
const OFFICIAL_DOMAINS = ['arsenal.com', 'figc.it', 'legaseriea.it'];
const RETENTION_DAYS = 7;
const ITEM_CAP = 100;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const TRANSLATE_BATCH = 25;

const xmlParser = new XMLParser({ ignoreAttributes: false, cdataPropName: 'cdata' });

// ---------- RSS 抓取与解析 ----------

function stripTags(text) {
    return String(text)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

async function fetchRss(query, retries = 1) {
    const url = RSS_URL(query);
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(30_000)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (error) {
            if (attempt < retries) {
                warn(`RSS 请求失败（${error.message}），3 秒后重试…`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                throw error;
            }
        }
    }
}

// Bing News RSS 的 link 是 apiclick 点击统计地址，真实原文链接在其 url= 查询参数里
function extractRealUrl(link) {
    try {
        const u = new URL(link);
        if (u.hostname.endsWith('bing.com')) {
            const real = u.searchParams.get('url');
            if (real) return decodeURIComponent(real);
        }
    } catch {}
    return link;
}

function parseRssItems(xmlText) {
    const parsed = xmlParser.parse(xmlText);
    const items = parsed?.rss?.channel?.item || [];
    const result = [];
    for (const item of items) {
        const title = stripTags(item.title || '');
        const rawLink = String(item.link || '').trim();
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        const sourceName = stripTags(item['News:Source'] || '');
        const description = stripTags(item.description || '');
        const imageUrl = String(item['News:Image'] || '').trim().replace(/^http:/, 'https:');

        if (!title || !rawLink || !pubDate || Number.isNaN(pubDate.getTime())) continue;
        if (!title.toLowerCase().includes('calafiori')) continue;

        result.push({
            url: extractRealUrl(rawLink),
            title,
            source: sourceName,
            description,
            imageUrl: imageUrl || null,
            publishedAt: pubDate.toISOString()
        });
    }
    return result;
}

// ---------- DeepSeek 批量翻译 ----------

function parseDeepSeekJson(content) {
    try { return JSON.parse(content); } catch {}
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]); } catch {}
    }
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(content.slice(start, end + 1)); } catch {}
    }
    throw new Error('无法解析 DeepSeek 返回的 JSON');
}

const TRANSLATE_SYSTEM = '你是卡拉菲奥里（Riccardo Calafiori）球迷网站的翻译。把编号的英文新闻标题翻译成简体中文，只输出一个 JSON 对象 {编号: 中文标题}。要求：简洁，符合中文足球媒体习惯（Arsenal→阿森纳，Azzurri→蓝衣军团，Riccardo Calafiori→卡拉菲奥里），每个标题不超过 40 字，不要添加书名号或句号。';

async function translateTitles(titles, apiKey) {
    const result = new Map();
    for (let i = 0; i < titles.length; i += TRANSLATE_BATCH) {
        const batch = titles.slice(i, i + TRANSLATE_BATCH);
        const userContent = batch.map((title, j) => `${i + j}. ${title}`).join('\n');
        try {
            let content;
            try {
                content = await callDeepSeek(apiKey, userContent);
            } catch (firstError) {
                warn(`DeepSeek 请求失败（${firstError.message}），3 秒后重试…`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                content = await callDeepSeek(apiKey, userContent);
            }
            let parsed;
            try {
                parsed = parseDeepSeekJson(content);
            } catch (firstParseError) {
                warn('DeepSeek 返回格式异常，带纠正指令重试一次…');
                const retryContent = await callDeepSeek(
                    apiKey,
                    userContent + '\n\n（上次输出无法解析，这次请只输出一个 JSON 对象，不要使用代码块）'
                );
                parsed = parseDeepSeekJson(retryContent);
            }
            for (let j = 0; j < batch.length; j++) {
                const zh = parsed[String(i + j)] || parsed[i + j];
                if (typeof zh === 'string' && zh.trim()) result.set(batch[j], zh.trim());
            }
            info(`翻译完成 ${i + batch.length}/${titles.length} 条`);
        } catch (error) {
            warn(`本批翻译失败（${error.message}），该批保留原文标题`);
        }
    }
    return result;
}

async function callDeepSeek(apiKey, userContent) {
    const response = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            temperature: 0.3,
            max_tokens: 8192,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: TRANSLATE_SYSTEM },
                { role: 'user', content: userContent }
            ]
        }),
        signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
        throw new Error(`DeepSeek HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!payload.choices || !payload.choices[0] || !payload.choices[0].message) {
        throw new Error('DeepSeek 响应缺少 choices');
    }
    return payload.choices[0].message.content;
}

// ---------- 主流程 ----------

function itemId(url, title) {
    return crypto.createHash('sha1').update(url + '|' + title.toLowerCase()).digest('hex').slice(0, 16);
}

function sourceTypeOf(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (OFFICIAL_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain))) {
            return 'official';
        }
    } catch {}
    return 'media';
}

async function main() {
    const existing = readJsonOr(OUT_PATH, { version: 1, items: [] });
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // 1. 抓取 RSS
    const fetched = [];
    for (const { q } of QUERIES) {
        try {
            const xmlText = await fetchRss(q);
            const items = parseRssItems(xmlText);
            fetched.push(...items);
            info(`查询 "${q}" 返回 ${items.length} 条`);
        } catch (error) {
            warn(`查询 "${q}" 失败（${error.message}），继续下一条`);
        }
    }
    if (fetched.length === 0) {
        warn('没有抓到任何新闻条目，保留现有 data/news.json');
        return;
    }

    // 2. 去重合并
    const kept = (existing.items || [])
        .filter(item => new Date(item.publishedAt).getTime() >= cutoff);
    const seenUrls = new Set(kept.map(item => item.url));
    const seenTitles = new Set(kept.map(item => item.title.toLowerCase().replace(/[^\w]+/g, '')));

    const freshItems = [];
    for (const item of fetched) {
        // 超过保留窗口的旧条目不再入库（否则会在每轮「被保留策略剔除 → 又被重新抓入」间循环）
        if (new Date(item.publishedAt).getTime() < cutoff) continue;
        const normalizedTitle = item.title.toLowerCase().replace(/[^\w]+/g, '');
        if (seenUrls.has(item.url) || seenTitles.has(normalizedTitle)) continue;
        seenUrls.add(item.url);
        seenTitles.add(normalizedTitle);
        freshItems.push(item);
    }
    info(`新条目 ${freshItems.length} 条`);

    // 3. 翻译新标题
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey && freshItems.length > 0) {
        const translations = await translateTitles(freshItems.map(item => item.title), apiKey);
        for (const item of freshItems) {
            item.titleZh = translations.get(item.title) || null;
        }
    } else if (!apiKey) {
        warn('未配置 DEEPSEEK_API_KEY，新闻标题保留原文');
    }

    // 4. 组装并写入
    const items = [
        ...freshItems.map(item => ({
            id: itemId(item.url, item.title),
            url: item.url,
            title: item.title,
            titleZh: item.titleZh ?? null,
            source: item.source || 'Unknown',
            sourceType: sourceTypeOf(item.url),
            description: item.description || null,
            publishedAt: item.publishedAt,
            imageUrl: item.imageUrl
        })),
        ...kept
    ].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, ITEM_CAP);

    // 仅当条目真正变化时才写入（避免 updatedAt 每轮变化导致 Actions 空提交）
    if (JSON.stringify(existing.items ?? []) !== JSON.stringify(items)) {
        writeJsonIfChanged(OUT_PATH, {
            version: 1,
            updatedAt: new Date().toISOString(),
            items
        });
    } else {
        info('news.json 条目无变化，跳过写入');
    }
    info(`news.json 共 ${items.length} 条（官方 ${items.filter(i => i.sourceType === 'official').length} 条）`);
}

await main().catch(error => {
    warn(`未预期错误: ${error instanceof Error ? error.message : error}`);
});
