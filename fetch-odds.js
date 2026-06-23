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
const BOOKMAKER        = 'pinnacle';
 
// Hardcoded participant ID -> display name map
// Built from /v4/participants?sportId=10, filtered to World Cup 2026 teams
// These IDs are stable — Argentina is always 4819, Brazil always 4748, etc.
const PARTICIPANT_MAP = {
  4474: 'Argentina',       // backup
  4479: 'Bosnia & Herz.',
  4481: 'France',
  4688: 'Sweden',
  4691: 'Algeria',
  4695: 'Scotland',
  4698: 'Spain',
  4699: 'Switzerland',
  4704: 'Portugal',
  4705: 'Netherlands',
  4711: 'Germany',
  4713: 'England',
  4714: 'Czechia',
  4715: 'Croatia',
  4717: 'Belgium',
  4718: 'Austria',
  4723: 'Uzbekistan',
  4724: 'USA',
  4725: 'Uruguay',
  4729: 'Tunisia',
  4735: 'Korea Republic',
  4736: 'South Africa',
  4739: 'Senegal',
  4741: 'Australia',
  4748: 'Brazil',
  4752: 'Canada',
  4753: 'Cape Verde',
  4757: 'Ecuador',
  4758: 'Egypt',
  4764: 'Ghana',
  4766: 'IR Iran',
  4767: 'Iraq',
  4768: 'Ivory Coast',
  4770: 'Japan',
  4771: 'Jordan',
  4778: 'Morocco',
  4781: 'Mexico',
  4784: 'New Zealand',
  4789: 'Paraguay',
  4792: 'Qatar',
  4819: 'Argentina',
  4820: 'Colombia',
  4823: 'DR Congo',
  4834: 'Saudi Arabia',
  5164: 'Panama',
  7229: 'Haiti',
  7763: 'Haiti',         // backup
  22629: 'Mexico',       // backup
  35317: 'Mexico',       // backup
  55827: 'Curaçao',
  85295: 'Curaçao',      // backup
  // Norway
  4475: 'Norway',
  6044: 'Norway',
  // Turkey
  4700: 'Turkey',
  // Iran variations
  294080: 'Iran',
  // Iraq backup
  322485: 'Iraq',
  // Jordan backup
  150070: 'Jordan',
  988201: 'Jordan',
  // Ivory Coast backup
  186328: 'Ivory Coast',
  1010545: 'Ivory Coast',
  1261783: 'Ivory Coast',
  // Algeria backup
  180004: 'Algeria',
  48789: 'Algeria',
};
 
// Normalize display names for consistency
const DISPLAY_NAMES = {
  'IR Iran': 'Iran',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Bosnia & Herzegovina': 'Bosnia & Herz.',
  'Congo DR': 'DR Congo',
  'Cape Verde Islands': 'Cape Verde',
  'Cabo Verde': 'Cape Verde',
  'Curacao': 'Curaçao',
  'Korea DPR': 'Korea DPR',
  'Republic of Korea': 'Korea Republic',
  'South Korea': 'Korea Republic',
};
 
function getTeamName(id) {
  const raw = PARTICIPANT_MAP[id];
  if (!raw) return null;
  return DISPLAY_NAMES[raw] || raw;
}
 
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
  if (player.priceAmerican != null) return parseInt(player.priceAmerican, 10);
  if (player.price != null) {
    const dec = player.price;
    return dec >= 2 ? Math.round((dec-1)*100) : Math.round(-100/(dec-1));
  }
  return null;
}
 
function getLine(outcome) {
  const player = Object.values(outcome?.players || {})[0];
  return player?.handicap ?? player?.line ?? player?.spread ?? null;
}
 
