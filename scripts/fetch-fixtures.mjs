// 拉取阿森纳和意大利的未来赛程，写入 data/fixtures.json
// 数据源：ESPN 公开 JSON 接口（无需密钥），用 scoreboard 日期窗口查未来比赛
// 用法：npm run fetch-fixtures
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { info, warn, readJsonOr, writeJsonIfChanged } from './lib/json-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'fixtures.json');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const FUTURE_MATCHES_PER_TEAM = 5;
const WINDOW_DAYS = 75; // scoreboard 单次可查的日期窗口（一次请求覆盖足够远）

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

function formatDateWindow() {
    const start = new Date();
    const end = new Date(Date.now() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    return `${fmt(start)}-${fmt(end)}`;
}

async function fetchLeagueWindow(league) {
    const url = `${BASE}/${league}/scoreboard?dates=${formatDateWindow()}`;
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
        signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload.events || [];
}

// scoreboard 事件不带联赛名称，按查询的赛事 slug 映射显示名
const LEAGUE_NAMES = {
    'eng.1': 'Premier League',
    'uefa.champions': 'Champions League',
    'eng.fa': 'FA Cup',
    'eng.league_cup': 'EFL Cup',
    'uefa.nations': 'Nations League',
    'fifa.world': 'World Cup',
    'fifa.friendly': 'Friendly'
};

function formatEvent(event, teamId, league) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    const us = competitors.find(c => String(c.id) === String(teamId));
    const opponent = competitors.find(c => String(c.id) !== String(teamId));
    const isHome = us?.homeAway === 'home';
    return {
        date: event.date,
        comp: LEAGUE_NAMES[league] || 'Match',
        opp: opponent?.team?.displayName || event.name,
        venue: competition?.venue?.fullName || null,
        status: competition?.status?.type?.shortDetail || null,
        isHome,
        opponentId: opponent ? Number(opponent.id) : null
    };
}

async function main() {
    const now = new Date();
    const results = {};
    let fetchedAny = false;

    for (const [teamKey, queries] of Object.entries(TEAM_QUERIES)) {
        const events = [];
        for (const { league, teamId } of queries) {
            try {
                const leagueEvents = await fetchLeagueWindow(league);
                const ours = leagueEvents
                    .filter(event =>
                        (event.competitions?.[0]?.competitors || []).some(c => String(c.id) === String(teamId))
                    )
                    .map(event => ({ ...event, __league: league }));
                info(`${teamKey} ${league}: ${ours.length} 场未来比赛`);
                events.push(...ours);
                fetchedAny = true;
            } catch (error) {
                warn(`${teamKey} ${league} 拉取失败（${error.message}），跳过该赛事`);
            }
        }
        // 跨赛事去重（同一场比赛可能出现在多个赛事接口里）
        const seen = new Set();
        const upcoming = events
            .filter(event => event.date && new Date(event.date) > now)
            .filter(event => {
                if (seen.has(event.id)) return false;
                seen.add(event.id);
                return true;
            })
            .map(event => formatEvent(event, queries[0].teamId, event.__league))
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
