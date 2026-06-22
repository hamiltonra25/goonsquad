// get-participants.js — run ONCE to get participant ID -> name mapping
// Then hardcode the World Cup team IDs in fetch-odds.js

import fetch from 'node-fetch';

const API_KEY = process.env.ODDSPAPI_KEY;
const res  = await fetch(`https://api.oddspapi.io/v4/participants?sportId=10&apiKey=${API_KEY}`);
const data = await res.json();

// World Cup 2026 teams to find
const WC_TEAMS = [
  'Mexico','South Africa','Korea','Czech','Canada','Bosnia','USA','Paraguay',
  'Qatar','Switzerland','Brazil','Morocco','Haiti','Scotland','Australia','Turkey',
  'Germany','Curacao','Netherlands','Japan','Ivory Coast','Ecuador','Sweden','Tunisia',
  'Spain','Cape Verde','Belgium','Egypt','New Zealand','Saudi Arabia','Uruguay','Iran',
  'France','Senegal','Iraq','Norway','Argentina','Algeria','Austria','Jordan',
  'Portugal','Congo','England','Croatia','Ghana','Panama','Uzbekistan','Colombia'
];

const found = {};
for (const [id, name] of Object.entries(data)) {
  if (WC_TEAMS.some(t => name.toLowerCase().includes(t.toLowerCase()) ||
      t.toLowerCase().includes(name.toLowerCase().split(' ')[0]))) {
    found[id] = name;
  }
}

console.log(`Found ${Object.keys(found).length} World Cup participants:`);
console.log(JSON.stringify(found, null, 2));
