// fix-egypt-bet.js
// Reverses R3's incorrect Egypt ML win (500 wager, 710 toWin)
// and corrects the balance

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});

const db = getFirestore();

async function run() {
  // Find the bet
  const snap = await db.collection('bets')
    .where('player', '==', 'R3')
    .where('status', '==', 'won')
    .get();

  const egyptBet = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .find(b =>
      b.wager === 500 &&
      b.toWin === 710 &&
      (b.matchLabel?.toLowerCase().includes('egypt') ||
       b.matchLabel?.toLowerCase().includes('australia'))
    );

  if (!egyptBet) {
    console.log('Could not find the Egypt bet. Dumping all R3 won bets:');
    snap.docs.forEach(d => {
      const b = d.data();
      console.log(`  ${d.id}: ${b.matchLabel} | wager:${b.wager} toWin:${b.toWin} | ${b.optionLabel}`);
    });
    return;
  }

  console.log(`Found bet: ${egyptBet.id}`);
  console.log(`  Match: ${egyptBet.matchLabel}`);
  console.log(`  Pick: ${egyptBet.optionLabel}`);
  console.log(`  Wager: ${egyptBet.wager} | ToWin: ${egyptBet.toWin}`);

  // Get current R3 balance
  const balDoc = await db.collection('balances').doc('R3').get();
  const currentBal = balDoc.data().amount;
  console.log(`\nCurrent R3 balance: ${currentBal}`);

  // Reverse the win: remove wager + toWin that was credited
  // When won: balance += toWin (wager was already deducted when placed)
  // To reverse: balance -= toWin, then mark as lost (no further deduction needed, wager already gone)
  const newBal = currentBal - egyptBet.wager - egyptBet.toWin;
  console.log(`New R3 balance: ${newBal} (removed +${egyptBet.toWin} win payout and +${egyptBet.wager} wager refund)`);

  // Update bet status to lost
  await db.collection('bets').doc(egyptBet.id).update({ status: 'lost' });
  console.log(`✓ Bet ${egyptBet.id} marked as lost`);

  // Update balance
  await db.collection('balances').doc('R3').set({ amount: newBal });
  console.log(`✓ R3 balance updated: ${currentBal} → ${newBal}`);
}

run().catch(err => { console.error(err); process.exit(1); });
