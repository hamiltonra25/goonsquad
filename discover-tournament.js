// discover-tournament.js
// Run ONCE manually to find the World Cup tournament ID in OddsPapi.
// After you get the ID, hardcode it in fetch-odds.js and never run this again.

import fetch from 'node-fetch';

const API_KEY = process.env.ODDSPAPI_KEY;
const BASE    = 'https://api.oddspapi.io/v4';

async function run() {
  // Get today and 10 days out
  const from = new Date().toISOString().split('T')[0];
  const to   = new Date(Date.now() + 10*24*60*60*1000).toISOString().split('T')[0];

  console.log(`Fetching soccer fixtures from ${from} to ${to}...`);
  const res  = await fetch(`${BASE}/fixtures?sportId=10&from=${from}&to=${to}&apiKey=${API_KEY}`);
  const data = await res.json();

  if (!Array.isArray(data)) {
    console.log('Unexpected response:', JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }

  console.log(`Got ${data.length} fixtures total`);

  // Find World Cup fixtures
  const wc = data.filter(f => f.tournamentName === 'World Cup' || f.tournamentSlug === 'world-cup');
  console.log(`\nWorld Cup fixtures found: ${wc.length}`);
  if (wc.length > 0) {
    console.log('\nSample fixture:');
    console.log(JSON.stringify(wc[0], null, 2));
    console.log(`\n=== TOURNAMENT ID: ${wc[0].tournamentId} ===`);
    console.log('Use this in fetch-odds.js as ODDSPAPI_WC_TOURNAMENT_ID');
  } else {
    // Show unique tournament names to help identify
    const tournaments = [...new Set(data.map(f => `${f.tournamentName} (id:${f.tournamentId})`))];
    console.log('\nAvailable tournaments:');
    tournaments.forEach(t => console.log(' -', t));
  }
}

run().catch(err => { console.error(err); process.exit(1); });
