// Items: what a special pull grants, what the caps withhold, and what each item does —
// above all Fortify, the only item that takes anything from anybody.
//
// Time is simulated the way game.test.js does it: by winding stored clocks backwards,
// never by waiting. Territory tests use Hoods 1, 13, 16 and 25, which are pairwise
// non-adjacent, so the adjacency cooldown never gets in the way unless a test wants it.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-items-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, isoPlusHours, config, parks, editions, items, game, views, seasons;

before(async () => {
  ({ db, nowIso, isoPlusHours } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  parks = await import('../server/lib/parks.js');
  editions = await import('../server/lib/editions.js');
  items = await import('../server/lib/items.js');
  game = await import('../server/lib/game.js');
  views = await import('../server/lib/views.js');
  seasons = await import('../server/lib/seasons.js');
  // Uncapped unless a test says otherwise: most tests here need a player holding several
  // items, and the cap has tests of its own below.
  config.ITEM_WEEKLY_CAP = 0;
});

let alice, bob, carol;
let seq = 0;
let parkSeq = 7000;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/i${seq}.jpg`,
    path_display: `display/i${seq}.webp`,
    path_thumb: `thumb/i${seq}.webp`,
    width: 1200, height: 900, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

const addPark = (hoodId = 13, value = 5) => {
  parkSeq += 1;
  db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
              VALUES (?, ?, ?, 43.65, -79.38, ?, 1, ?)`)
    .run(parkSeq, `Item Park ${parkSeq}`, hoodId, value, parkSeq);
  return parkSeq;
};

const withConfig = (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return fn(); } finally { Object.assign(config, was); }
};

const force = (key) => (n) => {
  const r = editions.editionRates();
  if (key === 'hologram') return 0;
  if (key === 'gold') return Math.round((r.hologram / 100) * n);
  return n - 1;
};

const pick = (type) => () => {
  let offset = 0;
  for (const t of items.ITEM_TYPES) {
    if (t === type) return offset;
    offset += Math.round(config.ITEM_WEIGHTS[t] * 1000);
  }
  throw new Error(`no item type ${type}`);
};

/** Collect a fresh park with a forced edition and item type. Returns the whole result. */
const pull = (playerId, { edition = 'gold', type = 'recon', hoodId = 13, value = 5 } = {}) =>
  parks.commitCollect({
    parkId: addPark(hoodId, value), playerId, photo: photo(), rand: force(edition), itemRand: pick(type),
  });

/** One item of a type, in hand. */
const give = (playerId, type) => pull(playerId, { type }).items.items[0].grant_id;

const claim = (hoodId, playerId, type, extra = {}) =>
  game.commitClaim({ hoodId, playerId, declaredType: type, photo: photo(), ...extra });

const unlock = (hoodId) => db.prepare('UPDATE hood_state SET locked_until = NULL WHERE hood_id = ?').run(hoodId);
const lock = (hoodId) => db.prepare('UPDATE hood_state SET locked_until = ? WHERE hood_id = ?')
  .run(isoPlusHours(nowIso(), 5), hoodId);
const state = (hoodId) => db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId);
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };
const check = (hoodId, playerId, extra = {}) => game.evaluateClaim({ hoodId, playerId, ...extra });

/** Bob holds Hood 13 with a landmark, unlocked, with a Fortify armed on it. */
const fortified = () => {
  claim(13, bob, 'landmark');
  unlock(13);
  const grantId = give(bob, 'fortify');
  items.armFortify({ playerId: bob, grantId, hoodId: 13 });
  return grantId;
};

beforeEach(() => {
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  db.exec('UPDATE hoods SET ever_conquered = 0, escalations = 0, unclaimed_value = difficulty');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM vehicles; DELETE FROM parks; DELETE FROM players');
  db.exec('UPDATE seasons SET items_expired = 0');
  parks.forgetSetSize();
  parkSeq = 7000;

  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
  carol = makePlayer(`carol${seq}`);
});

