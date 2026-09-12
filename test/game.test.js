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
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('UPDATE hoods SET ever_conquered = 0, unclaimed_value = 25');
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
    assert.equal(c.points_awarded, 25);
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
    assert.equal(c.points_awarded, 75);
  });

  test('arms the steal cooldown — a conquer is a change of hands too', () => {
    claim(13, alice, 'landmark');
    assert.ok(state(13).locked_until > nowIso());
    expectError(() => claim(13, bob, 'person'), 'HOOD_LOCKED');
  });
});

// ── the counter system ────────────────────────────────────────────────────
describe('counter system', () => {
  test('animal beats person, person beats landmark, landmark beats animal', () => {
    // One Hood per pair, so each case is independent of the last.
    const cases = [[1, 'person', 'animal'], [2, 'landmark', 'person'], [3, 'animal', 'landmark']];
    for (const [hoodId, held, beater] of cases) {
      claim(hoodId, alice, held);
      rewind(hoodId, 24);
      const { claim: c } = claim(hoodId, bob, beater);
      assert.equal(c.claim_kind, 'steal', `${beater} should beat ${held}`);
      assert.equal(c.points_awarded, 100);
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
  test('pays a flat 100 regardless of what the Hood was worth unclaimed', () => {
    db.prepare('UPDATE hoods SET unclaimed_value = 100 WHERE id = 25').run();
    claim(25, alice, 'landmark');
    rewind(25, 24);
    assert.equal(claim(25, bob, 'person').claim.points_awarded, 100);
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
    claim(13, alice, 'landmark');          // alice +25
    rewind(13, 24);
    claim(13, bob, 'person');           // bob +100
    assert.equal(points(alice), 25);
    assert.equal(points(bob), 100);
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
    assert.equal(claim(13, alice, 'person').claim.points_awarded, 25);
    assert.equal(state(13).photo_type, 'person');
  });

  test('rotates what you are vulnerable to', () => {
    claim(13, alice, 'landmark');                       // exposed to person
    assert.deepEqual(evaluateClaim({ hoodId: 13, playerId: bob }).required_types, ['person']);
    rewind(13, 80);
    claim(13, alice, 'person');                      // now exposed to animal
    assert.deepEqual(evaluateClaim({ hoodId: 13, playerId: bob }).required_types, ['animal']);
  });

  test('pays 25 even when the Hood was worth more to conquer', () => {
    db.prepare('UPDATE hoods SET unclaimed_value = 100 WHERE id = 25').run();
    claim(25, alice, 'landmark');
    rewind(25, 80);
    assert.equal(claim(25, alice, 'person').claim.points_awarded, 25);
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
    assert.equal(points(alice), 25, 'alice keeps hers');
  });

  test('cancels points exactly once — the reversal row does not double-subtract', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    const c = claim(13, bob, 'person').claim;
    assert.equal(points(bob), 100);
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
    assert.equal(points(alice), 25);
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
    claim(13, alice, 'landmark');       // +25
    rewind(13, 24);
    claim(13, bob, 'person');        // +100
    claim(14, alice, 'animal');       // +25

    const season = leaderboard(1);
    assert.equal(season.find((r) => r.player.id === alice).points, 50);
    assert.equal(season.find((r) => r.player.id === bob).points, 100);
    assert.deepEqual(leaderboard(null).map((r) => r.points), leaderboard(1).map((r) => r.points));
  });

  test('a different season scores zero for the same claims', () => {
    claim(13, alice, 'landmark');
    assert.equal(leaderboard(2).find((r) => r.player.id === alice).points, 0);
  });

  test('ties share a rank', () => {
    claim(13, alice, 'landmark');
    claim(14, bob, 'landmark');
    const ranks = leaderboard(1).slice(0, 2).map((r) => r.rank);
    assert.deepEqual(ranks, [1, 1]);
  });

  test('hoods_held counts territory, which is independent of points', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    claim(13, bob, 'person');
    const board = leaderboard(1);
    assert.equal(board.find((r) => r.player.id === alice).hoods_held, 0);
    assert.equal(board.find((r) => r.player.id === alice).points, 25);
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
    assert.equal(ev.points, 100);
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
  test('name the player, the Hood and the subject', () => {
    const conquer = claim(13, alice, 'landmark').claim;
    assert.match(claimSummary(conquer),
      /^alice\d+ conquered Hood 13 — Toronto Centre with a landmark photo \(\+25\)$/);

    rewind(13, 24);
    const steal = claim(13, bob, 'person').claim;
    assert.match(claimSummary(steal),
      /^bob\d+ stole Hood 13 — Toronto Centre from alice\d+ with a person photo \(\+100\)$/);

    rewind(13, 80);
    const reinforce = claim(13, bob, 'animal').claim;
    assert.match(claimSummary(reinforce),
      /^bob\d+ reinforced Hood 13 — Toronto Centre with an animal photo \(\+25\)$/);
  });

  test('a reversal says whose claim died', () => {
    const c = claim(13, alice, 'animal').claim;
    const { reversal } = revertClaim(c.id);
    assert.match(claimSummary(reversal), /alice\d+'s claim on Hood 13 — Toronto Centre was reverted/);
  });
});
