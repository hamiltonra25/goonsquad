// clear-fake-totals.js — removes fake total goals data from match documents
// Fake data = line: 2.5, over: -110, under: -110 (the old fallback values)
// After running, Total Goals won't show for matches without real odds

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: cert({
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
})});

const db = getFirestore();

async function run() {
  const snap = await db.collection('matches').get();
  const batch = db.batch();
  let cleared = 0, kept = 0, alreadyNull = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const total = data.total;

    if (!total) { alreadyNull++; continue; }

    // Remove if it's the fake fallback: 2.5 line, -110/-110
    const isFake = total.line === 2.5 && total.over === -110 && total.under === -110;

    if (isFake) {
      batch.update(doc.ref, { total: FieldValue.delete() });
      console.log(`Clearing fake total from: ${data.home} vs ${data.away}`);
      cleared++;
    } else {
      console.log(`Keeping real total for: ${data.home} vs ${data.away} — O${total.line} ${total.over}/${total.under}`);
      kept++;
    }
  }

  await batch.commit();
  console.log(`\n✓ Cleared ${cleared} fake totals | Kept ${kept} real totals | ${alreadyNull} already had none`);
}

run().catch(err => { console.error(err); process.exit(1); });
