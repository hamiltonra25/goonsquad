// fetch-odds.js
// Runs via GitHub Actions 4x per day (8AM, 12PM, 4PM, 8PM CT)
// Fetches World Cup 2026 odds from OddsPapi (DraftKings) — 1 request per run
// and writes them to Firebase Firestore.

import fetch from 'node-fetch';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore();

const API_KEY          = process.env.ODDSPAPI_KEY;
const BASE             = 'https://api.oddspapi.io/v4';
const WC_TOURNAMENT_ID = 16;       // World Cup 2026
const BOOKMAKER        = 'draftkings';
const ODDS_FORMAT      = 'american';

// Market IDs in OddsPapi for soccer:
// 101 = 1X2 (moneyline with draw)
// 18  = Asian Handicap (spread)
// 8   = Total Goals (over/under)
// We'll discover these from the response and parse by outcome name

const TEAM_MAP = {
  'South Korea':            'Korea Republic',
  'Czech Republic':         'Czechia',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Bosnia-Herzegovina':     'Bosnia & Herz.',
  'Türkiye':                'Turkey',
  "Côte d'Ivoire":          'Ivory Coast',
  'DR Congo':               'DR Congo',
  'Congo DR':               'DR Congo',
  'United States':          'USA',
  'Cabo Verde':             'Cape Verde',
  'Cape Verde Islands':     'Cape Verde',
  'Curaçao':                'Curaçao',
  'Curacao':                'Curaçao',
};

function norm(name) { return TEAM_MAP[name] || name; }

function toCTLabel(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(',', ' ·') + ' CT';
}

function toImplied(price) {
  return price > 0 ? 100/(price+100) : Math.abs(price)/(Math.abs(price)+100);
}
function toAmerican(prob) {
  prob = Math.min(Math.max(prob, 0.01), 0.99);
  return prob >= 0.5 ? Math.round(-prob/(1-prob)*100) : Math.round((1-prob)/prob*100);
}

