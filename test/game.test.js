// The rules of the game, asserted. Spec §9: the claim state machine is the core of
// the app and everything else is presentation — so this is the file to keep honest.
//
//   npm test
//
// Runs against a throwaway database in the OS temp directory; never touches data/.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-test-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, commitClaim, evaluateClaim, revertClaim, leaderboard, config, nowIso;
let BEATEN_BY, claimSummary;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  ({ commitClaim, evaluateClaim, revertClaim } = await import('../server/lib/game.js'));
  ({ leaderboard, claimSummary } = await import('../server/lib/views.js'));
  ({ config, BEATEN_BY } = await import('../server/config.js'));
});

// ── helpers ───────────────────────────────────────────────────────────────
let nextPlayer = 0;
function makePlayer(handle) {
  const id = db.prepare(`
    INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
    VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid;
  return Number(id);
}

const photo = (n) => ({
  path_original: `original/${n}.jpg`,
  path_display: `display/${n}.webp`,
  path_thumb: `thumb/${n}.webp`,
  width: 1600, height: 900, bytes: 1234, exif_json: null,
});

let photoSeq = 0;
const claim = (hoodId, playerId, type) =>
  commitClaim({ hoodId, playerId, declaredType: type, photo: photo(++photoSeq) });

/** Wind a Hood's clocks back, standing in for the passage of real time. */
function rewind(hoodId, hours) {
  const shift = (iso) => (iso ? new Date(Date.parse(iso) - hours * 3600_000).toISOString() : iso);
  const s = db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId);
  db.prepare('UPDATE hood_state SET last_claim_at = ?, locked_until = ? WHERE hood_id = ?')
    .run(shift(s.last_claim_at), shift(s.locked_until), hoodId);
}

const state = (hoodId) => db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId);

// What a Hood is actually worth, read from the database rather than hardcoded, so a
// rebalance of the difficulty formula does not turn this file red.
const difficulty = (hoodId) =>
  db.prepare('SELECT difficulty FROM hoods WHERE id = ?').get(hoodId).difficulty;
const conquerValue = (hoodId) =>
  db.prepare('SELECT unclaimed_value FROM hoods WHERE id = ?').get(hoodId).unclaimed_value;
const stealValue = (hoodId) => difficulty(hoodId) * config.STEAL_MULTIPLIER;
const hood = (hoodId) => db.prepare('SELECT * FROM hoods WHERE id = ?').get(hoodId);
const points = (playerId) => db.prepare(`
  SELECT COALESCE(SUM(points_awarded), 0) AS p FROM claims
   WHERE player_id = ? AND status != 'reverted'`).get(playerId).p;

const expectError = (fn, code) => {
  try {
    fn();
    assert.fail(`expected ${code}, but the claim succeeded`);
  } catch (err) {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
};

let alice, bob, carol;
beforeEach(() => {
  // hood_state points at claims and players, so it is cleared before either is.
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  // Item grants join to claims by id, and ids are reused once the table is emptied.
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  // Reset the Hoods to their pristine state: never conquered, no banked escalations,
  // and worth exactly their difficulty score.
  db.exec('UPDATE hoods SET ever_conquered = 0, escalations = 0, unclaimed_value = difficulty');
  db.exec('DELETE FROM players');
  db.exec("UPDATE seasons SET escalation_applied = 0");
  alice = makePlayer(`alice${++nextPlayer}`);
  bob = makePlayer(`bob${nextPlayer}`);
  carol = makePlayer(`carol${nextPlayer}`);
});

// ── conquer ───────────────────────────────────────────────────────────────
describe('conquer', () => {
  test('any photo type takes an unclaimed Hood for its unclaimed_value', () => {
    const { claim: c } = claim(13, alice, 'landmark');
    assert.equal(c.claim_kind, 'conquer');
    assert.equal(c.points_awarded, conquerValue(13));
    assert.equal(c.points_awarded, difficulty(13), 'an un-escalated Hood pays exactly its difficulty');
    assert.equal(state(13).owner_id, alice);
    assert.equal(state(13).photo_type, 'landmark');
  });

  test('marks the Hood ever_conquered, freezing it out of seasonal escalation', () => {
    assert.equal(hood(13).ever_conquered, 0);
    claim(13, alice, 'animal');
    assert.equal(hood(13).ever_conquered, 1);
  });

  test('awards the Hood\'s current escalated value, not a flat 25', () => {
    db.prepare('UPDATE hoods SET unclaimed_value = 75 WHERE id = ?').run(25);
    const { claim: c } = claim(25, alice, 'person');
    assert.equal(c.points_awarded, 75, 'the escalated value, not the raw difficulty');
  });

  test('arms the steal cooldown — a conquer is a change of hands too', () => {
    claim(13, alice, 'landmark');
    assert.ok(state(13).locked_until > nowIso());
    expectError(() => claim(13, bob, 'person'), 'HOOD_LOCKED');
  });
});

// ── the adjacent-conquer cooldown ─────────────────────────────────────────
describe('adjacent-conquer cooldown', () => {
  // Hood 13 (Toronto Centre) borders 10, 11 and 14; 16 and 25 are nowhere near it.
  const NEIGHBOURS = [10, 11, 14];
  const DISTANT = [16, 25];

  test('conquering closes every bordering Hood to that player', () => {
    claim(13, alice, 'landmark');
    for (const n of NEIGHBOURS) {
      const err = expectError(() => claim(n, alice, 'animal'), 'ADJACENT_COOLDOWN');
      assert.ok(err.available_at, 'the error says when it opens up');
    }
  });

  test('Hoods that do not border it are unaffected', () => {
    claim(13, alice, 'landmark');
    for (const d of DISTANT) {
      assert.equal(claim(d, alice, 'animal').claim.claim_kind, 'conquer');
    }
  });

  test('it only binds the player who conquered — this is not a global lock', () => {
    claim(13, alice, 'landmark');
    expectError(() => claim(10, alice, 'animal'), 'ADJACENT_COOLDOWN');
    assert.equal(claim(10, bob, 'animal').claim.claim_kind, 'conquer',
      'bob is free to take the Hood next door to alice');
  });

  test('it expires after the configured window', () => {
    claim(13, alice, 'landmark');
    expectError(() => claim(14, alice, 'animal'), 'ADJACENT_COOLDOWN');

    // Age alice's conquer past the window rather than waiting a day for it.
    db.prepare(`UPDATE claims SET created_at = ? WHERE hood_id = 13 AND player_id = ?`)
      .run(new Date(Date.now() - (config.ADJACENT_CONQUER_COOLDOWN_HOURS + 1) * 3600_000).toISOString(),
           alice);

    assert.equal(claim(14, alice, 'animal').claim.claim_kind, 'conquer');
  });

  test('it blocks conquering only — stealing and reinforcing next door still work', () => {
    claim(14, bob, 'landmark');          // bob holds a Hood bordering 13
    rewind(14, 24);                      // clear bob's steal lock on it
    claim(13, alice, 'animal');          // alice conquers next door

    // Alice cannot conquer bob's neighbours, but 14 is held, so it is a steal — allowed.
    assert.equal(evaluateClaim({ hoodId: 14, playerId: alice }).claim_kind, 'steal');
    assert.equal(claim(14, alice, 'person').claim.claim_kind, 'steal');
  });

  test('reinforcing your own Hood is never blocked by a conquer next door', () => {
    claim(13, alice, 'landmark');

    // Age the conquer out of the cooldown so taking a bordering Hood is legal, and age
    // Hood 13 past its 72h gate so it is reinforceable.
    const past = new Date(Date.now() - (config.ADJACENT_CONQUER_COOLDOWN_HOURS + 1) * 3600_000)
      .toISOString();
    db.prepare('UPDATE claims SET created_at = ? WHERE hood_id = 13 AND player_id = ?')
      .run(past, alice);
    rewind(13, 80);

    claim(10, alice, 'animal');          // 10 borders 13 — allowed now, and it re-closes 13
    expectError(() => claim(11, alice, 'landmark'), 'ADJACENT_COOLDOWN');   // 11 borders 10

    // 13 borders 10 too, but alice holds it, so it is a reinforce and the gate does not apply.
    assert.equal(claim(13, alice, 'person').claim.claim_kind, 'reinforce');
  });

  test('a reverted conquer stops blocking — a thrown-out claim must not fence you off', () => {
    const c = claim(13, alice, 'landmark').claim;
    expectError(() => claim(10, alice, 'animal'), 'ADJACENT_COOLDOWN');
    revertClaim(c.id);
    assert.equal(claim(10, alice, 'animal').claim.claim_kind, 'conquer');
  });

  test('the cooldown chains: each new conquer closes its own neighbours', () => {
    claim(13, alice, 'landmark');                 // closes 10, 11, 14
    assert.equal(claim(16, alice, 'animal').claim.claim_kind, 'conquer');   // 16 is clear
    // 16 borders 14, 15, 17, 19, 20, 21 — so those are now closed too.
    for (const n of [15, 17, 19, 20, 21]) {
      expectError(() => claim(n, alice, 'landmark'), 'ADJACENT_COOLDOWN');
    }
  });

  test('names the Hood responsible, so the message is actionable', () => {
    claim(13, alice, 'landmark');
    const ev = evaluateClaim({ hoodId: 11, playerId: alice });
    assert.equal(ev.error, 'ADJACENT_COOLDOWN');
    assert.equal(ev.blocked_by_hood_id, 13);
    assert.match(ev.message, /Hood 13 — Toronto Centre/);
    assert.match(ev.message, /Hood 11 — University-Rosedale/);
  });

  test('setting the window to 0 disables the rule entirely', () => {
    const original = config.ADJACENT_CONQUER_COOLDOWN_HOURS;
    config.ADJACENT_CONQUER_COOLDOWN_HOURS = 0;
    try {
      claim(13, alice, 'landmark');
      assert.equal(claim(10, alice, 'animal').claim.claim_kind, 'conquer');
    } finally {
      config.ADJACENT_CONQUER_COOLDOWN_HOURS = original;
    }
  });

  test('the adjacency graph is symmetric and nobody is an island', () => {
    const rows = db.prepare('SELECT hood_id, neighbour_id FROM hood_neighbours').all();
    const edges = new Set(rows.map((r) => `${r.hood_id}-${r.neighbour_id}`));
    for (const r of rows) {
      assert.ok(edges.has(`${r.neighbour_id}-${r.hood_id}`),
        `${r.hood_id}->${r.neighbour_id} has no reverse edge`);
    }
    for (let id = 1; id <= 25; id++) {
      const n = db.prepare('SELECT COUNT(*) AS c FROM hood_neighbours WHERE hood_id = ?').get(id).c;
      assert.ok(n >= 2, `Hood ${id} has only ${n} neighbours, which cannot be right`);
    }
  });
});

// ── the counter system ────────────────────────────────────────────────────
describe('counter system', () => {
  test('animal beats person, person beats landmark, landmark beats animal', () => {
    // One Hood per pair, so each case is independent of the last — and Hoods 1, 13 and
    // 25 are pairwise non-adjacent, so alice's conquers do not trip the adjacent-conquer
    // cooldown on each other. Do not "tidy" these into 1, 2, 3.
    const cases = [[1, 'person', 'animal'], [13, 'landmark', 'person'], [25, 'animal', 'landmark']];
    for (const [hoodId, held, beater] of cases) {
      claim(hoodId, alice, held);
      rewind(hoodId, 24);
      const { claim: c } = claim(hoodId, bob, beater);
      assert.equal(c.claim_kind, 'steal', `${beater} should beat ${held}`);
      assert.equal(c.points_awarded, stealValue(hoodId));
      assert.equal(state(hoodId).owner_id, bob);
    }
  });

  test('the cycle is closed — every subject beats exactly one and loses to exactly one', () => {
    const types = ['landmark', 'person', 'animal'];
    for (const held of types) {
      const beaters = types.filter((t) => {
        db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
                 last_claim_at = NULL, locked_until = NULL WHERE hood_id = 5`);
        claim(5, alice, held);
        rewind(5, 24);
        const ok = evaluateClaim({ hoodId: 5, playerId: bob, declaredType: t }).ok;
        return ok;
      });
      assert.deepEqual(beaters, [BEATEN_BY[held]], `exactly one subject should beat ${held}`);
    }
  });

  test('a losing type is refused with WEAK_TYPE', () => {
    claim(13, alice, 'animal');
    rewind(13, 24);
    const err = expectError(() => claim(13, bob, 'person'), 'WEAK_TYPE');
    assert.deepEqual(err.required_types, ['landmark']);
  });

  test('matching the holder\'s type is refused with SAME_TYPE, not WEAK_TYPE', () => {
    claim(13, alice, 'animal');
    rewind(13, 24);
    expectError(() => claim(13, bob, 'animal'), 'SAME_TYPE');
  });
});

