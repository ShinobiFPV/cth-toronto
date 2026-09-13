// Trading cards.
//
// The invariant worth protecting above all others: a trade moves the card and leaves
// every score exactly where it was. Six friends who can hand each other cards could
// otherwise hand each other 100-pointers, and the season table would stop meaning
// anything. XP is even clearer — it is defined as how long you have been doing this,
// and you cannot give somebody else your own activity.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-trades-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, parks, trades, leaderboard, revertClaim, xpOf, garage, vehicles;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  parks = await import('../server/lib/parks.js');
  garage = await import('../server/lib/garage.js');
  vehicles = await import('../server/lib/vehicles.js');
  trades = await import('../server/lib/trades.js');
  ({ leaderboard } = await import('../server/lib/views.js'));
  ({ revertClaim } = await import('../server/lib/game.js'));
  ({ xpOf } = await import('../server/lib/xp.js'));
});

const PARKS = [
  { id: 6001, name: 'Corner Parkette', hood_id: 13, value: 5, distance_km: 0.4, set_number: 1 },
  { id: 6002, name: 'Midtown Green', hood_id: 13, value: 40, distance_km: 6.0, set_number: 2 },
  { id: 6003, name: 'Far Ravine', hood_id: 25, value: 95, distance_km: 24.0, set_number: 3 },
  { id: 6004, name: 'Edge of the World', hood_id: 25, value: 100, distance_km: 26.0, set_number: 4 },
];

