// settle-scores.js
// Runs via GitHub Actions every hour.
// Fetches completed World Cup 2026 fixtures from API-Football,
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

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const WC_LEAGUE_ID     = 1;      // FIFA World Cup 2026
const WC_SEASON        = 2026;

// Team name normalization — map API-Football names to our display names
const TEAM_MAP = {
  'South Korea':              'Korea Republic',
  'Korea Republic':           'Korea Republic',
  'Czech Republic':           'Czechia',
  'Bosnia and Herzegovina':   'Bosnia & Herz.',
  'Bosnia & Herzegovina':     'Bosnia & Herz.',
  'Turkiye':                  'Turkey',
  'Türkiye':                  'Turkey',
  "Côte d'Ivoire":            'Ivory Coast',
  'Ivory Coast':              'Ivory Coast',
  'Congo DR':                 'DR Congo',
  'DR Congo':                 'DR Congo',
  'Democratic Republic of Congo': 'DR Congo',
  'United States':            'USA',
  'USA':                      'USA',
  'Cabo Verde':               'Cape Verde',
  'Cape Verde':               'Cape Verde',
  'New Zealand':              'New Zealand',
};

function normTeam(name) {
  return TEAM_MAP[name] || name;
}

// Match two team names flexibly
function teamsMatch(apiName, ourName) {
  const a = normTeam(apiName).toLowerCase().trim();
  const b = ourName.toLowerCase().trim();
  if (a === b) return true;
  // partial match on first word (e.g. "United States" vs "USA" already handled above)
  const aFirst = a.split(' ')[0];
  const bFirst = b.split(' ')[0];
  return aFirst === bFirst && aFirst.length > 3;
}

// Resolve a bet given home/away final score
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
  // 1. Fetch all finished World Cup fixtures from API-Football
  // FT = Full Time, AET = After Extra Time, PEN = After Penalties
  const url = `https://v3.football.api-sports.io/fixtures?league=${WC_LEAGUE_ID}&season=${WC_SEASON}&status=FT-AET-PEN`;
  const res  = await fetch(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  const data = await res.json();

  if (!data.response || !Array.isArray(data.response)) {
    console.error('Unexpected API-Football response:', JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }

  console.log(`Got ${data.response.length} finished fixtures from API-Football`);
  if (data.response.length === 0) {
    // Debug: try fetching without status filter to see what's there
    const debugUrl = `https://v3.football.api-sports.io/fixtures?league=${WC_LEAGUE_ID}&season=${WC_SEASON}`;
    const debugRes = await fetch(debugUrl, { headers: { 'x-apisports-key': API_FOOTBALL_KEY } });
    const debugData = await debugRes.json();
    console.log(`Debug: total fixtures in tournament: ${debugData.response?.length ?? 0}`);
    if (debugData.response?.length > 0) {
      // Show status codes of first 10 fixtures
      const sample = debugData.response.slice(0, 10).map(f =>
        `${f.teams.home.name} vs ${f.teams.away.name} — status: ${f.fixture.status.short} (${f.fixture.status.long})`
      );
      console.log('Sample fixture statuses:\n' + sample.join('\n'));
    } else {
      console.log('Debug response:', JSON.stringify(debugData).slice(0, 500));
    }
    process.exit(0);
  }

  // 2. Load all Firebase matches and bets
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

  // 3. Load already-scored matches so we don't double-settle
  const settledMatchIds = new Set(scoresSnap.docs.map(d => d.id));

  let totalSettled = 0;

  // 4. For each finished fixture, find matching Firebase match and settle pending bets
  for (const fixture of data.response) {
    const apiHome  = fixture.teams.home.name;
    const apiAway  = fixture.teams.away.name;
    const homeScore = fixture.goals.home;
    const awayScore = fixture.goals.away;

    if (homeScore === null || awayScore === null) continue; // no score yet

    // Find matching Firebase match
    const fbMatch = fbMatches.find(m =>
      teamsMatch(apiHome, m.home) && teamsMatch(apiAway, m.away)
    );

    if (!fbMatch) {
      console.log(`No Firebase match found for: ${apiHome} vs ${apiAway}`);
      continue;
    }

    // Skip if already settled
    if (settledMatchIds.has(fbMatch.firestoreId)) {
      console.log(`Already settled: ${fbMatch.home} vs ${fbMatch.away}`);
      continue;
    }

    // Find pending bets for this match
    const pendingBets = fbBets.filter(b =>
      b.matchId === fbMatch.firestoreId && b.status === 'pending'
    );

    if (pendingBets.length === 0) {
      console.log(`No pending bets for: ${fbMatch.home} ${homeScore}-${awayScore} ${fbMatch.away}`);
      // Still record the score so commissioner tab shows it
      await db.collection('scores').doc(fbMatch.firestoreId).set({
        homeScore, awayScore, settledAt: new Date().toISOString(), auto: true,
      });
      continue;
    }

    console.log(`Settling ${pendingBets.length} bets for: ${fbMatch.home} ${homeScore}-${awayScore} ${fbMatch.away}`);

    // Settle each bet
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
      // lost: no payout, balance unchanged
    }

    // Record the score
    await db.collection('scores').doc(fbMatch.firestoreId).set({
      homeScore, awayScore, settledAt: new Date().toISOString(), auto: true,
    });

    totalSettled += pendingBets.length;
    console.log(`✓ ${fbMatch.home} ${homeScore}–${awayScore} ${fbMatch.away} — settled ${pendingBets.length} bets`);
  }

  console.log(`\nDone. Total bets settled this run: ${totalSettled}`);
}

run().catch(err => {
  console.error('settle-scores failed:', err);
  process.exit(1);
});