// ── granting ──────────────────────────────────────────────────────────────
describe('what a pull grants', () => {
  test('Gold grants exactly one item, Hologram three, Steel none', () => {
    assert.equal(pull(alice, { edition: 'gold' }).items.items.length, 1);
    assert.equal(pull(alice, { edition: 'hologram' }).items.items.length, 3);
    const steel = pull(alice, { edition: 'steel' }).items;
    assert.equal(steel.items.length, 0);
    assert.equal(steel.wanted, 0, 'Steel never asks for one');
    assert.equal(count('SELECT COUNT(*) AS n FROM item_grants WHERE player_id = ?', alice), 4);
  });

  test('a grant records who pulled it, the season, and the week', () => {
    const { claim: card, items: granted } = pull(alice, { type: 'sprint' });
    const row = db.prepare('SELECT * FROM item_grants WHERE id = ?').get(granted.items[0].grant_id);
    assert.equal(row.player_id, alice);
    assert.equal(row.claim_id, card.claim_id);
    assert.equal(row.item_type, 'sprint');
    assert.equal(row.season_id, seasons.activeSeason().id);
    assert.match(row.week_key, /^\d{4}-W\d{2}$/);
  });

  test('no points, no items: a Gold past the Hood’s park cap grants nothing', () => {
    withConfig({ PARK_HOOD_CAP: 5 }, () => {
      pull(alice, { edition: 'steel', value: 5 });
      const past = pull(alice, { edition: 'gold', value: 5 });
      assert.equal(past.claim.points, 0);
      assert.equal(past.claim.edition, 'gold', 'the card still came out gold');
      assert.deepEqual(past.items.items, []);
      assert.equal(past.items.reason, 'no_points');
      assert.equal(count('SELECT COUNT(*) AS n FROM item_grants'), 0);
    });
  });

  test('past the weekly item cap: no grant, but full XP and the edition', () => {
    withConfig({ ITEM_WEEKLY_CAP: 4 }, () => {
      pull(alice, { edition: 'hologram' });     // 3
      pull(alice, { edition: 'gold' });         // 4
      const past = pull(alice, { edition: 'gold' });
      assert.equal(past.claim.edition, 'gold');
      assert.equal(past.xp.edition_xp, editions.EDITIONS.find((e) => e.key === 'gold').xp,
        'every bit of the Gold XP');
      assert.ok(past.claim.points > 0, 'and its points');
      assert.deepEqual(past.items.items, []);
      assert.equal(past.items.reason, 'weekly_cap');
      assert.equal(past.items.withheld, 1);
      assert.equal(items.itemCapacity(alice).granted, 4);
    });
  });

  test('a Hologram with one slot left grants one, not none', () => {
    withConfig({ ITEM_WEEKLY_CAP: 4 }, () => {
      pull(alice, { edition: 'hologram' });
      const clamped = pull(alice, { edition: 'hologram' });
      assert.equal(clamped.items.items.length, 1, 'min(), like every other cap');
      assert.equal(clamped.items.withheld, 2);
    });
  });

  test('the weekly cap is per player', () => {
    withConfig({ ITEM_WEEKLY_CAP: 3 }, () => {
      pull(alice, { edition: 'hologram' });
      assert.equal(pull(bob, { edition: 'hologram' }).items.items.length, 3);
    });
  });

  test('a card thrown out by flags takes its items with it, and gives the slots back', () => {
    const { claim: card, items: granted } = pull(alice, { type: 'recon' });
    game.revertClaim(card.claim_id);
    assert.equal(code(() => items.heldGrant(alice, granted.items[0].grant_id)), 'ITEM_NOT_HELD');
    assert.equal(items.inventoryOf(alice).held, 0);
    assert.equal(items.itemCapacity(alice).granted, 0);
  });
});