async function run() {
  // ONE request to get all World Cup fixtures + DraftKings odds
  const url = `${BASE}/odds-by-tournaments?tournamentIds=${WC_TOURNAMENT_ID}&bookmaker=${BOOKMAKER}&oddsFormat=${ODDS_FORMAT}&apiKey=${API_KEY}`;
  console.log('Fetching World Cup odds from OddsPapi (1 request)...');

  const res  = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OddsPapi error ${res.status}: ${text.slice(0,300)}`);
  }

  const data = await res.json();
  const fixtures = Array.isArray(data) ? data : (data.data || []);
  console.log(`Got ${fixtures.length} fixtures`);

  let written = 0;
  const batch = db.batch();

  for (const fixture of fixtures) {
    const home = norm(fixture.participant1Name);
    const away = norm(fixture.participant2Name);
    if (!home || !away) continue;

    const kickoffUTC = new Date(fixture.startTime).getTime();
    const ctLabel    = toCTLabel(fixture.startTime);

    const dkOdds = fixture.bookmakerOdds?.[BOOKMAKER];
    if (!dkOdds || !dkOdds.markets) {
      console.log(`No DK odds for: ${home} vs ${away}`);
      continue;
    }

    const markets = dkOdds.markets;
    let moneyline = null, total = null, spread = null;

    // Parse each market by looking at outcome names
    for (const [marketId, market] of Object.entries(markets)) {
      const outcomes = market.outcomes || {};

      // ── 1X2 Moneyline ──
      // outcomes keyed by outcomeId, each has bookmakerOutcomeId: "home"/"draw"/"away"
      const homeOut = Object.values(outcomes).find(o =>
        Object.values(o.players||{}).some(p => p.bookmakerOutcomeId === 'home' || p.bookmakerOutcomeId === '1')
      );
      const drawOut = Object.values(outcomes).find(o =>
        Object.values(o.players||{}).some(p => p.bookmakerOutcomeId === 'draw' || p.bookmakerOutcomeId === 'x')
      );
      const awayOut = Object.values(outcomes).find(o =>
        Object.values(o.players||{}).some(p => p.bookmakerOutcomeId === 'away' || p.bookmakerOutcomeId === '2')
      );

      if (homeOut && awayOut && !moneyline) {
        const homePrice = Object.values(homeOut.players||{})[0]?.price;
        const drawPrice = drawOut ? Object.values(drawOut.players||{})[0]?.price : null;
        const awayPrice = Object.values(awayOut.players||{})[0]?.price;
        if (homePrice && awayPrice) {
          moneyline = { home: homePrice, away: awayPrice, draw: drawPrice };
          console.log(`  ML: ${home} ${homePrice} / Draw ${drawPrice} / ${away} ${awayPrice}`);
        }
      }

      // ── Total Goals ──
      const overOut  = Object.values(outcomes).find(o =>
        Object.values(o.players||{}).some(p =>
          p.bookmakerOutcomeId?.toLowerCase().includes('over') ||
          p.bookmakerOutcomeId === 'o'
        )
      );
      const underOut = Object.values(outcomes).find(o =>
        Object.values(o.players||{}).some(p =>
          p.bookmakerOutcomeId?.toLowerCase().includes('under') ||
          p.bookmakerOutcomeId === 'u'
        )
      );
      if (overOut && underOut && !total) {
        const overPlayer  = Object.values(overOut.players||{})[0];
        const underPlayer = Object.values(underOut.players||{})[0];
        if (overPlayer?.price && underPlayer?.price) {
          // Try to get the line from the player data
          const line = overPlayer.line ?? overPlayer.handicap ?? 2.5;
          total = { line, over: overPlayer.price, under: underPlayer.price };
          console.log(`  Total: O${line} ${overPlayer.price} / U${line} ${underPlayer.price}`);
        }
      }

      // ── Asian Handicap / Spread ──
      // Each team's outcome is identified by their name or home/away position
      const spreadOutcomes = Object.values(outcomes);
      if (spreadOutcomes.length === 2 && !spread) {
        const p1 = Object.values(spreadOutcomes[0].players||{})[0];
        const p2 = Object.values(spreadOutcomes[1].players||{})[0];
        // Check if these have handicap/line values and match our teams
        const out1Name = spreadOutcomes[0].players?.['0']?.playerName ||
                         spreadOutcomes[0].players?.['0']?.bookmakerOutcomeId || '';
        const out2Name = spreadOutcomes[1].players?.['0']?.playerName ||
                         spreadOutcomes[1].players?.['0']?.bookmakerOutcomeId || '';

        if (p1?.price && p2?.price && (p1?.handicap != null || p1?.line != null)) {
          const line1 = p1.handicap ?? p1.line ?? 0;
          const line2 = p2.handicap ?? p2.line ?? -line1;

          // Assign to home/away by matching team name in the outcome
          const out1IsHome = out1Name.toLowerCase().includes(home.toLowerCase().split(' ')[0]) ||
                             out1Name === 'home' || out1Name === '1';

          if (out1IsHome) {
            spread = { line: line1, awayLine: line2, homeFav: p1.price, awayDog: p2.price };
          } else {
            spread = { line: line2, awayLine: line1, homeFav: p2.price, awayDog: p1.price };
          }
          console.log(`  Spread: ${home} ${spread.line} (${spread.homeFav}) / ${away} ${spread.awayLine} (${spread.awayDog})`);
        }
      }
    }

    if (!moneyline) {
      console.log(`Skipping ${home} vs ${away} — no moneyline`);
      continue;
    }

    // ── Derive TNB from moneyline ──
    let tnb;
    if (moneyline.draw) {
      const iH = toImplied(moneyline.home);
      const iA = toImplied(moneyline.away);
      const tot = iH + iA;
      tnb = { home: toAmerican(iH/tot), away: toAmerican(iA/tot) };
    } else {
      tnb = { home: moneyline.home, away: moneyline.away };
    }

    // ── Derive Double Chance from moneyline ──
    let dc;
    if (moneyline.draw) {
      const iH = toImplied(moneyline.home);
      const iA = toImplied(moneyline.away);
      const iD = toImplied(moneyline.draw);
      dc = {
        homeOrDraw: toAmerican(Math.min(iH+iD, 0.99)),
        awayOrDraw: toAmerican(Math.min(iA+iD, 0.99)),
        homeOrAway: toAmerican(Math.min(iH+iA, 0.99)),
      };
    } else {
      dc = { homeOrDraw: -300, awayOrDraw: -300, homeOrAway: -200 };
    }

    // Fallbacks
    if (!total)  total  = { line: 2.5, over: -110, under: -110 };
    if (!spread) spread = { line: -0.5, awayLine: 0.5, homeFav: -110, awayDog: -110 };

    const matchDoc = {
      id:         fixture.fixtureId,
      home, away,
      kickoffUTC,
      ctLabel,
      moneyline, tnb, total, spread, dc,
      updatedAt:  new Date().toISOString(),
    };

    const ref = db.collection('matches').doc(fixture.fixtureId);
    batch.set(ref, matchDoc);
    written++;
  }

  const metaRef = db.collection('meta').doc('odds');
  batch.set(metaRef, {
    lastUpdated: new Date().toISOString(),
    matchCount:  written,
    source:      'oddspapi',
  });

  await batch.commit();
  console.log(`\n✓ Wrote ${written} matches to Firebase`);
  console.log('Requests used this run: 1');
}

run().catch(err => {
  console.error('fetch-odds failed:', err);
  process.exit(1);
});