// ── steal ─────────────────────────────────────────────────────────────────
describe('steal', () => {
  test('pays double the difficulty, and seasonal escalation does not touch it', () => {
    // Hood 25 is the hardest in the city: difficulty 50, so stealing it pays 100.
    assert.equal(stealValue(25), 100, 'the hardest Hood tops the steal scale out at 100');

    // Escalation inflates what the Hood is worth to CONQUER, never to steal.
    db.prepare('UPDATE hoods SET unclaimed_value = 999 WHERE id = 25').run();
    claim(25, alice, 'landmark');
    rewind(25, 24);
    assert.equal(claim(25, bob, 'person').claim.points_awarded, stealValue(25));
  });

  test('is worth more the harder the Hood is', () => {
    // University-Rosedale is the easiest Hood in Toronto, Rouge Park the hardest.
    assert.ok(stealValue(11) < stealValue(25),
      'stealing downtown should not pay the same as stealing Rouge Park');
    assert.equal(stealValue(11), difficulty(11) * 2);
    assert.equal(stealValue(25), difficulty(25) * 2);
  });

  test('is locked for 12 hours after the Hood changes hands', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    claim(13, bob, 'person');

    const err = expectError(() => claim(13, alice, 'animal'), 'HOOD_LOCKED');
    assert.ok(err.available_at > nowIso());

    rewind(13, config.STEAL_COOLDOWN_HOURS + 0.1);
    assert.equal(claim(13, alice, 'animal').claim.claim_kind, 'steal');
  });

  test('the displaced player keeps every point they ever earned', () => {
    const conquer = claim(13, alice, 'landmark').claim.points_awarded;
    rewind(13, 24);
    const steal = claim(13, bob, 'person').claim.points_awarded;
    assert.equal(points(alice), conquer);
    assert.equal(points(bob), steal);
    assert.ok(steal > conquer, 'taking a Hood off somebody should beat picking it up free');
    assert.equal(state(13).owner_id, bob);
  });

  test('a Hood has exactly one holder — the old claim is superseded, not deleted', () => {
    const first = claim(13, alice, 'landmark').claim;
    rewind(13, 24);
    claim(13, bob, 'person');
    assert.equal(db.prepare('SELECT status FROM claims WHERE id = ?').get(first.id).status, 'superseded');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM hood_state WHERE hood_id = 13 AND owner_id IS NOT NULL').get().c, 1);
  });
});