// ── spending ──────────────────────────────────────────────────────────────
describe('spending an item', () => {
  test('double-spend is impossible: one grant, two uses, one succeeds', () => {
    const grantId = give(alice, 'clover');
    items.useItem({ playerId: alice, grantId });
    assert.equal(code(() => items.useItem({ playerId: alice, grantId })), 'ITEM_ALREADY_USED');

    // And the schema says so on its own, whatever the application code does.
    assert.throws(() => db.prepare(`
      INSERT INTO item_uses (grant_id, player_id, item_type, created_at)
      VALUES (?, ?, 'clover', ?)`).run(grantId, alice, nowIso()), /UNIQUE/);
    assert.equal(count('SELECT COUNT(*) AS n FROM item_uses WHERE grant_id = ?', grantId), 1);
  });

  test('only the player who pulled it can spend it', () => {
    const grantId = give(alice, 'clover');
    assert.equal(code(() => items.useItem({ playerId: bob, grantId })), 'ITEM_NOT_HELD');
  });

  test('an inventory is grants minus uses', () => {
    give(alice, 'recon');
    give(alice, 'recon');
    const clover = give(alice, 'clover');
    items.useItem({ playerId: alice, grantId: clover });
    const inv = items.inventoryOf(alice);
    assert.equal(inv.held, 2);
    assert.equal(inv.counts.recon, 2);
    assert.equal(inv.counts.clover, 0);
    assert.equal(inv.clover.active, true);
  });
});

// ── Fortify ───────────────────────────────────────────────────────────────
describe('Fortify', () => {
  test('consumes on the first steal, touches nothing, writes no claim, and shuts the attacker out', () => {
    fortified();
    const before = state(13);
    const claims = count('SELECT COUNT(*) AS n FROM claims');
    const photos = count('SELECT COUNT(*) AS n FROM photos');

    const result = claim(13, alice, 'person');
    assert.equal(result.blocked, true);
    assert.deepEqual(state(13), before, 'hood_state is untouched');
    assert.equal(count('SELECT COUNT(*) AS n FROM claims'), claims, 'no claim row is written');
    assert.equal(count('SELECT COUNT(*) AS n FROM photos'), photos + 1, 'the photo is spent, and kept');

    const use = db.prepare("SELECT * FROM item_uses WHERE item_type = 'fortify'").get();
    assert.equal(use.player_id, bob, 'the defender spent it');
    assert.equal(use.target_player_id, alice, 'on the attacker');
    assert.equal(use.target_hood_id, 13);
    assert.equal(count('SELECT COUNT(*) AS n FROM item_armed'), 0, 'and it is gone');

    const after = check(13, alice);
    assert.equal(after.error, 'FORTIFY_COOLDOWN');
    const hours = (Date.parse(after.available_at) - Date.parse(use.created_at)) / 3600_000;
    assert.equal(hours, config.FORTIFY_COOLDOWN_HOURS);
    assert.match(result.message, /fortified/i, 'the copy reads like getting caught');
  });

  test('one Fortify, one block: the next steal goes through', () => {
    fortified();
    assert.equal(claim(13, alice, 'person').blocked, true);
    const next = claim(13, carol, 'person');
    assert.equal(next.blocked, false);
    assert.equal(state(13).owner_id, carol);
  });

  test('the cooldown is that attacker on that Hood, and nothing wider', () => {
    fortified();
    claim(16, bob, 'landmark');
    unlock(16);
    assert.equal(claim(13, alice, 'person').blocked, true);

    assert.ok(check(13, carol, { declaredType: 'person' }).ok, 'another player can steal it now');
    const elsewhere = claim(16, alice, 'person');
    assert.equal(elsewhere.blocked, false, 'and she can steal somewhere else now');
    assert.equal(state(16).owner_id, alice);
  });

  test('the cooldown lifts after its hour', () => {
    fortified();
    claim(13, alice, 'person');
    db.prepare("UPDATE item_uses SET created_at = ? WHERE item_type = 'fortify'")
      .run(isoPlusHours(nowIso(), -config.FORTIFY_COOLDOWN_HOURS));
    assert.ok(check(13, alice, { declaredType: 'person' }).ok);
  });

  test('its armed state reaches its owner and nobody else', () => {
    fortified();
    const mine = views.listHoods(bob).find((h) => h.id === 13);
    assert.equal(mine.viewer.fortified, true);

    const theirs = views.listHoods(alice).find((h) => h.id === 13);
    assert.equal('fortified' in theirs.viewer, false, 'not false — absent');
    assert.ok(!JSON.stringify(views.listHoods(alice)).includes('fortified'),
      'nothing in anybody else’s Hood list so much as mentions it');
    assert.ok(!JSON.stringify(views.hoodDetail(13, alice)).includes('fortified'));
  });

  test('arming: only on a Hood you hold, one per Hood, and free to take back', () => {
    const grantId = fortified();
    const spare = give(bob, 'fortify');
    const alices = give(alice, 'fortify');

    assert.equal(code(() => items.armFortify({ playerId: alice, grantId: alices, hoodId: 13 })), 'ITEM_WRONG_TARGET');
    assert.equal(code(() => items.armFortify({ playerId: bob, grantId: spare, hoodId: 13 })), 'HOOD_ALREADY_ARMED');
    assert.equal(code(() => items.useItem({ playerId: bob, grantId })), 'ITEM_ALREADY_USED',
      'an armed Fortify cannot be spent anywhere else');
    assert.equal(code(() => items.armFortify({ playerId: bob, grantId: give(bob, 'recon'), hoodId: 13 })),
      'ITEM_WRONG_TARGET', 'only a Fortify arms');

    items.disarmFortify({ playerId: bob, hoodId: 13 });
    assert.equal(items.inventoryOf(bob).counts.fortify, 2, 'disarming hands it back');
    assert.equal(claim(13, alice, 'person').blocked, false, 'and the Hood is open again');
  });

  test('a reversal that hands the Hood back disarms whoever armed it', () => {
    claim(13, bob, 'landmark');
    unlock(13);
    const steal = claim(13, carol, 'person').claim;
    const grantId = give(carol, 'fortify');
    items.armFortify({ playerId: carol, grantId, hoodId: 13 });

    game.revertClaim(steal.id);
    assert.equal(state(13).owner_id, bob);
    assert.equal(count('SELECT COUNT(*) AS n FROM item_armed'), 0);
    assert.equal(items.inventoryOf(carol).counts.fortify, 1, 'and she has it back to use elsewhere');
  });
});

