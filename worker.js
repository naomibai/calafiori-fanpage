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

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function handleTranscribe(request, env) {
    const start = Date.now();

    const token = env.TRANSCRIBE_TOKEN;
    if (!token) {
        return jsonResponse({ error: 'TRANSCRIBE_TOKEN is not configured' }, 500, request, env);
    }
    // Plain string compare is fine here: this endpoint is only called by the local CLI script.
    if (request.headers.get('Authorization') !== `Bearer ${token}`) {
        return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
    }

    const contentLength = Number(request.headers.get('content-length') || 0);
    if (!contentLength || contentLength > 10 * 1024 * 1024) {
        return jsonResponse({ error: 'Audio too large (max 10 MB)' }, 413, request, env);
    }
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('audio/')) {
        return jsonResponse({ error: 'Content-Type must be audio/*' }, 415, request, env);
    }
    if (!env.AI) {
        return jsonResponse({ error: 'AI binding is not configured (add [ai] to wrangler.toml)' }, 500, request, env);
    }

    try {
        const audioBuffer = await request.arrayBuffer();
        if (!audioBuffer.byteLength) {
            return jsonResponse({ error: 'Empty audio body' }, 400, request, env);
        }
        if (audioBuffer.byteLength > 10 * 1024 * 1024) {
            return jsonResponse({ error: 'Audio too large (max 10 MB)' }, 413, request, env);
        }

        // whisper-large-v3-turbo 要求 audio 为 base64 字符串（数字数组是旧版 @cf/openai/whisper 的格式）
        const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
            audio: arrayBufferToBase64(audioBuffer)
        });

        if (!result || typeof result.text !== 'string' || !result.text.trim()) {
            return jsonResponse({ error: 'No speech detected' }, 422, request, env);
        }
        return jsonResponse({
            ok: true,
            text: result.text,
            wordCount: result.word_count || 0,
            durationMs: Date.now() - start
        }, 200, request, env);
    } catch (error) {
        console.error('Transcription failed:', error);
        return jsonResponse({
            error: 'Transcription failed',
            diagnostic: error instanceof Error ? error.message.slice(0, 300) : 'Unknown upstream error'
        }, 502, request, env);
    }
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
        if (url.pathname === '/api/transcribe' && request.method === 'POST') {
            return handleTranscribe(request, env);
        }
        if (url.pathname === '/api/fixtures' && request.method === 'GET') {
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
        return jsonResponse({ error: 'Not found' }, 404, request, env);
    }
};