// ── reinforce ─────────────────────────────────────────────────────────────
describe('reinforce', () => {
  test('is refused for 72 hours after the last claim, and reports when it opens', () => {
    claim(13, alice, 'landmark');
    const err = expectError(() => claim(13, alice, 'person'), 'REINFORCE_TOO_SOON');
    assert.ok(err.available_at, 'the error carries the eligible timestamp');

    rewind(13, config.REINFORCE_GATE_HOURS + 0.1);
    assert.equal(claim(13, alice, 'person').claim.claim_kind, 'reinforce');
  });

  test('requires the type that beats your own current photo', () => {
    claim(13, alice, 'landmark');
    rewind(13, 80);
    expectError(() => claim(13, alice, 'landmark'), 'SAME_TYPE');
    expectError(() => claim(13, alice, 'animal'), 'WEAK_TYPE');   // landmark beats animal, not the reverse
    assert.equal(claim(13, alice, 'person').claim.points_awarded, config.REINFORCE_POINTS);
    assert.equal(state(13).photo_type, 'person');
  });

  test('rotates what you are vulnerable to', () => {
    claim(13, alice, 'landmark');                       // exposed to person
    assert.deepEqual(evaluateClaim({ hoodId: 13, playerId: bob }).required_types, ['person']);
    rewind(13, 80);
    claim(13, alice, 'person');                      // now exposed to animal
    assert.deepEqual(evaluateClaim({ hoodId: 13, playerId: bob }).required_types, ['animal']);
  });

  test('pays a flat 25 however hard or valuable the Hood is', () => {
    db.prepare('UPDATE hoods SET unclaimed_value = 100 WHERE id = 25').run();
    claim(25, alice, 'landmark');            // the hardest Hood in the city
    rewind(25, 80);
    assert.equal(claim(25, alice, 'person').claim.points_awarded, config.REINFORCE_POINTS);
    assert.equal(config.REINFORCE_POINTS, 25,
      'reinforce is deliberately flat — scaling it would make the hard Hoods passive income');
  });

  test('does NOT arm the steal lock — reinforcing must not shield a Hood', () => {
    claim(13, alice, 'landmark');
    rewind(13, 80);                                   // clears the 12h lock as well
    assert.ok(!state(13).locked_until || state(13).locked_until < nowIso());
    claim(13, alice, 'person');
    assert.ok(!state(13).locked_until || state(13).locked_until < nowIso(),
      'a reinforce left the Hood stealable');
    assert.equal(claim(13, bob, 'animal').claim.claim_kind, 'steal');
  });

  test('resets the 72-hour clock each time', () => {
    claim(13, alice, 'landmark');
    rewind(13, 80);
    claim(13, alice, 'person');
    expectError(() => claim(13, alice, 'animal'), 'REINFORCE_TOO_SOON');
  });

  test('a Hood you do not hold is never a reinforce', () => {
    claim(13, alice, 'landmark');
    assert.equal(evaluateClaim({ hoodId: 13, playerId: bob }).claim_kind, 'steal');
    assert.equal(evaluateClaim({ hoodId: 13, playerId: alice }).claim_kind, 'reinforce');
  });

  test('honours a per-season reinforce cap when one is configured', () => {
    const original = config.REINFORCE_SEASON_CAP;
    config.REINFORCE_SEASON_CAP = 25;
    try {
      claim(13, alice, 'landmark');
      rewind(13, 80);
      claim(13, alice, 'person');        // 25 reinforce points — at the cap
      rewind(13, 80);
      expectError(() => claim(13, alice, 'animal'), 'REINFORCE_CAP_REACHED');
    } finally {
      config.REINFORCE_SEASON_CAP = original;
    }
  });
});

