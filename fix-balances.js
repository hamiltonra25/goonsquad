// fix-balances.js
// Reads all bets from Firebase, recalculates correct balances from scratch,
// compares against current balances, and fixes any discrepancies.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});

const db = getFirestore();
const INITIAL_SHARES = 3500;
const PLAYERS = ['R3', 'Une', 'AK', 'Brez'];

async function run() {
  const [betSnap, balSnap] = await Promise.all([
    db.collection('bets').get(),
    db.collection('balances').get(),
  ]);

  const bets = betSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const currentBalances = {};
  balSnap.docs.forEach(d => { currentBalances[d.id] = d.data().amount; });

  console.log('\n=== BET AUDIT ===\n');

  const correct = {};
  const issues = [];

  for (const player of PLAYERS) {
    const playerBets = bets.filter(b => b.player === player && !b.isSoftball);
    const won   = playerBets.filter(b => b.status === 'won');
    const lost  = playerBets.filter(b => b.status === 'lost');
    const push  = playerBets.filter(b => b.status === 'push');
    const pend  = playerBets.filter(b => b.status === 'pending');
    const other = playerBets.filter(b => !['won','lost','push','pending','deleted','refunded'].includes(b.status));

    const wonShares   = won.reduce((s,b) => s + (b.toWin || 0), 0);
    const lostShares  = lost.reduce((s,b) => s + (b.wager || 0), 0);
    const pushWagers  = push.reduce((s,b) => s + (b.wager || 0), 0);
    const pendWagers  = pend.reduce((s,b) => s + (b.wager || 0), 0);

    // Correct balance = start + winnings - losses + push refunds
    // Note: pending wagers are already deducted from balance when bet was placed
    const calculated = INITIAL_SHARES + wonShares - lostShares;
    const current    = currentBalances[player] ?? INITIAL_SHARES;
    const diff       = current - calculated;

    correct[player] = calculated;

    console.log(`--- ${player} ---`);
    console.log(`  Won:     ${won.length} bets, +${wonShares} shares`);
    console.log(`  Lost:    ${lost.length} bets, -${lostShares} shares`);
    console.log(`  Push:    ${push.length} bets, +${pushWagers} shares refunded`);
    console.log(`  Pending: ${pend.length} bets, ${pendWagers} shares at risk`);
    if (other.length > 0) console.log(`  Other status: ${other.map(b=>b.status+':'+b.id).join(', ')}`);
    console.log(`  Calculated correct balance: ${calculated}`);
    console.log(`  Current Firebase balance:   ${current}`);
    console.log(`  Discrepancy: ${diff > 0 ? '+' : ''}${diff} ${diff !== 0 ? '⚠️  FIXING' : '✓ OK'}`);
    console.log();

    if (diff !== 0) {
      issues.push({ player, current, calculated, diff });
    }
  }

  // Also check for push bets - their wagers should be in the balance
  // (push refunds the wager, so push bets should ADD back the wager)
  console.log('\n=== PUSH BET CHECK ===');
  for (const player of PLAYERS) {
    const pushBets = bets.filter(b => b.player === player && b.status === 'push' && !b.isSoftball);
    if (pushBets.length > 0) {
      const total = pushBets.reduce((s,b) => s + (b.wager||0), 0);
      console.log(`${player}: ${pushBets.length} push bets, ${total} shares refunded`);
    }
  }

  if (issues.length === 0) {
    console.log('\n✓ All balances correct — no fixes needed.');
    return;
  }

  console.log('\n=== FIXING BALANCES ===\n');
  for (const { player, current, calculated, diff } of issues) {
    await db.collection('balances').doc(player).set({ amount: calculated });
    console.log(`✓ Fixed ${player}: ${current} → ${calculated} (${diff > 0 ? '+' : ''}${diff} corrected)`);
  }

  console.log('\n=== DONE ===');
  console.log('All balances have been corrected based on actual bet history.');
}

run().catch(err => { console.error(err); process.exit(1); });
