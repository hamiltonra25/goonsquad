// settle-scores.js
// Runs via GitHub Actions every hour at :30 past.
// Fetches completed World Cup 2026 fixtures from football-data.org,
// matches them to Firebase matches by team name,
// and auto-settles all pending bets.

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

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const WC_COMPETITION_ID = 2000; // football-data.org World Cup ID

// Team name normalization
const TEAM_MAP = {
  'South Korea':                'Korea Republic',
  'Korea Republic':             'Korea Republic',
  'Czech Republic':             'Czechia',
  'Czechia':                    'Czechia',
  'Bosnia and Herzegovina':     'Bosnia & Herz.',
  'Bosnia & Herzegovina':       'Bosnia & Herz.',
  'Bosnia-Herzegovina':         'Bosnia & Herz.',
  'Bosnia Herzegovina':         'Bosnia & Herz.',
  'Curaçao':                    'Curaçao',
  'Curacao':                    'Curaçao',
  'Türkiye':                    'Turkey',
  'Turkiye':                    'Turkey',
  'Turkey':                     'Turkey',
  "Côte d'Ivoire":              'Ivory Coast',
  'Ivory Coast':                'Ivory Coast',
  'DR Congo':                   'DR Congo',
  'Congo DR':                   'DR Congo',
  'Democratic Republic of Congo': 'DR Congo',
  'United States':              'USA',
  'USA':                        'USA',
  'Cabo Verde':                 'Cape Verde',
  'Cape Verde':                 'Cape Verde',
};

function norm(name) {
  return TEAM_MAP[name] || name;
}

function teamsMatch(apiName, ourName) {
  const a = norm(apiName).toLowerCase().trim();
  const b = ourName.toLowerCase().trim();
  if (a === b) return true;
  const aFirst = a.split(' ')[0];
  const bFirst = b.split(' ')[0];
  return aFirst === bFirst && aFirst.length > 3;
}

function resolveBet(bet, homeScore, awayScore, match) {
  const diff       = homeScore - awayScore;
  const totalGoals = homeScore + awayScore;

  if (bet.betType === 'Moneyline') {
    if (bet.optionKey === 'home_win') return diff > 0  ? 'won' : 'lost';
    if (bet.optionKey === 'draw')     return diff === 0 ? 'won' : 'lost';
    if (bet.optionKey === 'away_win') return diff < 0  ? 'won' : 'lost';
  }
  if (bet.betType === 'Tie No Bet') {
    if (diff === 0) return 'push';
    if (bet.optionKey === 'tnb_home') return diff > 0 ? 'won' : 'lost';
    if (bet.optionKey === 'tnb_away') return diff < 0 ? 'won' : 'lost';
  }
  if (bet.betType === 'Total Goals') {
    const line = match?.total?.line ?? 2.5;
    if (totalGoals === line) return 'push';
    if (bet.optionKey === 'over')  return totalGoals > line ? 'won' : 'lost';
    if (bet.optionKey === 'under') return totalGoals < line ? 'won' : 'lost';
  }
  if (bet.betType === 'Spread') {
    const line    = match?.spread?.line ?? 0;
    const covered = diff - line;
    if (covered === 0) return 'push';
    if (bet.optionKey === 'spread_home') return covered > 0 ? 'won' : 'lost';
    if (bet.optionKey === 'spread_away') return covered < 0 ? 'won' : 'lost';
  }
  if (bet.betType === 'Double Chance') {
    if (bet.optionKey === 'dc_1x') return diff >= 0 ? 'won' : 'lost';
    if (bet.optionKey === 'dc_x2') return diff <= 0 ? 'won' : 'lost';
    if (bet.optionKey === 'dc_12') return diff !== 0 ? 'won' : 'lost';
  }
  return 'lost';
}

