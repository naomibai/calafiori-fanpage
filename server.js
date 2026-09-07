require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const port = Number(process.env.PORT) || 3000;
const apiKey = process.env.API_FOOTBALL_KEY;
const apiUrl = 'https://v3.football.api-sports.io/fixtures';
const teamIds = {
    arsenal: 42,
    italy: 768
};

let fixturesCache = null;
let refreshPromise = null;

app.use(cors({
    origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());

function formatFixture(fixture) {
    return {
        date: fixture.fixture.date,
        comp: fixture.league.name,
        opp: fixture.teams.home.id === teamIds.arsenal || fixture.teams.home.id === teamIds.italy
            ? fixture.teams.away.name
            : fixture.teams.home.name,
        venue: fixture.fixture.venue?.name || null,
        status: fixture.fixture.status.short
    };
}

async function fetchTeamFixtures(teamId) {
    const params = new URLSearchParams({
        team: String(teamId),
        next: '3'
    });

    const response = await fetch(`${apiUrl}?${params}`, {
        headers: {
            'x-apisports-key': apiKey
        }
    });

    if (!response.ok) {
        throw new Error(`API-Football returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && Object.keys(payload.errors).length > 0) {
        throw new Error(`API-Football error: ${JSON.stringify(payload.errors)}`);
    }

    return payload.response.map(formatFixture);
}

function getCacheTTL(matches) {
    const now = new Date();
    const futureMatches = matches.filter(match => new Date(match.date) > now);

    if (futureMatches.length === 0) {
        return 24 * 60 * 60 * 1000;
    }

    const nextMatch = futureMatches.sort(
        (first, second) => new Date(first.date) - new Date(second.date)
    )[0];
    const hoursUntilMatch = (new Date(nextMatch.date) - now) / (1000 * 60 * 60);

    if (hoursUntilMatch < 24) {
        return 30 * 60 * 1000;
    } else if (hoursUntilMatch < 72) {
        return 4 * 60 * 60 * 1000;
    } else if (hoursUntilMatch < 168) {
        return 12 * 60 * 60 * 1000;
    }

    return 24 * 60 * 60 * 1000;
}

async function getUpcomingFixtures() {
    const now = Date.now();
    if (fixturesCache && now < fixturesCache.expiresAt) {
        return fixturesCache.data;
    }

    if (!refreshPromise) {
        refreshPromise = Promise.all([
            fetchTeamFixtures(teamIds.arsenal),
            fetchTeamFixtures(teamIds.italy)
        ]).then(([arsenal, italy]) => {
            const matches = [...arsenal, ...italy];
            const cacheTtlMs = getCacheTTL(matches);
            const cachedAt = new Date().toISOString();
            const data = {
                arsenal,
                italy,
                cachedAt,
                cacheTtlMs,
                cacheExpiresAt: new Date(Date.now() + cacheTtlMs).toISOString()
            };

            fixturesCache = {
                data,
                expiresAt: Date.now() + cacheTtlMs
            };
            return data;
        }).finally(() => {
            refreshPromise = null;
        });
    }

    try {
        return await refreshPromise;
    } catch (error) {
        if (fixturesCache) {
            console.error('Fixtures refresh failed; serving stale cache:', error);
            return {
                ...fixturesCache.data,
                stale: true
            };
        }
        throw error;
    }
}

app.get('/health', (request, response) => {
    response.json({ ok: true });
});

app.get('/api/fixtures', async (request, response) => {
    if (!apiKey) {
        return response.status(500).json({ error: 'API_FOOTBALL_KEY is not configured' });
    }

    try {
        response.json(await getUpcomingFixtures());
    } catch (error) {
        console.error(error);
        response.status(502).json({ error: 'Unable to load fixtures from API-Football' });
    }
});

app.listen(port, () => {
    console.log(`Fixtures API listening on port ${port}`);
});
