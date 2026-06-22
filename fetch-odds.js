// fetch-odds.js
// Fetches World Cup 2026 odds from OddsPapi — 1 request per run
// Tournament ID 16 = FIFA World Cup 2026
 
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
const WC_TOURNAMENT_ID = 16;
const BOOKMAKER        = 'draftkings';
 
// OddsPapi market IDs for soccer:
// 101 = 1X2 (moneyline) — outcomes: 101=home, 102=draw, 103=away
// 8   = Total Goals      — outcomes: 104=over, 105=under (or similar)
// 18  = Asian Handicap   — outcomes vary
 
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
 
// Get American price from an outcome object
function getPrice(outcome) {
  const player = Object.values(outcome?.players || {})[0];
  if (!player) return null;
  // Use priceAmerican if available, otherwise convert from decimal
  if (player.priceAmerican != null) return parseInt(player.priceAmerican, 10);
  if (player.price != null) {
    // Convert decimal to American
    const dec = player.price;
    return dec >= 2 ? Math.round((dec-1)*100) : Math.round(-100/(dec-1));
  }
  return null;
}
 
// Get handicap line from outcome player
function getLine(outcome) {
  const player = Object.values(outcome?.players || {})[0];
  return player?.handicap ?? player?.line ?? player?.spread ?? null;
}
 