async function run() {
  // football-data.org: get all finished WC 2026 fixtures
  const url = `https://api.football-data.org/v4/competitions/${WC_COMPETITION_ID}/matches?status=FINISHED`;
  const res  = await fetch(url, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`football-data.org error ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  const matches = data.matches || [];
  console.log(`Got ${matches.length} finished fixtures from football-data.org`);

  if (matches.length === 0) {
    console.log('No finished fixtures yet — nothing to settle.');
    process.exit(0);
  }

  // Load Firebase data
  const [matchSnap, betSnap, balanceSnap, scoresSnap] = await Promise.all([
    db.collection('matches').get(),
    db.collection('bets').get(),
    db.collection('balances').get(),
    db.collection('scores').get(),
  ]);

  const fbMatches  = matchSnap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
  const fbBets     = betSnap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
  const fbBalances = {};
  balanceSnap.docs.forEach(d => { fbBalances[d.id] = d.data().amount; });
  const settledIds = new Set(scoresSnap.docs.map(d => d.id));

  let totalSettled = 0;

  for (const fixture of matches) {
    const apiHome   = fixture.homeTeam.name;
    const apiAway   = fixture.awayTeam.name;
    const duration    = fixture.score?.duration || 'REGULAR';
    // Always settle on 90-minute result (regularTime), not fullTime
    // fullTime includes extra time goals for knockout matches
    // regularTime is ONLY the 90-minute score
    const scoreNode   = fixture.score?.regularTime || fixture.score?.fullTime;
    const homeScore   = scoreNode?.home;
    const awayScore   = scoreNode?.away;

    if (duration !== 'REGULAR') {
      console.log(`Note: ${apiHome} vs ${apiAway} went to ${duration} — settling on 90-min score (${homeScore}-${awayScore})`);
    }

    if (homeScore === null || homeScore === undefined ||
        awayScore === null || awayScore === undefined) {
      console.log(`Skipping ${apiHome} vs ${apiAway} — no score yet`);
      continue;
    }

    // Find matching Firebase match
    const fbMatch = fbMatches.find(m =>
      teamsMatch(apiHome, m.home) && teamsMatch(apiAway, m.away)
    );

    if (!fbMatch) {
      console.log(`No Firebase match for: ${apiHome} vs ${apiAway}`);
      continue;
    }

    if (settledIds.has(fbMatch.firestoreId)) {
      console.log(`Already settled: ${fbMatch.home} vs ${fbMatch.away}`);
      continue;
    }

    const pendingBets = fbBets.filter(b =>
      b.matchId === fbMatch.firestoreId && b.status === 'pending'
    );

    console.log(`Settling: ${fbMatch.home} ${homeScore}–${awayScore} ${fbMatch.away} | ${pendingBets.length} pending bets`);

    for (const bet of pendingBets) {
      const result = resolveBet(bet, homeScore, awayScore, fbMatch);
      await db.collection('bets').doc(bet.firestoreId).update({ status: result });

      const currentBal = fbBalances[bet.player] ?? 3500;
      if (result === 'won') {
        const newBal = currentBal + bet.wager + bet.toWin;
        await db.collection('balances').doc(bet.player).set({ amount: newBal });
        fbBalances[bet.player] = newBal;
      } else if (result === 'push') {
        const newBal = currentBal + bet.wager;
        await db.collection('balances').doc(bet.player).set({ amount: newBal });
        fbBalances[bet.player] = newBal;
      }
    }

    // Record score in Firebase so Commissioner tab shows it
    await db.collection('scores').doc(fbMatch.firestoreId).set({
      homeScore, awayScore,
      settledAt: new Date().toISOString(),
      auto: true,
    });

    settledIds.add(fbMatch.firestoreId);
    totalSettled += pendingBets.length;
    console.log(`✓ ${fbMatch.home} ${homeScore}–${awayScore} ${fbMatch.away}`);
  }

  console.log(`\nDone. Bets settled this run: ${totalSettled}`);

  // Write last-checked timestamp to Firebase so app can display it
  await db.collection('meta').doc('scores').set({
    lastUpdated: new Date().toISOString(),
    settledThisRun: totalSettled,
  }, { merge: true });
}

run().catch(err => {
  console.error('settle-scores failed:', err);
  process.exit(1);
});