// ── flags and reversal ────────────────────────────────────────────────────
describe('flags and reversal', () => {
  test('returns the Hood to its previous holder and restores their 72h clock', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    const aliceLastClaim = state(13).last_claim_at;
    const aliceLocked = state(13).locked_until;

    const bogus = claim(13, bob, 'person').claim;
    assert.equal(state(13).owner_id, bob);

    revertClaim(bogus.id);

    assert.equal(state(13).owner_id, alice, 'the Hood went back to alice');
    assert.equal(state(13).photo_type, 'landmark');
    assert.equal(state(13).last_claim_at, aliceLastClaim, 'alice\'s reinforce clock was restored');
    assert.equal(state(13).locked_until, aliceLocked);
    assert.equal(points(bob), 0, 'the reverted points are gone');
    assert.equal(points(alice), conquerValue(13), 'alice keeps hers');
  });

  test('cancels points exactly once — the reversal row does not double-subtract', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    const c = claim(13, bob, 'person').claim;
    assert.equal(points(bob), stealValue(13));
    const { reversal } = revertClaim(c.id);
    assert.equal(reversal.claim_kind, 'reversal');
    assert.equal(points(bob), 0);
    assert.equal(leaderboard(null).find((r) => r.player.id === bob).points, 0);
  });

  test('an unclaimed Hood goes back to unclaimed, and escalation resumes', () => {
    const c = claim(13, alice, 'animal').claim;
    assert.equal(hood(13).ever_conquered, 1);
    revertClaim(c.id);
    assert.equal(state(13).owner_id, null);
    assert.equal(state(13).photo_type, null);
    assert.equal(hood(13).ever_conquered, 0, 'a bogus conquer must not freeze the Hood\'s value');
  });

  test('the restored claim becomes the live one again', () => {
    const first = claim(13, alice, 'landmark').claim;
    rewind(13, 24);
    const second = claim(13, bob, 'person').claim;
    revertClaim(second.id);
    assert.equal(state(13).active_claim_id, first.id);
    assert.equal(db.prepare('SELECT status FROM claims WHERE id = ?').get(first.id).status, 'active');
  });

  test('reverting a claim someone has already taken off you leaves territory alone', () => {
    const a = claim(13, alice, 'landmark').claim;
    rewind(13, 24);
    const b = claim(13, bob, 'person').claim;
    rewind(13, 24);
    claim(13, carol, 'animal');

    revertClaim(b.id);                     // bob's claim was already superseded

    assert.equal(state(13).owner_id, carol, 'carol keeps the Hood she legitimately took');
    assert.equal(points(bob), 0, 'but bob loses the flagged points');
    assert.equal(points(alice), conquerValue(13));
  });

  test('reverting is idempotent', () => {
    const c = claim(13, alice, 'landmark').claim;
    revertClaim(c.id);
    const again = revertClaim(c.id);
    assert.equal(again.alreadyReverted, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM claims WHERE claim_kind = 'reversal'").get().c, 1);
  });
});

