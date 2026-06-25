// restore-matches.js — run ONCE to restore missing match documents
// Czechia vs Mexico (id1000001666456912) and South Africa vs Korea Republic (id1000001666456914)
// These were deleted by fetch-odds but have pending bets referencing them

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});
const db = getFirestore();

const matches = [
  {
    id: 'id1000001666456912',
    home: 'Czechia',
    away: 'Mexico',
    kickoffUTC: new Date('2026-06-25T01:00:00.000Z').getTime(),
    ctLabel: 'Wed · Jun 24, 8:00 PM CT',
    // Moneyline from when bets were placed
    moneyline: { home: 285, draw: 290, away: -111 },
    tnb: { home: 203, away: -203 },
    total: { line: 2.5, over: -110, under: -110 },
    spread: { line: -0.5, awayLine: 0.5, homeFav: -110, awayDog: -110 },
    dc: { homeOrDraw: -107, awayOrDraw: -360, homeOrAway: -367 },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'id1000001666456914',
    home: 'South Africa',
    away: 'Korea Republic',
    kickoffUTC: new Date('2026-06-25T01:00:00.000Z').getTime(),
    ctLabel: 'Wed · Jun 24, 8:00 PM CT',
    moneyline: { home: 450, draw: 300, away: -156 },
    tnb: { home: 335, away: -335 },
    total: { line: 2.5, over: -110, under: -110 },
    spread: { line: -0.5, awayLine: 0.5, homeFav: -110, awayDog: -110 },
    dc: { homeOrDraw: 132, awayOrDraw: -611, homeOrAway: -379 },
    updatedAt: new Date().toISOString(),
  },
];

for (const match of matches) {
  const { id, ...data } = match;
  await db.collection('matches').doc(id).set(data);
  console.log(`✓ Restored: ${data.home} vs ${data.away} (${id})`);
}

console.log('Done — both match documents restored.');
