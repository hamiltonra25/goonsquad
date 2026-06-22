// fetch-odds.js
// Runs via GitHub Actions 4x per day (8AM, 12PM, 4PM, 8PM CT)
// Fetches World Cup 2026 odds from BALLDONTLIE API (DraftKings + FanDuel)
// and writes them to Firebase Firestore.

import fetch from 'node-fetch';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── Firebase Admin init ──
initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore();

const BDL_KEY = process.env.BDL_KEY;
const BASE    = 'https://api.balldontlie.io/fifa/worldcup/v1';

// Team name normalization — BALLDONTLIE names → our display names
const TEAM_MAP = {
  'South Korea':              'Korea Republic',
  'Korea Republic':           'Korea Republic',
  'Czech Republic':           'Czechia',
  'Czechia':                  'Czechia',
  'Bosnia and Herzegovina':   'Bosnia & Herz.',
  'Bosnia-Herzegovina':       'Bosnia & Herz.',
  'Bosnia & Herzegovina':     'Bosnia & Herz.',
  'Türkiye':                  'Turkey',
  'Turkey':                   'Turkey',
  "Côte d'Ivoire":            'Ivory Coast',
  'Ivory Coast':              'Ivory Coast',
  'DR Congo':                 'DR Congo',
  'Congo DR':                 'DR Congo',
  'United States':            'USA',
  'USA':                      'USA',
  'Cabo Verde':               'Cape Verde',
  'Cape Verde Islands':       'Cape Verde',
  'Cape Verde':               'Cape Verde',
  'Curaçao':                  'Curaçao',
  'Curacao':                  'Curaçao',
};

function norm(name) {
  return TEAM_MAP[name] || name;
}

function toImplied(price) {
  return price > 0
    ? 100 / (price + 100)
    : Math.abs(price) / (Math.abs(price) + 100);
}

function toAmerican(prob) {
  prob = Math.min(Math.max(prob, 0.01), 0.99);
  return prob >= 0.5
    ? Math.round(-prob / (1 - prob) * 100)
    : Math.round((1 - prob) / prob * 100);
}

// Convert UTC ISO string to CT display label
function toCTLabel(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(',', ' ·') + ' CT';
}