// ── Recon ─────────────────────────────────────────────────────────────────
describe('Recon', () => {
  test('says whether a Hood is fortified, before you travel', () => {
    fortified();
    claim(16, bob, 'landmark');
    const yes = items.useItem({ playerId: alice, grantId: give(alice, 'recon'), targetHoodId: 13 });
    const no = items.useItem({ playerId: alice, grantId: give(alice, 'recon'), targetHoodId: 16 });
    assert.equal(yes.fortified, true);
    assert.equal(no.fortified, false);
    assert.equal(items.armedFortifyOn(13).player_id, bob, 'looking does not disarm it');
  });

  test('is for somebody else’s Hood', () => {
    claim(13, alice, 'landmark');
    const grantId = give(alice, 'recon');
    assert.equal(code(() => items.useItem({ playerId: alice, grantId, targetHoodId: 13 })), 'ITEM_WRONG_TARGET');
    assert.equal(code(() => items.useItem({ playerId: alice, grantId, targetHoodId: 25 })), 'ITEM_WRONG_TARGET');
    assert.equal(items.inventoryOf(alice).counts.recon, 1, 'a refused use spends nothing');
  });
});

// ── Crowbar and Sprint ────────────────────────────────────────────────────
describe('Crowbar and Sprint', () => {
  test('a Crowbar opens the lock, and is spent only on a steal that lands', () => {
    claim(13, bob, 'landmark');
    const crowbar = give(alice, 'crowbar');

    const locked = check(13, alice, { declaredType: 'person' });
    assert.equal(locked.error, 'HOOD_LOCKED');
    assert.equal(locked.bypassable_with, 'crowbar', 'so the sheet can offer it');

    // A claim that fails for another reason spends nothing.
    assert.equal(code(() => claim(13, alice, 'landmark', { useGrantId: crowbar })), 'SAME_TYPE');
    assert.equal(count('SELECT COUNT(*) AS n FROM item_uses'), 0);

    const result = claim(13, alice, 'person', { useGrantId: crowbar });
    assert.equal(state(13).owner_id, alice);
    assert.equal(result.item_used.item_type, 'crowbar');
    assert.equal(code(() => items.heldGrant(alice, crowbar)), 'ITEM_ALREADY_USED');
  });

  test('a Crowbar brought to a Hood that is not locked is kept', () => {
    claim(13, bob, 'landmark');
    unlock(13);
    const crowbar = give(alice, 'crowbar');
    const result = claim(13, alice, 'person', { useGrantId: crowbar });
    assert.equal(result.item_used, null);
    assert.equal(result.item_kept.grant_id, crowbar);
    assert.equal(items.inventoryOf(alice).counts.crowbar, 1);
  });

  test('a Fortify still fires on a crowbarred steal, and the Crowbar survives it', () => {
    fortified();
    lock(13);
    const crowbar = give(alice, 'crowbar');
    assert.equal(claim(13, alice, 'person', { useGrantId: crowbar }).blocked, true);
    assert.ok(items.heldGrant(alice, crowbar), 'the claim never landed, so the Crowbar was not spent');
  });

  test('a Sprint gets a conquer past the adjacency cooldown', () => {
    claim(13, alice, 'landmark');
    const neighbour = db.prepare('SELECT neighbour_id AS id FROM hood_neighbours WHERE hood_id = 13 LIMIT 1').get().id;
    const blocked = check(neighbour, alice);
    assert.equal(blocked.error, 'ADJACENT_COOLDOWN');
    assert.equal(blocked.bypassable_with, 'sprint');

    const sprint = give(alice, 'sprint');
    const result = claim(neighbour, alice, 'animal', { useGrantId: sprint });
    assert.equal(state(neighbour).owner_id, alice);
    assert.equal(result.item_used.item_type, 'sprint');
  });

  test('each opens its own gate only, and no other item opens a claim', () => {
    claim(13, alice, 'landmark');
    const neighbour = db.prepare('SELECT neighbour_id AS id FROM hood_neighbours WHERE hood_id = 13 LIMIT 1').get().id;
    const crowbar = give(alice, 'crowbar');
    assert.equal(code(() => claim(neighbour, alice, 'animal', { useGrantId: crowbar })), 'ADJACENT_COOLDOWN');
    assert.ok(items.heldGrant(alice, crowbar));

    const recon = give(alice, 'recon');
    assert.equal(code(() => claim(neighbour, alice, 'animal', { useGrantId: recon })), 'ITEM_WRONG_TARGET');
    assert.equal(code(() => items.useItem({ playerId: alice, grantId: crowbar, targetHoodId: 13 })),
      'ITEM_WRONG_TARGET', 'and a Crowbar is not used on its own');
  });
});

