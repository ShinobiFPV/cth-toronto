#!/usr/bin/env node
// Mint an invite code. The first player to register with one becomes the admin and
// can create the rest from the app.
//
//   node scripts/make-invite.js                 one code
//   node scripts/make-invite.js 5               five codes
//   node scripts/make-invite.js 5 --note "poker crew"
import { db } from '../server/db.js';
import { createInvite } from '../server/lib/auth.js';

const args = process.argv.slice(2);
const count = Math.min(Math.max(parseInt(args.find((a) => /^\d+$/.test(a)) ?? '1', 10), 1), 50);
const note = args.includes('--note') ? args[args.indexOf('--note') + 1] : null;

const players = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;

for (let i = 0; i < count; i++) console.log(createInvite({ note }));

if (players === 0) {
  console.log('\nNo players yet — whoever registers with the first code becomes the admin.');
}
db.close();