async function run() {
  // Market IDs: 101=1X2 moneyline, 106=Over/Under totals
  // Asian Handicap ID to be confirmed — start with these two
  const url = `${BASE}/odds-by-tournaments?tournamentIds=${WC_TOURNAMENT_ID}&bookmaker=${BOOKMAKER}&marketIds=101,106&oddsFormat=american&apiKey=${API_KEY}`;
  console.log('Fetching World Cup odds from OddsPapi (1 request)...');
 
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OddsPapi error ${res.status}: ${text.slice(0,300)}`);
  }
 
  const data = await res.json();
  console.log('Raw response type:', typeof data, Array.isArray(data) ? 'array' : 'not-array');
  console.log('Raw response keys:', typeof data === 'object' ? Object.keys(data).join(', ') : 'N/A');
  console.log('Raw response slice:', JSON.stringify(data).slice(0, 500));
  const fixtures = Array.isArray(data) ? data : (data.data || []);
  console.log(`Got ${fixtures.length} fixtures`);
  const statusCounts = {};
  fixtures.forEach(f => { statusCounts[f.statusId] = (statusCounts[f.statusId]||0)+1; });
  console.log('Status breakdown:', JSON.stringify(statusCounts));
  const hasOddsCount = fixtures.filter(f => f.hasOdds).length;
  console.log(`hasOdds=true: ${hasOddsCount}`);
 
  // Debug: show full structure of first fixture (excluding bookmakerOdds)
  const first = fixtures[0];
  if (first) {
    const { bookmakerOdds, ...meta } = first;
    console.log('First fixture keys:', Object.keys(first).join(', '));
    console.log('First fixture meta:', JSON.stringify(meta, null, 2));
  }
 
  let written = 0, skipped = 0;
  const batch = db.batch();
 
  for (const fixture of fixtures) {
    const home = norm(fixture.participant1Name);
    const away = norm(fixture.participant2Name);
    if (!home || !away) { console.log('Skipping - no names:', fixture.participant1Name, fixture.participant2Name); continue; }
 
    const kickoffUTC = new Date(fixture.startTime).getTime();
    const ctLabel    = toCTLabel(fixture.startTime);
 
    // Direct access — we confirmed the structure is bookmakerOdds.draftkings.markets
    const dkData  = fixture.bookmakerOdds && fixture.bookmakerOdds[BOOKMAKER];
    const markets = dkData && dkData.markets;
 
    console.log(`Processing: ${home} vs ${away} | dk=${!!dkData} markets=${!!markets} keys=${markets ? Object.keys(markets).join(',') : 'none'}`);
 
    if (!markets || Object.keys(markets).length === 0) {
      console.log(`  -> No markets, skipping`);
      skipped++; continue;
    }
 
    // Log market IDs available
    const marketIds = Object.keys(markets);
    console.log(`${home} vs ${away}: markets=[${marketIds.join(',')}] hasOdds=${fixture.hasOdds}`);
 
    // ── Find 1X2 Moneyline: look for market with exactly 3 outcomes ──
    let moneyline = null;
    for (const [mId, market] of Object.entries(markets)) {
      const outcomeEntries = Object.entries(market.outcomes || {});
      if (outcomeEntries.length === 3) {
        const prices = outcomeEntries.map(([,o]) => getPrice(o));
        console.log(`  Market ${mId} (3 outcomes): prices=${JSON.stringify(prices)}`);
        if (prices[0] && prices[2]) {
          moneyline = { home: prices[0], draw: prices[1], away: prices[2] };
          console.log(`  -> ML: ${home} ${prices[0]} / Draw ${prices[1]} / ${away} ${prices[2]}`);
          break;
        }
      }
    }
 
    if (!moneyline) {
      // Last resort: dump all market outcome counts
      for (const [mId, market] of Object.entries(markets)) {
        const outs = Object.entries(market.outcomes || {});
        console.log(`  Market ${mId}: ${outs.length} outcomes, prices=${JSON.stringify(outs.map(([,o])=>getPrice(o)))}`);
      }
      console.log(`No moneyline for: ${home} vs ${away}`);
      skipped++; continue;
    }
 
    // ── Total Goals ──
    let total = null;
    for (const [mId, market] of Object.entries(markets)) {
      const outs = Object.values(market.outcomes || {});
      if (outs.length === 2) {
        const prices = outs.map(o => getPrice(o));
        const lines  = outs.map(o => getLine(o));
        if (prices[0] && prices[1] && lines[0] != null) {
          // This looks like a totals market
          const line = Math.abs(lines[0]);
          total = { line, over: prices[0], under: prices[1] };
          console.log(`  Total: O${line} ${prices[0]} / U${line} ${prices[1]}`);
          break;
        }
      }
    }
 
    // ── Asian Handicap / Spread ──
    let spread = null;
    for (const [mId, market] of Object.entries(markets)) {
      const outs = Object.entries(market.outcomes || {});
      if (outs.length === 2) {
        const [[k1, o1], [k2, o2]] = outs;
        const line1 = getLine(o1);
        const line2 = getLine(o2);
        const p1    = getPrice(o1);
        const p2    = getPrice(o2);
        if (line1 != null && line2 != null && p1 && p2 && line1 !== line2) {
          // Assign home/away by which line is negative (favored team gets negative handicap)
          spread = {
            line:     line1,
            awayLine: line2,
            homeFav:  p1,
            awayDog:  p2,
          };
          console.log(`  Spread: ${home} ${line1} (${p1}) / ${away} ${line2} (${p2})`);
          break;
        }
      }
    }
 
    // ── Derive TNB ──
    let tnb;
    if (moneyline.draw) {
      const iH = toImplied(moneyline.home);
      const iA = toImplied(moneyline.away);
      const tot = iH + iA;
      tnb = { home: toAmerican(iH/tot), away: toAmerican(iA/tot) };
    } else {
      tnb = { home: moneyline.home, away: moneyline.away };
    }
 
    // ── Derive Double Chance ──
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
 
    if (!total)  total  = { line: 2.5, over: -110, under: -110 };
    if (!spread) spread = { line: -0.5, awayLine: 0.5, homeFav: -110, awayDog: -110 };
 
    const matchDoc = {
      id: fixture.fixtureId,
      home, away, kickoffUTC, ctLabel,
      moneyline, tnb, total, spread, dc,
      updatedAt: new Date().toISOString(),
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
  console.log(`\n✓ Wrote ${written} matches to Firebase (${skipped} skipped)`);
}
 
run().catch(err => {
  console.error('fetch-odds failed:', err);
  process.exit(1);
});
 