// ── Tune-Up ───────────────────────────────────────────────────────────────
describe('Tune-Up', () => {
  test('opens the reinforce gate now, and the reinforce spends it', () => {
    claim(13, bob, 'landmark');
    const waiting = check(13, bob);
    assert.equal(waiting.error, 'REINFORCE_TOO_SOON');
    assert.equal(waiting.bypassable_with, 'tuneup');

    const before = state(13);
    items.useItem({ playerId: bob, grantId: give(bob, 'tuneup'), targetHoodId: 13 });
    assert.deepEqual(state(13), before, 'it never writes hood_state');
    assert.ok(check(13, bob, { declaredType: 'person' }).ok);

    claim(13, bob, 'person');
    assert.equal(check(13, bob).error, 'REINFORCE_TOO_SOON', 'one Tune-Up, one early reinforce');
  });

  test('a reversal of the reinforce it paid for gives it back', () => {
    claim(13, bob, 'landmark');
    items.useItem({ playerId: bob, grantId: give(bob, 'tuneup'), targetHoodId: 13 });
    const reinforce = claim(13, bob, 'person').claim;
    game.revertClaim(reinforce.id);
    assert.ok(check(13, bob, { declaredType: 'person' }).ok,
      'last_claim_at rewound, so the Tune-Up it was spent against counts again');
  });

  test('refused on a gate that is already open, or on a Hood that is not yours', () => {
    claim(13, bob, 'landmark');
    const tuneup = give(bob, 'tuneup');
    assert.equal(code(() => items.useItem({ playerId: alice, grantId: give(alice, 'tuneup'), targetHoodId: 13 })),
      'ITEM_WRONG_TARGET');
    db.prepare('UPDATE hood_state SET last_claim_at = ? WHERE hood_id = 13')
      .run(isoPlusHours(nowIso(), -config.REINFORCE_GATE_HOURS));
    assert.equal(code(() => items.useItem({ playerId: bob, grantId: tuneup, targetHoodId: 13 })), 'ITEM_WRONG_TARGET');
    assert.equal(items.inventoryOf(bob).counts.tuneup, 1);
  });
});