let alice, bob, carol;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/t${seq}.jpg`,
    path_display: `display/t${seq}.webp`,
    path_thumb: `thumb/t${seq}.webp`,
    width: 1200, height: 900, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

const collect = (parkId, playerId, caption = null) =>
  parks.commitCollect({ parkId, playerId, photo: photo(), caption });

const points = (playerId) => db.prepare(`
  SELECT COALESCE(SUM(points_awarded), 0) AS p FROM claims
   WHERE player_id = ? AND status != 'reverted'`).get(playerId).p;

const binder = (playerId) => parks.cardsOf(playerId).map((c) => c.park.name).sort();

beforeEach(() => {
  // Holdings and trades reference claims, so with foreign_keys ON they have to go first.
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM vehicles; DELETE FROM parks; DELETE FROM players');
  parks.forgetSetSize();

  const ins = db.prepare(`
    INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
    VALUES (@id, @name, @hood_id, 43.65, -79.38, @value, @distance_km, @set_number)`);
  for (const p of PARKS) ins.run(p);

  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
  carol = makePlayer(`carol${seq}`);
});

// ── the thing that must never break ───────────────────────────────────────
describe('a trade moves the card, never the score', () => {
  test('points stay with whoever walked there', () => {
    const mine = collect(6004, alice).claim;      // 100 points
    const theirs = collect(6001, bob).claim;      // 5 points

    assert.equal(points(alice), 100);
    assert.equal(points(bob), 5);

    const { id } = trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id, wantClaimId: theirs.claim_id,
    });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.equal(points(alice), 100, 'alice keeps the points for the park she walked to');
    assert.equal(points(bob), 5, 'and bob keeps his');

    // The ledger rows themselves are untouched.
    const row = db.prepare('SELECT player_id, points_awarded, xp_awarded FROM claims WHERE id = ?')
      .get(mine.claim_id);
    assert.equal(row.player_id, alice, 'claims.player_id is never reassigned');
    assert.equal(row.points_awarded, 100);
  });

  test('XP stays put too, because activity is not transferable', () => {
    const mine = collect(6004, alice).claim;
    const before = { alice: xpOf(alice), bob: xpOf(bob) };
    assert.ok(before.alice > 0);

    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.equal(xpOf(alice), before.alice);
    assert.equal(xpOf(bob), before.bob);
  });

  test('the standings do not move', () => {
    const mine = collect(6004, alice).claim;
    const rank = (rows, id) => rows.find((r) => r.player.id === id).points;
    const was = leaderboard();

    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    const now = leaderboard();
    assert.equal(rank(now, alice), rank(was, alice));
    assert.equal(rank(now, bob), rank(was, bob));
  });
});

// ── across collection types ───────────────────────────────────────────────
describe('a Not Wheels package trades like a card', () => {
  const snap = (playerId, make, model, rand = () => 1) => garage.commitCar({
    identification: vehicles.resolveIdentification({
      is_vehicle: true, in_situ: true, make, model, generation: null, trim: null,
      year_range: null, body_style: null, confidence: 0.9, plates: [],
    }),
    playerId, hoodId: 13, photo: photo(), rand,
  }).package;

  test('a package for a park card moves no points, no XP and no standings', () => {
    const pack = snap(alice, 'Honda', 'Civic', () => 0);    // a hologram, for the most XP
    const card = collect(6004, bob).claim;                  // the most points

    const was = { board: leaderboard(), alice: xpOf(alice), bob: xpOf(bob) };
    const { id } = trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: pack.claim_id, wantClaimId: card.claim_id,
    });
    const trade = trades.getTrade(id);
    assert.equal(trade.offer.kind, 'car');
    assert.equal(trade.offer.name, 'Honda Civic');
    assert.equal(trade.offer.edition, 'hologram');
    assert.equal(trade.want.kind, 'park');
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.deepEqual(leaderboard(), was.board, 'the whole table is byte-identical');
    assert.equal(xpOf(alice), was.alice);
    assert.equal(xpOf(bob), was.bob);

    assert.deepEqual(garage.packagesOf(bob).map((p) => p.claim_id), [pack.claim_id]);
    assert.equal(garage.packagesOf(bob)[0].player.id, alice, 'it remembers who snapped it');
    assert.deepEqual(binder(alice), ['Edge of the World']);
  });

  test('each shelf counts only its own trades', () => {
    const pack = snap(alice, 'Honda', 'Civic');
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: pack.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.equal(garage.garageSummary(alice).packages_given_away, 1);
    assert.equal(garage.garageSummary(bob).packages_received, 1);
    assert.equal(parks.collectionSummary(alice).cards_given_away, 0, 'a package is not a park card');
    assert.equal(parks.collectionSummary(bob).cards_received, 0);
    assert.equal(garage.garageSummary(alice).season_collected, 1, 'and she still collected it');
  });

  test('a reverted package cannot be offered', () => {
    const pack = snap(alice, 'Honda', 'Civic');
    revertClaim(pack.claim_id);
    assert.throws(() => trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: pack.claim_id }),
      (err) => { assert.equal(err.code, 'CARD_REVERTED'); return true; });
  });
});

// ── what a trade does do ──────────────────────────────────────────────────
describe('trading a card', () => {
  test('swaps which binder each card is in', () => {
    const mine = collect(6004, alice).claim;
    const theirs = collect(6001, bob).claim;

    const { id } = trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id, wantClaimId: theirs.claim_id,
    });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.deepEqual(binder(alice), ['Corner Parkette']);
    assert.deepEqual(binder(bob), ['Edge of the World']);
  });

  test('a card remembers who photographed it', () => {
    const mine = collect(6004, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    const [card] = parks.cardsOf(bob);
    assert.equal(card.player.id, alice, 'the credit for going there does not transfer');
    assert.equal(card.holder.id, bob);
    assert.equal(card.traded, true);
    assert.ok(card.acquired_at);
  });

  test('the card art does not change hands with the card', () => {
    const mine = collect(6004, alice).claim;
    const before = parks.getCardByClaim(mine.claim_id).card_seed;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });
    assert.equal(parks.getCardByClaim(mine.claim_id).card_seed, before,
      'it is the same physical card, so it looks the same');
  });

  test('an offer with nothing wanted is a gift', () => {
    const mine = collect(6002, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    const trade = trades.getTrade(id);
    assert.equal(trade.is_gift, true);
    assert.equal(trade.want, null);

    trades.acceptTrade({ tradeId: id, playerId: bob });
    assert.deepEqual(binder(alice), []);
    assert.deepEqual(binder(bob), ['Midtown Green']);
  });

  test('a binder may hold two cards of the same park', () => {
    // Duplicates are the currency of trading. What stays capped is collecting.
    const mine = collect(6002, alice).claim;
    const theirs = collect(6002, bob).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.deepEqual(binder(bob), ['Midtown Green', 'Midtown Green']);
    assert.notEqual(mine.card_seed, theirs.card_seed, 'and they are visibly different cards');
  });

  test('collecting is still once per park per season', () => {
    collect(6002, alice);
    assert.throws(() => collect(6002, alice), (err) => {
      assert.equal(err.code, 'ALREADY_COLLECTED');
      return true;
    });
  });

  test('a card can be traded on again', () => {
    const mine = collect(6003, alice).claim;
    const first = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: first.id, playerId: bob });
    const second = trades.offerTrade({ fromId: bob, toId: carol, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: second.id, playerId: carol });

    assert.deepEqual(binder(carol), ['Far Ravine']);
    assert.deepEqual(binder(bob), []);
    const held = trades.holdingOf(mine.claim_id);
    assert.equal(held.holder_id, carol);
    assert.equal(held.from_player_id, bob, 'and it remembers the last pair of hands');
    assert.equal(held.collector_id, alice);
  });

  test('the summary separates what you collected from what you hold', () => {
    const mine = collect(6004, alice).claim;      // 100
    collect(6001, alice);                          // 5
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    const a = parks.collectionSummary(alice);
    assert.equal(a.season_collected, 2, 'she collected two');
    assert.equal(a.season_points, 105, 'and scored both, whatever she did with them after');
    assert.equal(a.cards_held, 1, 'but only holds one');
    assert.equal(a.cards_given_away, 1);
    assert.equal(a.cards_received, 0);

    const b = parks.collectionSummary(bob);
    assert.equal(b.season_collected, 0, 'bob collected nothing');
    assert.equal(b.season_points, 0, 'so bob scored nothing');
    assert.equal(b.cards_held, 1, 'and still has a card');
    assert.equal(b.cards_received, 1);
  });

  test('rarity chips describe the cards on the shelf, not the ones you took', () => {
    const mine = collect(6004, alice).claim;      // legendary
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.deepEqual(parks.collectionSummary(alice).by_rarity, {});
    assert.deepEqual(parks.collectionSummary(bob).by_rarity, { legendary: 1 });
  });
});

// ── the rules ─────────────────────────────────────────────────────────────
describe('what a trade will not let you do', () => {
  test('offer a card you do not hold', () => {
    const theirs = collect(6001, bob).claim;
    assert.throws(() => trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: theirs.claim_id,
    }), (err) => { assert.equal(err.code, 'CARD_NOT_HELD'); return true; });
  });

  test('ask for a card they do not hold', () => {
    const mine = collect(6001, alice).claim;
    const carols = collect(6002, carol).claim;
    assert.throws(() => trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id, wantClaimId: carols.claim_id,
    }), (err) => { assert.equal(err.code, 'CARD_NOT_HELD'); return true; });
  });

  test('offer a card the group threw out', () => {
    const mine = collect(6001, alice).claim;
    revertClaim(mine.claim_id);
    assert.throws(() => trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id,
    }), (err) => { assert.equal(err.code, 'CARD_REVERTED'); return true; });
  });

  test('trade with yourself', () => {
    const mine = collect(6001, alice).claim;
    assert.throws(() => trades.offerTrade({
      fromId: alice, toId: alice, offerClaimId: mine.claim_id,
    }), (err) => { assert.equal(err.code, 'TRADE_WITH_SELF'); return true; });
  });

  test('send the same offer twice', () => {
    const mine = collect(6001, alice).claim;
    trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    assert.throws(() => trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id,
    }), (err) => { assert.equal(err.code, 'TRADE_ALREADY_OFFERED'); return true; });
  });

  test('accept an offer that was made to somebody else', () => {
    const mine = collect(6001, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    assert.throws(() => trades.acceptTrade({ tradeId: id, playerId: carol }),
      (err) => { assert.equal(err.code, 'NOT_YOUR_TRADE'); return true; });
  });

  test('accept your own offer', () => {
    const mine = collect(6001, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    assert.throws(() => trades.acceptTrade({ tradeId: id, playerId: alice }),
      (err) => { assert.equal(err.code, 'NOT_YOUR_TRADE'); return true; });
  });

  test('accept twice', () => {
    const mine = collect(6001, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });
    assert.throws(() => trades.acceptTrade({ tradeId: id, playerId: bob }),
      (err) => { assert.equal(err.code, 'TRADE_NOT_PENDING'); return true; });
  });

  test('withdraw an offer that is not yours', () => {
    const mine = collect(6001, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    assert.throws(() => trades.cancelTrade({ tradeId: id, playerId: bob }),
      (err) => { assert.equal(err.code, 'NOT_YOUR_TRADE'); return true; });
  });
});

// ── an offer is a courtesy; accepting is the ruling ───────────────────────
describe('an offer that has gone off', () => {
  test('a card traded away underneath an offer makes it stale, not wrong', () => {
    const mine = collect(6003, alice).claim;
    const toBob = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    const toCarol = trades.offerTrade({ fromId: alice, toId: carol, offerClaimId: mine.claim_id });

    // Carol gets there first.
    trades.acceptTrade({ tradeId: toCarol.id, playerId: carol });

    assert.throws(() => trades.acceptTrade({ tradeId: toBob.id, playerId: bob }),
      (err) => { assert.equal(err.code, 'TRADE_STALE'); return true; });
    assert.equal(trades.getTrade(toBob.id).status, 'stale',
      'and it stops sitting there as pending forever');
    assert.deepEqual(binder(carol), ['Far Ravine'], 'the card went where it went');
    assert.deepEqual(binder(bob), []);
  });

  test('a card reverted by flags cannot be handed over', () => {
    const mine = collect(6003, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    revertClaim(mine.claim_id);

    assert.throws(() => trades.acceptTrade({ tradeId: id, playerId: bob }),
      (err) => { assert.equal(err.code, 'TRADE_STALE'); return true; });
    assert.deepEqual(binder(bob), []);
  });

  test('a card reverted after a trade leaves the binder it was traded into', () => {
    // The group threw the photo out. It is not a card any more, wherever it ended up.
    const mine = collect(6003, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.acceptTrade({ tradeId: id, playerId: bob });
    assert.deepEqual(binder(bob), ['Far Ravine']);

    revertClaim(mine.claim_id);
    assert.deepEqual(binder(bob), [], 'a thrown-out claim is nobody’s card');
    assert.equal(points(alice), 0, 'and the points are cancelled on the collector');
  });
});

// ── the inbox ─────────────────────────────────────────────────────────────
describe('listing offers', () => {
  test('splits by direction and counts what is waiting on you', () => {
    const mine = collect(6001, alice).claim;
    const theirs = collect(6002, bob).claim;
    trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.offerTrade({ fromId: bob, toId: alice, offerClaimId: theirs.claim_id });

    const forAlice = trades.tradesFor(alice);
    assert.equal(forAlice.incoming.length, 1);
    assert.equal(forAlice.outgoing.length, 1);
    assert.equal(forAlice.pending_incoming, 1);
    assert.equal(trades.pendingCount(alice), 1);

    assert.equal(trades.tradesFor(carol).incoming.length, 0, 'and carol is not involved');
  });

  test('a resolved offer stays in the list with its outcome', () => {
    const mine = collect(6001, alice).claim;
    const { id } = trades.offerTrade({ fromId: alice, toId: bob, offerClaimId: mine.claim_id });
    trades.declineTrade({ tradeId: id, playerId: bob });

    const list = trades.tradesFor(alice);
    assert.equal(list.outgoing[0].status, 'declined');
    assert.equal(list.pending_incoming, 0);
    assert.equal(trades.pendingCount(bob), 0);
    assert.deepEqual(binder(alice), ['Corner Parkette'], 'a declined offer moves nothing');
  });
});
