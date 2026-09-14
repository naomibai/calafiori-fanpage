const API_URL = 'https://v3.football.api-sports.io/fixtures';
const TEAM_IDS = {
    arsenal: 42,
    italy: 768
};

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigin = env.CORS_ORIGIN || '*';

    return {
        'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : origin === allowedOrigin ? origin : allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

function jsonResponse(data, status, request, env, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(request, env),
            ...extraHeaders
        }
    });
}

function formatFixture(fixture, teamId) {
    const isHome = fixture.teams.home.id === teamId;
    return {
        date: fixture.fixture.date,
        comp: fixture.league.name,
        opp: isHome ? fixture.teams.away.name : fixture.teams.home.name,
        venue: fixture.fixture.venue?.name || null,
        status: fixture.fixture.status.short
    };
}

async function fetchTeamFixtures(teamId, env) {
    const params = new URLSearchParams({
        team: String(teamId),
        next: '3'
    });
    const response = await fetch(`${API_URL}?${params}`, {
        headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }
    });

    if (!response.ok) {
        throw new Error(`API-Football returned HTTP ${response.status} for team ${teamId}`);
    }

    const payload = await response.json();
    if (payload.errors && Object.keys(payload.errors).length > 0) {
        throw new Error(`API-Football error for team ${teamId}: ${JSON.stringify(payload.errors)}`);
    }

    return payload.response.map(fixture => formatFixture(fixture, teamId));
}

function getCacheTTL(matches) {
    const now = new Date();
    const futureMatches = matches.filter(match => new Date(match.date) > now);

    if (futureMatches.length === 0) return 24 * 60 * 60;

    const nextMatch = futureMatches.sort(
        (first, second) => new Date(first.date) - new Date(second.date)
    )[0];
    const hoursUntilMatch = (new Date(nextMatch.date) - now) / (1000 * 60 * 60);

    if (hoursUntilMatch < 24) return 30 * 60;
    if (hoursUntilMatch < 72) return 4 * 60 * 60;
    if (hoursUntilMatch < 168) return 12 * 60 * 60;
    return 24 * 60 * 60;
}

async function getFixtures(request, env, ctx) {
    const cache = caches.default;
    const cacheKey = new Request(new URL('/api/fixtures', request.url).toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) {
        const headers = new Headers(cached.headers);
        Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
        headers.set('X-Fixtures-Cache', 'HIT');
        return new Response(cached.body, { status: cached.status, headers });
    }

    const [arsenal, italy] = await Promise.all([
        fetchTeamFixtures(TEAM_IDS.arsenal, env),
        fetchTeamFixtures(TEAM_IDS.italy, env)
    ]);
    const cacheTtlSeconds = getCacheTTL([...arsenal, ...italy]);
    const data = {
        arsenal,
        italy,
        cachedAt: new Date().toISOString(),
        cacheTtlMs: cacheTtlSeconds * 1000,
        cacheExpiresAt: new Date(Date.now() + cacheTtlSeconds * 1000).toISOString()
    };
    const response = jsonResponse(data, 200, request, env, {
        'Cache-Control': `public, max-age=${cacheTtlSeconds}`,
        'X-Fixtures-Cache': 'MISS'
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders(request, env) });
        }

        const url = new URL(request.url);
        if (url.pathname === '/health') {
            return jsonResponse({ ok: true }, 200, request, env);
        }
        if (url.pathname !== '/api/fixtures' || request.method !== 'GET') {
            return jsonResponse({ error: 'Not found' }, 404, request, env);
        }
        if (!env.API_FOOTBALL_KEY) {
            return jsonResponse({ error: 'API_FOOTBALL_KEY is not configured' }, 500, request, env);
        }

        try {
            return await getFixtures(request, env, ctx);
        } catch (error) {
            console.error(error);
            return jsonResponse({
                error: 'Unable to load fixtures from API-Football',
                diagnostic: error instanceof Error ? error.message : 'Unknown upstream error'
            }, 502, request, env);
        }
    }
};
