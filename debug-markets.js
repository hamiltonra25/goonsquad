// debug-markets.js — dumps ALL available markets for current WC fixtures from Pinnacle
// Run once to see what market IDs are available for totals

import fetch from 'node-fetch';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});

const API_KEY = process.env.ODDSPAPI_KEY;
const BASE    = 'https://api.oddspapi.io/v4';

// Fetch WITHOUT marketIds filter so we get everything Pinnacle has
const url = `${BASE}/odds-by-tournaments?tournamentIds=16&bookmaker=pinnacle&oddsFormat=american&apiKey=${API_KEY}`;
console.log('Fetching ALL markets from Pinnacle (no filter)...\n');

const res = await fetch(url);
if (!res.ok) throw new Error(`Error ${res.status}: ${await res.text()}`);
const fixtures = await res.json();
console.log(`Got ${fixtures.length} fixtures\n`);

for (const f of fixtures.slice(0, 3)) { // show first 3 fixtures
  const markets = f.bookmakerOdds?.pinnacle?.markets || {};
  const marketIds = Object.keys(markets);
  console.log(`=== ${f.participant1Name} vs ${f.participant2Name} ===`);
  console.log(`Market IDs: ${marketIds.join(', ')}`);
  
  for (const [mId, market] of Object.entries(markets)) {
    const outcomes = Object.entries(market.outcomes || {});
    const sample = outcomes[0];
    const player = sample ? Object.values(sample[1].players || {})[0] : null;
    const line = player?.handicap ?? player?.line ?? '';
    const price = player?.priceAmerican ?? '';
    console.log(`  Market ${mId}: ${outcomes.length} outcomes | sample line:${line} price:${price}`);
  }
  console.log();
}
