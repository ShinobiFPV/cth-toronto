// Collectables: a park card and a car card are two kinds of one thing — a card in a
// binder. This suite holds that in place: everything that reads cards goes through one
// registry, and treats every kind the same way, so a third kind is a registry entry
// rather than a second copy of the binder.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-collectables-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, collectables, parks, cars, vehicles, trades, views, game, xp;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  collectables = await import('../server/lib/collectables.js');
  parks = await import('../server/lib/parks.js');
  cars = await import('../server/lib/cars.js');
  vehicles = await import('../server/lib/vehicles.js');
  trades = await import('../server/lib/trades.js');
  views = await import('../server/lib/views.js');
  game = await import('../server/lib/game.js');
  xp = await import('../server/lib/xp.js');
});

let alice, bob;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/k${seq}.jpg`,
    path_display: `display/k${seq}.webp`,
    path_thumb: `thumb/k${seq}.webp`,
    width: 1200, height: 900, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

// Always Steel, so nothing here depends on the dice.
const steel = (n) => n - 1;

const park = (parkId, playerId) =>
  parks.commitCollect({ parkId, playerId, photo: photo(), rand: steel }).claim;

const car = (playerId, make, model) => cars.commitCar({
  identification: vehicles.resolveIdentification({
    is_vehicle: true, in_situ: true, make, model, generation: null, trim: null,
    year_range: null, body_style: 'sedan', confidence: 0.9, plates: [],
  }),
  playerId, hoodId: 13, photo: photo(), rand: steel,
}).card;

beforeEach(() => {
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM vehicles; DELETE FROM parks; DELETE FROM players');
  parks.forgetSetSize();

  const ins = db.prepare(`
    INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
    VALUES (?, ?, ?, 43.65, -79.38, ?, ?, ?)`);
  ins.run(4001, 'Registry Park', 13, 20, 2.0, 1);
  ins.run(4002, 'Far Registry Park', 25, 90, 24.0, 2);

  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
});

describe('the registry', () => {
  test('names every kind of card, and each brings the same three functions', () => {
    assert.deepEqual(collectables.CARD_KINDS, ['park', 'car']);
    for (const entry of collectables.COLLECTABLES) {
      assert.ok(entry.label && entry.noun, `${entry.kind} needs a label and a noun`);
      for (const fn of ['cardsOf', 'getCard', 'summary']) {
        assert.equal(typeof entry[fn], 'function', `${entry.kind} is missing ${fn}`);
      }
    }
    assert.equal(collectables.isCardKind('conquer'), false, 'territory is not a card');
    assert.equal(collectables.isCardKind('sighting'), false, 'nor is a repeat car sighting');
  });

  test('every kind of card carries the fields every card has', () => {
    const cards = [park(4001, alice), car(alice, 'Honda', 'Civic')];
    for (const c of cards) {
      for (const field of ['kind', 'claim_id', 'name', 'edition', 'player', 'holder', 'traded', 'season']) {
        assert.ok(field in c, `a ${c.kind} card has no ${field}`);
      }
    }
    assert.deepEqual(cards.map((c) => c.name), ['Registry Park', 'Honda Civic']);
  });
});

describe('one binder', () => {
  test('holds every kind of card together, newest first', () => {
    const first = park(4001, alice);
    const second = car(alice, 'Honda', 'Civic');
    const third = park(4002, alice);

    const binder = collectables.cardsOf(alice);
    assert.deepEqual(binder.map((c) => c.claim_id), [third.claim_id, second.claim_id, first.claim_id]);
    assert.deepEqual(binder.map((c) => c.kind), ['park', 'car', 'park']);
  });

  test('narrows to one kind when asked, and to nothing for a kind it does not know', () => {
    park(4001, alice);
    car(alice, 'Honda', 'Civic');
    assert.deepEqual(collectables.cardsOf(alice, { kind: 'car' }).map((c) => c.kind), ['car']);
    assert.deepEqual(collectables.cardsOf(alice, { kind: 'park' }).map((c) => c.kind), ['park']);
    assert.deepEqual(collectables.cardsOf(alice, { kind: 'stamp' }), []);
  });

  test('one lookup serves every kind of card, and nothing that is not one', () => {
    const p = park(4001, alice);
    const c = car(alice, 'Honda', 'Civic');
    const territory = game.commitClaim({ hoodId: 1, playerId: alice, declaredType: 'landmark', photo: photo() }).claim;

    assert.equal(collectables.getCard(p.claim_id).kind, 'park');
    assert.equal(collectables.getCard(c.claim_id).kind, 'car');
    assert.equal(collectables.getCard(territory.id), null);
    assert.equal(collectables.getCard(999999), null);
  });

  test('the totals are the sum of the kinds, and each kind keeps its own detail', () => {
    park(4002, alice);                       // 90 points
    car(alice, 'Honda', 'Civic');            // CAR_POINTS
    car(alice, 'Mazda', 'CX-5');

    const s = collectables.binderSummary(alice);
    assert.equal(s.cards_held, 3);
    assert.equal(s.season_collected, 3);
    assert.equal(s.season_points, s.kinds.park.season_points + s.kinds.car.season_points);
    assert.deepEqual(s.by_edition, { steel: 3 });
    assert.equal(s.kinds.park.cards_held, 1);
    assert.equal(s.kinds.car.cards_held, 2);
    assert.ok('parks_total' in s.kinds.park, 'a park knows the size of its set');
    assert.ok('capacity' in s.kinds.car, 'and a car knows its weekly cap');
  });
});

describe('everything that reads a card treats every kind the same', () => {
  test('a trade side is the card itself, whatever kind', () => {
    const mine = car(alice, 'Honda', 'Civic');
    const theirs = park(4002, bob);
    const { id } = trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id, wantClaimId: theirs.claim_id,
    });
    const trade = trades.getTrade(id);
    assert.deepEqual([trade.offer.kind, trade.offer.name, trade.offer.card.kind], ['car', 'Honda Civic', 'car']);
    assert.deepEqual([trade.want.kind, trade.want.name, trade.want.card.kind], ['park', 'Far Registry Park', 'park']);
  });

  test('trading moves the card between binders and no points, for either kind', () => {
    const mine = car(alice, 'Honda', 'Civic');
    const theirs = park(4002, bob);
    const before = { board: views.leaderboard(), alice: xp.xpOf(alice), bob: xp.xpOf(bob) };

    const { id } = trades.offerTrade({
      fromId: alice, toId: bob, offerClaimId: mine.claim_id, wantClaimId: theirs.claim_id,
    });
    trades.acceptTrade({ tradeId: id, playerId: bob });

    assert.deepEqual(collectables.cardsOf(bob).map((c) => c.kind), ['car']);
    assert.deepEqual(collectables.cardsOf(alice).map((c) => c.kind), ['park']);
    assert.deepEqual(views.leaderboard(), before.board);
    assert.equal(xp.xpOf(alice), before.alice);
    assert.equal(xp.xpOf(bob), before.bob);
  });

  test('the feed marks every card the same way, and territory not at all', () => {
    park(4001, alice);
    car(alice, 'Honda', 'Civic');
    game.commitClaim({ hoodId: 1, playerId: alice, declaredType: 'landmark', photo: photo() });

    const feed = views.feed({ viewerId: bob });
    const byKind = Object.fromEntries(feed.map((c) => [c.claim_kind, c.card]));
    assert.equal(byKind.park.kind, 'park');
    assert.equal(byKind.car.kind, 'car');
    assert.equal(byKind.conquer, null);
  });
});
