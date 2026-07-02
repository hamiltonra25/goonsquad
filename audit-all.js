// audit-all.js — prints every bet for all players in chronological order with running balance
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});

const db = getFirestore();
const INITIAL = 3500;
const PLAYERS = ['R3', 'Une', 'AK', 'Brez'];

async function run() {
  const [betSnap, balSnap] = await Promise.all([
    db.collection('bets').get(),
    db.collection('balances').get(),
  ]);

  const allBets = betSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const firebaseBals = {};
  balSnap.docs.forEach(d => { firebaseBals[d.id] = d.data().amount; });

  for (const player of PLAYERS) {
    const playerBets = allBets
      .filter(b => b.player === player && !b.isSoftball)
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() || a.createdAt || 0;
        const tb = b.createdAt?.toMillis?.() || b.createdAt || 0;
        return ta - tb;
      });

    console.log('\n' + '='.repeat(110));
    console.log(`${player} — ${playerBets.length} bets | Firebase balance: ${firebaseBals[player] ?? INITIAL}`);
    console.log('='.repeat(110));

    let running = INITIAL;
    let won = 0, lost = 0, push = 0, pending = 0, other = 0;

    for (const bet of playerBets) {
      const ts = bet.createdAt?.toDate?.()
        ? bet.createdAt.toDate().toLocaleString('en-US', { timeZone: 'America/Chicago', 
            month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true })
        : 'unknown';

      const status = bet.status || 'unknown';
      let balChange = 0;

      if (status === 'won')     { balChange = bet.toWin;   won++;     }
      else if (status === 'lost')    { balChange = -bet.wager; lost++;    }
      else if (status === 'push')    { balChange = 0;          push++;    }
      else if (status === 'pending') { balChange = -bet.wager; pending++; }
      else { other++; }

      running += balChange;

      const sign = balChange > 0 ? '+' : '';
      const matchLabel = (bet.matchLabel || '').slice(0, 22).padEnd(22);
      const betType    = (bet.betType || '').slice(0, 10).padEnd(10);
      const optLabel   = (bet.optionLabel || '').slice(0, 12).padEnd(12);

      console.log(
        `${ts.padEnd(18)} | ${status.padEnd(8)} | ${matchLabel} | ${betType} | ${optLabel} | ` +
        `wager:${String(bet.wager).padStart(5)}  toWin:${String(bet.toWin).padStart(5)} | ` +
        `${(sign + balChange).padStart(6)} → ${running}`
      );
    }

    console.log('-'.repeat(110));
    const discrepancy = running - (firebaseBals[player] ?? INITIAL);
    console.log(`Calculated: ${running} | Firebase: ${firebaseBals[player] ?? INITIAL} | Discrepancy: ${discrepancy > 0 ? '+' : ''}${discrepancy} ${discrepancy === 0 ? '✓ OK' : '⚠️  MISMATCH'}`);
    console.log(`Won: ${won} | Lost: ${lost} | Push: ${push} | Pending: ${pending}${other > 0 ? ` | Other: ${other}` : ''}`);
  }

  console.log('\n' + '='.repeat(110));
  console.log('AUDIT COMPLETE');
}

run().catch(err => { console.error(err); process.exit(1); });
