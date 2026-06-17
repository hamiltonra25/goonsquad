// fetch-odds.js
// Runs via GitHub Actions 4x per day.
// Fetches all World Cup odds from The Odds API (DraftKings)
// and writes them to Firebase Firestore so the app can read them.

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

// ── Config ──
const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const SPORT         = 'soccer_fifa_world_cup';
const BOOKMAKER     = 'draftkings';
const MARKETS       = 'h2h,totals,spreads';
const ODDS_FORMAT   = 'american';
const REGION        = 'us';

// Map The Odds API team name variations to our display names
const TEAM_NAME_MAP = {
  'South Korea':          'Korea Republic',
  'Czech Republic':       'Czechia',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Türkiye':              'Turkey',
  'Turkey':               'Turkey',
  'Ivory Coast':          'Ivory Coast',
  "Côte d'Ivoire":        'Ivory Coast',
  'DR Congo':             'DR Congo',
  'Congo DR':             'DR Congo',
  'Cape Verde':           'Cape Verde',
  'Cabo Verde':           'Cape Verde',
  'USA':                  'USA',
  'United States':        'USA',
};

function normalizeName(name) {
  return TEAM_NAME_MAP[name] || name;
}

// Convert UTC ISO string to CT label e.g. "Sat Jun 13 · 3:00 PM CT"
function toCTLabel(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(',', ' ·') + ' CT';
}