async function run() {
  // ── Delete stale match documents from old APIs ──
  console.log('Cleaning up old match documents...');
  const existingSnap = await db.collection('matches').get();
  const toDelete = existingSnap.docs.filter(d => !d.id.startsWith('id'));
  if (toDelete.length > 0) {
    const deleteBatch = db.batch();
    toDelete.forEach(d => deleteBatch.delete(d.ref));
    await deleteBatch.commit();
    console.log(`Deleted ${toDelete.length} old match documents`);
  } else {
    console.log('No old documents to clean up');
  }
 
  const url = `${BASE}/odds-by-tournaments?tournamentIds=${WC_TOURNAMENT_ID}&bookmaker=${BOOKMAKER}&marketIds=101,106,18&oddsFormat=american&apiKey=${API_KEY}`;
  console.log('Fetching World Cup odds from OddsPapi (1 request)...');
 
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OddsPapi error ${res.status}: ${text.slice(0,300)}`);
  }
 
  const fixtures = await res.json();
  console.log(`Got ${fixtures.length} fixtures`);
 
  // ── Delete all existing match documents before writing fresh ones ──
  console.log('Cleaning up old match documents...');
  const existingMatches = await db.collection('matches').get();
  const deleteBatch = db.batch();
  existingMatches.docs.forEach(d => deleteBatch.delete(d.ref));
  await deleteBatch.commit();
  console.log(`Deleted ${existingMatches.docs.length} old match documents`);
 
  let written = 0, skipped = 0, unknown = 0;
  const batch = db.batch();
 
  for (const fixture of fixtures) {
    const home = getTeamName(fixture.participant1Id);
    const away = getTeamName(fixture.participant2Id);
 
    if (!home || !away) {
      console.log(`Unknown team IDs: ${fixture.participant1Id} vs ${fixture.participant2Id}`);
      unknown++;
      continue;
    }
 
    const kickoffUTC = new Date(fixture.startTime).getTime();
    const ctLabel    = toCTLabel(fixture.startTime);
    const markets    = fixture.bookmakerOdds?.[BOOKMAKER]?.markets;
 
    if (!markets || Object.keys(markets).length === 0) {
      console.log(`No markets for: ${home} vs ${away}`);
      skipped++; continue;
    }
 
    // ── Market 101: 1X2 Moneyline (outcomes 101=home, 102=draw, 103=away) ──
    let moneyline = null;
    const m101 = markets['101'];
    if (m101?.outcomes) {
      const homePrice = getPrice(m101.outcomes['101']);
      const drawPrice = getPrice(m101.outcomes['102']);
      const awayPrice = getPrice(m101.outcomes['103']);
      if (homePrice && awayPrice) {
        moneyline = { home: homePrice, away: awayPrice, draw: drawPrice };
      }
    }
 
    if (!moneyline) { console.log(`No moneyline for: ${home} vs ${away}`); skipped++; continue; }
    console.log(`${home} vs ${away}: ML ${moneyline.home}/${moneyline.draw}/${moneyline.away}`);
 
    // ── Market 106: Over/Under (outcomes 106=over, 107=under) ──
    let total = null;
    const m106 = markets['106'];
    if (m106?.outcomes) {
      const overPrice  = getPrice(m106.outcomes['106']);
      const underPrice = getPrice(m106.outcomes['107']);
      const line       = getLine(m106.outcomes['106']) ?? 2.5;
      if (overPrice && underPrice) {
        total = { line: Math.abs(line), over: overPrice, under: underPrice };
        console.log(`  Total: O${total.line} ${overPrice}/${underPrice}`);
      }
    }
 
    // ── Market 18: Asian Handicap / Spread ──
    // Outcomes: first = home team line, second = away team line
    let spread = null;
    const m18 = markets['18'];
    if (m18?.outcomes) {
      const outcomeEntries = Object.entries(m18.outcomes);
      if (outcomeEntries.length === 2) {
        const [[,o1], [,o2]] = outcomeEntries;
        const line1 = getLine(o1);
        const line2 = getLine(o2);
        const p1    = getPrice(o1);
        const p2    = getPrice(o2);
        if (line1 != null && p1 && p2) {
          // participant1 is always home team in OddsPapi
          spread = { line: line1, awayLine: line2 ?? -line1, homeFav: p1, awayDog: p2 };
          console.log(`  Spread: ${home} ${line1} (${p1}) / ${away} ${line2 ?? -line1} (${p2})`);
        }
      }
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
    matchCount: written,
    source: 'oddspapi',
  });
 
  await batch.commit();
  console.log(`\n✓ Wrote ${written} | Skipped ${skipped} | Unknown teams ${unknown}`);
}
 
run().catch(err => {
  console.error('fetch-odds failed:', err);
  process.exit(1);
});
 
