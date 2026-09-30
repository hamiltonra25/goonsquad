// custom-audit.js — balance audit for the Custom Bets app
// Recomputes each player's balance from bet history (starting at 0) and compares
// it against the stored custom_balances. Confirms nothing is out of place after
// a reversal / undo. Read-only: it changes NOTHING.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});

const db = getFirestore();
const PLAYERS = ['R3', 'Une', 'AK', 'Brez'];

// Net effect of a bet on balance (wager is deducted at placement):
//   pending -> -wager   (at risk)
//   won     -> +toWin
//   lost    -> -wager
//   push    ->  0
function fmt(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

async function run() {
  const [betSnap, balSnap] = await Promise.all([
    db.collection('custom_bets').get(),
    db.collection('custom_balances').get(),
  ]);

  const allBets = betSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const stored = {};
  balSnap.docs.forEach(d => { stored[d.id] = d.data().amount ?? 0; });

  for (const player of PLAYERS) {
    const bets = allBets
      .filter(b => b.player === player && b.status !== 'deleted')
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0);
        const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0);
        return ta - tb;
      });

    console.log('\n' + '='.repeat(104));
    console.log(`${player} — ${bets.length} bets | stored custom balance: ${fmt(stored[player] ?? 0)}`);
    console.log('='.repeat(104));

    let running = 0;
    let won = 0, lost = 0, push = 0, pending = 0;

    for (const b of bets) {
      const ts = b.createdAt?.toDate
        ? b.createdAt.toDate().toLocaleString('en-US', { timeZone: 'America/Chicago', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true })
        : '';
      let delta = 0;
      if (b.status === 'won')     { delta = b.toWin;   won++; }
      else if (b.status === 'lost')    { delta = -b.wager; lost++; }
      else if (b.status === 'push')    { delta = 0;        push++; }
      else if (b.status === 'pending') { delta = -b.wager; pending++; }
      running += delta;

      const sign = delta > 0 ? '+' : '';
      const ev  = (b.eventTitle || '').slice(0, 28).padEnd(28);
      const opt = (b.optionLabel || '').slice(0, 20).padEnd(20);
      console.log(`${ts.padEnd(18)} | ${(b.status||'').padEnd(8)} | ${ev} | ${opt} | w:${fmt(b.wager).padStart(7)} tw:${fmt(b.toWin).padStart(7)} | ${(sign + fmt(delta)).padStart(9)} -> ${fmt(running)}`);
    }

    const computed = running;
    const storedBal = stored[player] ?? 0;
    const diff = Math.round((storedBal - computed) * 100) / 100;
    console.log('-'.repeat(104));
    console.log(`Computed from bets: ${fmt(computed)} | Stored: ${fmt(storedBal)} | Difference: ${diff > 0 ? '+' : ''}${fmt(diff)} ${diff === 0 ? '✓ MATCH' : '⚠️  (= manual Edit-Balances adjustments, if any)'}`);
    console.log(`Won: ${won} | Lost: ${lost} | Push: ${push} | Pending: ${pending}`);
  }

  console.log('\n' + '='.repeat(104));
  console.log('AUDIT COMPLETE — read-only, nothing was changed.');
  console.log('A non-zero difference is only a problem if you did NOT make a manual balance edit for that player.');
}

run().catch(err => { console.error(err); process.exit(1); });