// ── scoring ───────────────────────────────────────────────────────────────
describe('scoring', () => {
  test('season and champion totals come from the same ledger', () => {
    const a1 = claim(13, alice, 'landmark').claim.points_awarded;
    rewind(13, 24);
    const b1 = claim(13, bob, 'person').claim.points_awarded;
    // 16 does not border 13, so the adjacent-conquer cooldown does not apply.
    const a2 = claim(16, alice, 'animal').claim.points_awarded;

    const season = leaderboard(1);
    assert.equal(season.find((r) => r.player.id === alice).points, a1 + a2);
    assert.equal(season.find((r) => r.player.id === bob).points, b1);
    assert.deepEqual(leaderboard(null).map((r) => r.points), leaderboard(1).map((r) => r.points));
  });

  test('a different season scores zero for the same claims', () => {
    claim(13, alice, 'landmark');
    assert.equal(leaderboard(2).find((r) => r.player.id === alice).points, 0);
  });

  test('ties share a rank', () => {
    // Hoods are no longer all worth the same, so a genuine tie needs two of equal
    // difficulty. Found by query rather than hardcoded, so a rebalance cannot quietly
    // turn this into a test of something else.
    const pair = db.prepare(`
      SELECT id FROM hoods
       WHERE difficulty = (SELECT difficulty FROM hoods
                            GROUP BY difficulty HAVING COUNT(*) >= 2
                            ORDER BY difficulty LIMIT 1)
       ORDER BY id LIMIT 2`).all().map((r) => r.id);
    assert.equal(pair.length, 2, 'two Hoods of equal difficulty are needed to test a tie');

    claim(pair[0], alice, 'landmark');
    claim(pair[1], bob, 'landmark');   // a different player, so adjacency cannot interfere

    const board = leaderboard(1);
    assert.equal(board[0].points, board[1].points, 'the two should actually be level');
    assert.deepEqual(board.slice(0, 2).map((r) => r.rank), [1, 1]);
  });

  test('hoods_held counts territory, which is independent of points', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    claim(13, bob, 'person');
    const board = leaderboard(1);
    assert.equal(board.find((r) => r.player.id === alice).hoods_held, 0);
    assert.equal(board.find((r) => r.player.id === alice).points, conquerValue(13));
    assert.equal(board.find((r) => r.player.id === bob).hoods_held, 1);
  });
});

