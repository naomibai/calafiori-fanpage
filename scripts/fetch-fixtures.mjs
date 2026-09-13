// 拉取阿森纳(42)和意大利(768)的未来赛程，写入 data/fixtures.json
// API-Football 免费版不支持 next 参数，改用 season 参数拉取全赛季后本地过滤未来比赛
// 用法：npm run fetch-fixtures（本地需要 .env 中的 API_FOOTBALL_KEY）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { info, warn, readJsonOr, writeJsonIfChanged } from './lib/json-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'data', 'fixtures.json');
const API_URL = 'https://v3.football.api-sports.io/fixtures';
const TEAMS = { arsenal: 42, italy: 768 };
const FUTURE_MATCHES_PER_TEAM = 5;

function computeSeason(now = new Date()) {
    const year = now.getFullYear();
    // 欧洲赛季 8 月开赛：1-6 月属于上一个赛季
    return now.getMonth() + 1 <= 6 ? year - 1 : year;
}

async function fetchTeamFixtures(teamId, season, apiKey) {
    const params = new URLSearchParams({ team: String(teamId), season: String(season) });
    const response = await fetch(`${API_URL}?${params}`, {
        headers: { 'x-apisports-key': apiKey },
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
        throw new Error(`API-Football 返回 HTTP ${response.status} (team ${teamId})`);
    }
    const payload = await response.json();
    if (payload.errors && Object.keys(payload.errors).length > 0) {
        throw new Error(`API-Football 错误 (team ${teamId}): ${JSON.stringify(payload.errors)}`);
    }
    return payload.response;
}

function formatFixture(fixture, teamId) {
    const isHome = fixture.teams.home.id === teamId;
    const opponent = isHome ? fixture.teams.away : fixture.teams.home;
    return {
        date: fixture.fixture.date,
        comp: fixture.league.name,
        opp: opponent.name,
        venue: fixture.fixture.venue?.name || null,
        status: fixture.fixture.status.short,
        isHome,
        opponentId: opponent.id
    };
}

async function main() {
    const apiKey = process.env.API_FOOTBALL_KEY;
    if (!apiKey) {
        warn('未配置 API_FOOTBALL_KEY，跳过（保留现有 data/fixtures.json）');
        return;
    }

    const season = computeSeason();
    const now = new Date();
    info(`拉取 ${season} 赛季赛程（team 42 & 768）…`);

    const results = {};
    let anyTeamFailed = false;
    for (const [teamKey, teamId] of Object.entries(TEAMS)) {
        try {
            const all = await fetchTeamFixtures(teamId, season, apiKey);
            results[teamKey] = all
                .map(fixture => formatFixture(fixture, teamId))
                .filter(match => new Date(match.date) > now)
                .sort((a, b) => new Date(a.date) - new Date(b.date))
                .slice(0, FUTURE_MATCHES_PER_TEAM);
            info(`${teamKey}: ${results[teamKey].length} 场未来比赛`);
        } catch (error) {
            warn(`${teamKey} 拉取失败（${error.message}），本队保留旧数据`);
            anyTeamFailed = true;
        }
    }

    if (anyTeamFailed && Object.keys(results).length === 0) {
        warn('两队全部拉取失败，保留现有 data/fixtures.json');
        return;
    }
    if (anyTeamFailed) {
        // 部分失败：不整体覆盖，避免丢掉失败一队的旧数据
        warn('部分队伍拉取失败，跳过写入（保留现有文件）');
        return;
    }

    // 仅当两队赛程真正变化时才写入（避免 updatedAt 每轮变化导致 Actions 空提交）
    const existing = readJsonOr(OUT_PATH, null);
    const next = {
        version: 1,
        updatedAt: new Date().toISOString(),
        source: 'api-football',
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