async function fetchOdds() {
  // Fetch h2h/dc from DraftKings specifically, and spreads/totals from any sharp book
  const urlMain = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds` +
    `?apiKey=${ODDS_API_KEY}` +
    `&regions=${REGION}` +
    `&markets=h2h` +
    `&bookmakers=${BOOKMAKER}` +
    `&oddsFormat=${ODDS_FORMAT}`;

  // Spreads/totals: DraftKings often doesn't list these for soccer — use Pinnacle as best sharp line
  const urlSpreads = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds` +
    `?apiKey=${ODDS_API_KEY}` +
    `&regions=us,eu` +
    `&markets=spreads,totals` +
    `&bookmakers=pinnacle,draftkings,fanduel,betmgm` +
    `&oddsFormat=${ODDS_FORMAT}`;

  console.log('Fetching moneyline odds from DraftKings...');
  const res  = await fetch(urlMain);
  const data = await res.json();
  console.log(`Remaining credits after h2h: ${res.headers.get('x-requests-remaining')}`);

  console.log('Fetching spreads/totals from sharp books...');
  const res2   = await fetch(urlSpreads);
  const data2  = await res2.json();
  console.log(`Remaining credits after spreads: ${res2.headers.get('x-requests-remaining')}`);

  // Build a lookup for spreads/totals by event ID
  const spreadTotalMap = {};
  if (Array.isArray(data2)) {
    for (const event of data2) {
      // Pick the first bookmaker that has spreads and/or totals
      let sp = null, tot = null;
      for (const bk of event.bookmakers) {
        for (const mkt of bk.markets) {
          if (!sp && mkt.key === 'spreads' && mkt.outcomes.length >= 2) {
            const o0 = mkt.outcomes[0], o1 = mkt.outcomes[1];
            sp = { line: o0.point, homeFav: o0.price, awayDog: o1.price };
          }
          if (!tot && mkt.key === 'totals') {
            const over  = mkt.outcomes.find(o => o.name === 'Over');
            const under = mkt.outcomes.find(o => o.name === 'Under');
            if (over && under) tot = { line: over.point, over: over.price, under: under.price };
          }
        }
        if (sp && tot) break;
      }
      spreadTotalMap[event.id] = { spread: sp, total: tot };
    }
  }

  console.log(`Remaining credits: ${res.headers.get('x-requests-remaining')}`);
  console.log(`Credits used this call: ${res.headers.get('x-requests-last')}`);

  if (!Array.isArray(data)) {
    console.error('Unexpected response:', data);
    process.exit(1);
  }

  console.log(`Got ${data.length} matches`);

  const batch = db.batch();
  let matchCount = 0;

  for (const event of data) {
    const home = normalizeName(event.home_team);
    const away = normalizeName(event.away_team);
    const kickoffUTC = new Date(event.commence_time).getTime();
    const ctLabel    = toCTLabel(event.commence_time);

    // Find DraftKings bookmaker
    const dk = event.bookmakers.find(b => b.key === BOOKMAKER);
    if (!dk) continue;

    // Parse each market
    let moneyline = null, tnb = null, total = null, spread = null, dc = null;

    // Use spreadTotalMap for spreads/totals (DraftKings often doesn't list these for soccer)
    const stData = spreadTotalMap[event.id] || {};

    for (const market of dk.markets) {
      if (market.key === 'h2h') {
        // 3-way moneyline: home, draw, away
        const outcomes = market.outcomes;
        const homeOut  = outcomes.find(o => normalizeName(o.name) === home);
        const awayOut  = outcomes.find(o => normalizeName(o.name) === away);
        const drawOut  = outcomes.find(o => o.name === 'Draw');

        if (homeOut && awayOut) {
          moneyline = {
            home: homeOut.price,
            away: awayOut.price,
            draw: drawOut ? drawOut.price : null,
          };

          // Tie No Bet: derived from h2h by removing draw probability
          // If draw exists, TNB prices are roughly: p(home)/(p(home)+p(away))
          // DraftKings doesn't always provide TNB separately so we calculate
          if (drawOut) {
            // Convert to implied prob, redistribute, convert back
            const pH = 100 / (homeOut.price > 0 ? homeOut.price + 100 : Math.abs(homeOut.price) + 100 * (homeOut.price > 0 ? 1 : -1));
            const pA = 100 / (awayOut.price > 0 ? awayOut.price + 100 : Math.abs(awayOut.price) + 100 * (awayOut.price > 0 ? 1 : -1));

            function toImplied(price) {
              return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
            }
            function toAmerican(prob) {
              if (prob >= 0.5) return Math.round(-prob / (1 - prob) * 100);
              return Math.round((1 - prob) / prob * 100);
            }

            const impliedH = toImplied(homeOut.price);
            const impliedA = toImplied(awayOut.price);
            const total_p  = impliedH + impliedA;
            const tnbH = toAmerican(impliedH / total_p);
            const tnbA = toAmerican(impliedA / total_p);
            tnb = { home: tnbH, away: tnbA };
          } else {
            tnb = { home: homeOut.price, away: awayOut.price };
          }

          // Double Chance: 1X, X2, 12
          if (drawOut) {
            function dcPrice(p1, p2) {
              const i1 = toImplied(p1), i2 = toImplied(p2);
              const combined = Math.min(i1 + i2, 0.99);
              return toAmerican(combined);
            }
            function toImplied(price) {
              return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
            }
            function toAmerican(prob) {
              if (prob >= 0.5) return Math.round(-prob / (1 - prob) * 100);
              return Math.round((1 - prob) / prob * 100);
            }
            dc = {
              homeOrDraw: dcPrice(homeOut.price, drawOut.price),
              awayOrDraw: dcPrice(awayOut.price, drawOut.price),
              homeOrAway: dcPrice(homeOut.price, awayOut.price),
            };
          }
        }
      }

      if (market.key === 'totals') {
        const overOut  = market.outcomes.find(o => o.name === 'Over');
        const underOut = market.outcomes.find(o => o.name === 'Under');
        if (overOut && underOut) {
          total = {
            line:  overOut.point,
            over:  overOut.price,
            under: underOut.price,
          };
        }
      }

      if (market.key === 'spreads') {
        // Try exact name match first
        let homeOut = market.outcomes.find(o => normalizeName(o.name) === home);
        let awayOut = market.outcomes.find(o => normalizeName(o.name) === away);

        // Partial name match fallback
        if (!homeOut || !awayOut) {
          homeOut = market.outcomes.find(o =>
            home.toLowerCase().includes(normalizeName(o.name).toLowerCase()) ||
            normalizeName(o.name).toLowerCase().includes(home.toLowerCase().split(' ')[0])
          );
          awayOut = market.outcomes.find(o => o !== homeOut && (
            away.toLowerCase().includes(normalizeName(o.name).toLowerCase()) ||
            normalizeName(o.name).toLowerCase().includes(away.toLowerCase().split(' ')[0])
          ));
        }

        // Positional fallback — Odds API always returns home first
        if ((!homeOut || !awayOut) && market.outcomes.length >= 2) {
          homeOut = market.outcomes[0];
          awayOut = market.outcomes[1];
          console.log('Spread: using positional fallback for', home, 'vs', away,
            '— got', homeOut.name, 'vs', awayOut.name);
        }

        if (homeOut && awayOut) {
          spread = {
            line:    homeOut.point,
            homeFav: homeOut.price,
            awayDog: awayOut.price,
          };
        }
      }
    }

    if (!moneyline) continue; // skip if no odds at all

    // Use sharp book spread/total if DraftKings didn't provide it
    if (!spread && stData.spread) spread = stData.spread;
    if (!total  && stData.total)  total  = stData.total;

    // Final fallback defaults
    if (!total)  total  = { line: 2.5, over: -110, under: -110 };
    if (!spread) spread = { line: -0.5, homeFav: -110, awayDog: -110 };
    if (!dc)     dc     = { homeOrDraw: -200, awayOrDraw: -200, homeOrAway: -200 };
    if (!tnb)    tnb    = { home: moneyline.home, away: moneyline.away };

    const matchDoc = {
      id:          event.id,
      home,
      away,
      kickoffUTC,
      ctLabel,
      moneyline,
      tnb,
      total,
      spread,
      dc,
      updatedAt:   new Date().toISOString(),
    };

    const ref = db.collection('matches').doc(event.id);
    batch.set(ref, matchDoc);
    matchCount++;
  }

  // Write metadata doc so the app knows when odds were last updated
  const metaRef = db.collection('meta').doc('odds');
  batch.set(metaRef, {
    lastUpdated: new Date().toISOString(),
    matchCount,
  });

  await batch.commit();
  console.log(`✓ Wrote ${matchCount} matches to Firebase`);
}

fetchOdds().catch(err => {
  console.error('fetch-odds failed:', err);
  process.exit(1);
});