// ── preflight ─────────────────────────────────────────────────────────────
describe('evaluateClaim preflight', () => {
  test('tells an unclaimed Hood it accepts anything', () => {
    const ev = evaluateClaim({ hoodId: 13, playerId: alice });
    assert.equal(ev.ok, true);
    assert.equal(ev.claim_kind, 'conquer');
    assert.deepEqual([...ev.required_types].sort(), ['animal', 'landmark', 'person']);
  });

  test('names the single type that would work against a holder', () => {
    claim(13, alice, 'person');
    rewind(13, 24);
    const ev = evaluateClaim({ hoodId: 13, playerId: bob });
    assert.deepEqual(ev.required_types, ['animal']);
    assert.equal(ev.points, stealValue(13));
    assert.equal(ev.difficulty, difficulty(13));
  });

  test('agrees with what the claim endpoint will actually do', () => {
    claim(13, alice, 'animal');
    for (const type of ['animal', 'person', 'landmark']) {
      const ev = evaluateClaim({ hoodId: 13, playerId: bob, declaredType: type });
      if (ev.ok) {
        assert.equal(claim(13, bob, type).claim.claim_kind, ev.claim_kind);
      } else {
        expectError(() => claim(13, bob, type), ev.error);
      }
    }
  });

  test('rejects a Hood that does not exist', () => {
    assert.throws(() => evaluateClaim({ hoodId: 99, playerId: alice }), /HOOD_NOT_FOUND|no Hood/i);
  });

  test('rejects a photo type that is not one of the three', () => {
    assert.throws(() => evaluateClaim({ hoodId: 13, playerId: alice, declaredType: 'polaroid' }),
      /BAD_TYPE|must be one of/i);
  });
});