// ── precedence ────────────────────────────────────────────────────────────
describe('cooldown precedence', () => {
  test('with two gates shut, the error names the one that comes first', () => {
    fortified();
    claim(13, alice, 'person');          // caught: the Fortify cooldown is now running
    lock(13);                            // and the post-handover lock too

    assert.equal(check(13, alice, { declaredType: 'person' }).error, 'HOOD_LOCKED',
      'the lock comes before the Fortify cooldown');
    assert.equal(check(13, alice, { declaredType: 'person', bypass: { lock: true } }).error, 'FORTIFY_COOLDOWN',
      'a Crowbar gets past the lock and straight into the cooldown behind it');

    unlock(13);
    assert.equal(check(13, alice, { declaredType: 'landmark' }).error, 'FORTIFY_COOLDOWN',
      'and a time gate is named ahead of a wrong subject');
  });
});

// ── rollover ──────────────────────────────────────────────────────────────
describe('season rollover', () => {
  test('unspent items expire, armed Fortifies disarm, and a second run changes nothing', () => {
    fortified();
    const recon = give(bob, 'recon');
    const season = seasons.activeSeason();

    const result = items.expireSeasonItems(season.id);
    assert.equal(result.disarmed, 1);
    assert.equal(count('SELECT COUNT(*) AS n FROM item_armed'), 0);
    assert.deepEqual(result.players.map((p) => [p.player_id, p.items]), [[bob, { fortify: 1, recon: 1 }]]);
    assert.match(items.expiryMessage(result), /1 Fortify, 1 Recon/);

    const grants = count('SELECT COUNT(*) AS n FROM item_grants');
    assert.equal(items.expireSeasonItems(season.id), null, 'guarded, so nothing is posted twice');
    assert.equal(count('SELECT COUNT(*) AS n FROM item_grants'), grants);

    // Next season, a grant from this one is not spendable.
    const other = db.prepare('SELECT id FROM seasons WHERE id != ? ORDER BY id LIMIT 1').get(season.id).id;
    db.prepare('UPDATE item_grants SET season_id = ?').run(other);
    assert.equal(code(() => items.heldGrant(bob, recon)), 'ITEM_NOT_HELD');
    assert.equal(items.inventoryOf(bob).held, 0);
  });

  test('a season with nothing unspent says nothing', () => {
    const result = items.expireSeasonItems(seasons.activeSeason().id);
    assert.deepEqual(result.players, []);
    assert.equal(items.expiryMessage(result), null);
  });
});