async function fetchAllPages(url) {
  const results = [];
  let cursor = null;
  do {
    const pageUrl = cursor ? `${url}&cursor=${cursor}` : url;
    const res  = await fetch(pageUrl, { headers: { Authorization: BDL_KEY } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BDL API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    results.push(...(data.data || []));
    cursor = data.meta?.next_cursor || null;
  } while (cursor);
  return results;
}

async function run() {
  // ── 1. Fetch all upcoming/current WC matches ──
  console.log('Fetching World Cup matches from BALLDONTLIE...');
  const matches = await fetchAllPages(`${BASE}/matches?per_page=100`);
  console.log(`Got ${matches.length} matches`);

  // ── 2. Fetch odds — prefer DraftKings, fallback to fanduel ──
  console.log('Fetching DraftKings odds...');
  const dkOdds = await fetchAllPages(`${BASE}/odds?vendor=draftkings&per_page=100`);
  console.log(`Got ${dkOdds.length} DraftKings odds rows`);

  console.log('Fetching FanDuel odds (fallback)...');
  const fdOdds = await fetchAllPages(`${BASE}/odds?vendor=fanduel&per_page=100`);
  console.log(`Got ${fdOdds.length} FanDuel odds rows`);

  // Build odds lookup: match_id -> odds row (DK preferred)
  const oddsMap = {};
  fdOdds.forEach(o => { oddsMap[o.match_id] = o; });
  dkOdds.forEach(o => { oddsMap[o.match_id] = o; }); // DK overwrites FD

  let written = 0;
  const batch = db.batch();

  for (const match of matches) {
    const homeRaw = match.home_team?.name || match.home_team;
    const awayRaw = match.away_team?.name || match.away_team;
    if (!homeRaw || !awayRaw) continue;

    const home = norm(homeRaw);
    const away = norm(awayRaw);
    const kickoffUTC = new Date(match.datetime || match.date).getTime();
    const ctLabel    = toCTLabel(match.datetime || match.date);

    const odds = oddsMap[match.id];

    // ── Moneyline ──
    let moneyline = null;
    if (odds?.moneyline_home_odds && odds?.moneyline_away_odds) {
      moneyline = {
        home: odds.moneyline_home_odds,
        away: odds.moneyline_away_odds,
        draw: odds.moneyline_draw_odds || null,
      };
    }

    if (!moneyline) {
      console.log(`No moneyline for: ${home} vs ${away} — skipping`);
      continue;
    }

    // ── Tie No Bet (derived from moneyline by stripping draw probability) ──
    let tnb;
    if (moneyline.draw) {
      const iH = toImplied(moneyline.home);
      const iA = toImplied(moneyline.away);
      const tot = iH + iA;
      tnb = { home: toAmerican(iH / tot), away: toAmerican(iA / tot) };
    } else {
      tnb = { home: moneyline.home, away: moneyline.away };
    }

    // ── Double Chance (derived) ──
    let dc = null;
    if (moneyline.draw) {
      const iH = toImplied(moneyline.home);
      const iA = toImplied(moneyline.away);
      const iD = toImplied(moneyline.draw);
      dc = {
        homeOrDraw: toAmerican(Math.min(iH + iD, 0.99)),
        awayOrDraw: toAmerican(Math.min(iA + iD, 0.99)),
        homeOrAway: toAmerican(Math.min(iH + iA, 0.99)),
      };
    } else {
      dc = { homeOrDraw: -300, awayOrDraw: -300, homeOrAway: -200 };
    }

    // ── Total Goals — stored directly by BALLDONTLIE ──
    let total = null;
    if (odds?.total_value && odds?.total_over_odds && odds?.total_under_odds) {
      total = {
        line:  odds.total_value,
        over:  odds.total_over_odds,
        under: odds.total_under_odds,
      };
    } else {
      total = { line: 2.5, over: -110, under: -110 };
    }

    // ── Spread — stored by BALLDONTLIE with explicit home/away values & team names ──
    let spread = null;
    if (odds?.spread_home_value != null && odds?.spread_away_value != null
        && odds?.spread_home_odds && odds?.spread_away_odds) {
      // BALLDONTLIE returns spread_home_value for the home team and
      // spread_away_value for the away team — no positional guessing needed
      spread = {
        line:     odds.spread_home_value,  // home team's handicap (e.g. -1 means home favored)
        awayLine: odds.spread_away_value,  // away team's handicap (e.g. +1)
        homeFav:  odds.spread_home_odds,
        awayDog:  odds.spread_away_odds,
      };
      console.log(`Spread: ${home} ${odds.spread_home_value} (${odds.spread_home_odds}) vs ${away} ${odds.spread_away_value} (${odds.spread_away_odds})`);
    } else {
      // No spread available — use default
      spread = { line: -0.5, awayLine: 0.5, homeFav: -110, awayDog: -110 };
      console.log(`No spread data for: ${home} vs ${away} — using default`);
    }

    const matchDoc = {
      id:         String(match.id),
      home,
      away,
      kickoffUTC,
      ctLabel,
      moneyline,
      tnb,
      total,
      spread,
      dc,
      updatedAt:  new Date().toISOString(),
    };

    const ref = db.collection('matches').doc(String(match.id));
    batch.set(ref, matchDoc);
    written++;
  }

  // Write metadata
  const metaRef = db.collection('meta').doc('odds');
  batch.set(metaRef, {
    lastUpdated: new Date().toISOString(),
    matchCount: written,
    source: 'balldontlie',
  });

  await batch.commit();
  console.log(`\n✓ Wrote ${written} matches to Firebase`);
}

run().catch(err => {
  console.error('fetch-odds failed:', err);
  process.exit(1);
});