// ── the sentence everyone actually reads ──────────────────────────────────
describe('claim summaries', () => {
  test('name the player, the Hood, the subject and the points', () => {
    // Asserted as exact strings rather than patterns: the points come from the Hood's
    // difficulty now, and a regex with the number interpolated into it is one escaping
    // slip away from silently matching nothing.
    const aliceName = db.prepare('SELECT display_name FROM players WHERE id = ?').get(alice).display_name;
    const bobName = db.prepare('SELECT display_name FROM players WHERE id = ?').get(bob).display_name;

    const conquer = claim(13, alice, 'landmark').claim;
    assert.equal(claimSummary(conquer),
      `${aliceName} conquered Hood 13 — Toronto Centre with a landmark photo (+${conquerValue(13)})`);

    rewind(13, 24);
    const steal = claim(13, bob, 'person').claim;
    assert.equal(claimSummary(steal),
      `${bobName} stole Hood 13 — Toronto Centre from ${aliceName} with a person photo (+${stealValue(13)})`);

    rewind(13, 80);
    const reinforce = claim(13, bob, 'animal').claim;
    assert.equal(claimSummary(reinforce),
      `${bobName} reinforced Hood 13 — Toronto Centre with an animal photo (+${config.REINFORCE_POINTS})`);
  });

  test('a reversal says whose claim died', () => {
    const c = claim(13, alice, 'animal').claim;
    const { reversal } = revertClaim(c.id);
    assert.match(claimSummary(reversal), /alice\d+'s claim on Hood 13 — Toronto Centre was reverted/);
  });
});
