// verify-scores.js
// Run manually via GitHub Actions to compare football-data.org results
// against what's stored in Firebase scores collection.

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

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const WC_COMPETITION_ID = 2000;

const TEAM_MAP = {
  'South Korea': 'Korea Republic', 'Czech Republic': 'Czechia',
  'Bosnia and Herzegovina': 'Bosnia & Herz.', 'Bosnia-Herzegovina': 'Bosnia & Herz.',
  'Bosnia & Herzegovina': 'Bosnia & Herz.', 'Türkiye': 'Turkey', 'Turkiye': 'Turkey',
  "Côte d'Ivoire": 'Ivory Coast', 'DR Congo': 'DR Congo', 'Congo DR': 'DR Congo',
  'United States': 'USA', 'Cabo Verde': 'Cape Verde', 'Curaçao': 'Curaçao', 'Curacao': 'Curaçao',
};
function norm(n) { return TEAM_MAP[n] || n; }
function teamsMatch(a, b) {
  const an = norm(a).toLowerCase(), bn = b.toLowerCase();
  if (an === bn) return true;
  return an.split(' ')[0] === bn.split(' ')[0] && an.split(' ')[0].length > 3;
}

async function run() {
  const res  = await fetch(`https://api.football-data.org/v4/competitions/${WC_COMPETITION_ID}/matches?status=FINISHED`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
  });
  const data = await res.json();
  const fixtures = data.matches || [];

  const [matchSnap, scoresSnap] = await Promise.all([
    db.collection('matches').get(),
    db.collection('scores').get(),
  ]);

  const fbMatches = matchSnap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
  const fbScores  = {};
  scoresSnap.docs.forEach(d => { fbScores[d.id] = d.data(); });

  console.log(`\n${'='.repeat(65)}`);
  console.log(`SCORE VERIFICATION — ${fixtures.length} finished fixtures`);
  console.log(`${'='.repeat(65)}\n`);

  let matched = 0, mismatched = 0, notFound = 0, notSettled = 0;

  for (const f of fixtures) {
    const apiHome  = f.homeTeam.name;
    const apiAway  = f.awayTeam.name;
    const apiHS    = f.score?.fullTime?.home;
    const apiAS    = f.score?.fullTime?.away;
    const label    = `${norm(apiHome)} vs ${norm(apiAway)}`;

    const fbMatch  = fbMatches.find(m => teamsMatch(apiHome, m.home) && teamsMatch(apiAway, m.away));

    if (!fbMatch) {
      console.log(`❓ NOT IN FIREBASE: ${label} (${apiHS}–${apiAS})`);
      notFound++;
      continue;
    }

    const saved = fbScores[fbMatch.firestoreId];
    if (!saved) {
      console.log(`⚠️  NOT SETTLED:    ${label} — API: ${apiHS}–${apiAS}`);
      notSettled++;
      continue;
    }

    const scoreMatch = saved.homeScore === apiHS && saved.awayScore === apiAS;
    if (scoreMatch) {
      console.log(`✅ OK:             ${label} — ${apiHS}–${apiAS}`);
      matched++;
    } else {
      console.log(`❌ MISMATCH:       ${label}`);
      console.log(`   Firebase: ${saved.homeScore}–${saved.awayScore}  |  API: ${apiHS}–${apiAS}`);
      mismatched++;
    }
  }

  console.log(`\n${'='.repeat(65)}`);
  console.log(`✅ Matched:    ${matched}`);
  console.log(`❌ Mismatched: ${mismatched}`);
  console.log(`⚠️  Not settled: ${notSettled}`);
  console.log(`❓ Not in FB:  ${notFound}`);
  console.log(`${'='.repeat(65)}\n`);

  if (mismatched > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
