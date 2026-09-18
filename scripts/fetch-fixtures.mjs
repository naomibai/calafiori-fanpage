// 拉取阿森纳和意大利的未来赛程，写入 data/fixtures.json
// 数据源：ESPN core API（无需密钥）。2026-09 起 site API 的 dates 范围参数失效，
// 改用 core API 的球队事件日期范围接口（事件与对手名为超链接，需逐层展开）
// 用法：npm run fetch-fixtures
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { info, warn, readJsonOr, writeJsonIfChanged } from './lib/json-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'fixtures.json');
const BASE_CORE = 'https://sports.core.api.espn.com/v2/sports/soccer';
const FUTURE_MATCHES_PER_TEAM = 5;
const WINDOW_DAYS = 75;
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 每支球队在哪些赛事里找赛程（league slug 对应 ESPN 数据）
const TEAM_QUERIES = {
    arsenal: [
        { league: 'eng.1', teamId: 359 },           // 英超
        { league: 'uefa.champions', teamId: 359 },  // 欧冠
        { league: 'eng.fa', teamId: 359 },          // 足总杯
        { league: 'eng.league_cup', teamId: 359 }   // 联赛杯
    ],
    italy: [
        { league: 'uefa.nations', teamId: 162 },    // 欧国联
        { league: 'fifa.world', teamId: 162 },      // 世界杯
        { league: 'fifa.friendly', teamId: 162 }    // 友谊赛
    ]
};

const LEAGUE_NAMES = {
    'eng.1': 'Premier League',
    'uefa.champions': 'Champions League',
    'eng.fa': 'FA Cup',
    'eng.league_cup': 'EFL Cup',
    'uefa.nations': 'Nations League',
    'fifa.world': 'World Cup',
    'fifa.friendly': 'Friendly'
};

function formatDateWindow() {
    const start = new Date();
    const end = new Date(Date.now() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    return `${fmt(start)}-${fmt(end)}`;
}

async function coreFetch(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

// 并发池
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

async function fetchTeamEventRefs(league, teamId) {
    const url = `${BASE_CORE}/leagues/${league}/teams/${teamId}/events?dates=${formatDateWindow()}&lang=en&region=us`;
    const list = await coreFetch(url);
    return (list.items || []).map(item => String(item.$ref).replace(/^http:/, 'https:'));
}

// 对手名解析（带缓存，同一对手跨赛事只查一次）
async function resolveTeamName(cache, teamRef) {
    const key = String(teamRef);
    if (cache.has(key)) return cache.get(key);
    try {
        const data = await coreFetch(key.replace(/^http:/, 'https:'));
        const name = data.displayName || data.name || null;
        cache.set(key, name);
        return name;
    } catch {
        cache.set(key, null);
        return null;
    }
}

async function formatCoreEvent(eventUrl, teamId, league, teamNameCache) {
    const event = await coreFetch(eventUrl);
    const competition = event.competitions?.[0];
    if (!competition) return null;
    const competitors = competition.competitors || [];
    const us = competitors.find(c => String(c.id) === String(teamId));
    const opponent = competitors.find(c => String(c.id) !== String(teamId));
    if (!us || !opponent) return null;
    const oppName = opponent.team?.$ref
        ? await resolveTeamName(teamNameCache, opponent.team.$ref)
        : null;
    return {
        date: event.date,
        comp: LEAGUE_NAMES[league] || 'Match',
        opp: oppName || 'Unknown',
        venue: competition.venue?.fullName || null,
        status: competition.status?.type?.shortDetail || null,
        isHome: us.homeAway === 'home',
        opponentId: Number(opponent.id)
    };
}

async function main() {
    const now = new Date();
    const results = {};
    let fetchedAny = false;
    const teamNameCache = new Map();

    for (const [teamKey, queries] of Object.entries(TEAM_QUERIES)) {
        const events = [];
        for (const { league, teamId } of queries) {
            try {
                const refs = await fetchTeamEventRefs(league, teamId);
                fetchedAny = true;
                const formatted = await mapWithConcurrency(refs, CONCURRENCY, ref =>
                    formatCoreEvent(ref, teamId, league, teamNameCache)
                );
                const valid = formatted.filter(Boolean);
                info(`${teamKey} ${league}: ${valid.length} 场未来比赛`);
                events.push(...valid);
            } catch (error) {
                warn(`${teamKey} ${league} 拉取失败（${error.message}），跳过该赛事`);
            }
        }
        // 跨赛事去重（同一场比赛可能出现在多个赛事接口里）
        const seen = new Set();
        const upcoming = events
            .filter(event => event.date && new Date(event.date) > now)
            .filter(event => {
                const key = event.date + '|' + event.opp;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(0, FUTURE_MATCHES_PER_TEAM);
        results[teamKey] = upcoming;
        info(`${teamKey}: 共 ${upcoming.length} 场未来比赛入库`);
    }

    if (!fetchedAny) {
        warn('全部赛事接口拉取失败，保留现有 data/fixtures.json');
        return;
    }

    // 仅当赛程真正变化时才写入（避免 updatedAt 每轮变化导致 Actions 空提交）
    const existing = readJsonOr(OUT_PATH, null);
    const next = {
        version: 1,
        updatedAt: new Date().toISOString(),
        source: 'espn',
        ...results
    };
    const unchanged = existing
        && JSON.stringify(existing.arsenal ?? []) === JSON.stringify(next.arsenal)
        && JSON.stringify(existing.italy ?? []) === JSON.stringify(next.italy);
    if (unchanged) {
        info('data/fixtures.json 赛程无变化，跳过写入');
    } else {
        writeJsonIfChanged(OUT_PATH, next);
    }
}

await main().catch(error => {
    // 任何意外失败都保留旧文件并正常退出，让 workflow 保持绿色
    warn(`未预期错误: ${error instanceof Error ? error.message : error}`);
});
