#!/usr/bin/env node
// Season rollover. Run daily by a systemd timer at 00:05 Toronto time (see
// deploy/cth-rollover.timer); safe to run any number of times.
//
//   node scripts/rollover.js [--dry-run] [--at 2026-12-01T06:00:00Z]
//
// When a season ends (spec §1.5):
//   • seasonal point tallies reset — achieved purely by scoping queries to
//     season_id, so nothing is deleted and the Champion total is unaffected
//   • Hood ownership persists; whoever holds a Hood at season end still holds it
//   • every Hood never conquered by anyone gains +25 on top of its difficulty score
//   • reinforce stays flat at 25, and a steal always pays difficulty x the steal
//     multiplier — neither is affected by escalation
//
// Idempotency lives in seasons.escalation_applied: the flag is set in the same
// transaction as the escalation, so a timer that fires twice cannot double-count.
import { db, nowIso, recomputeValues } from '../server/db.js';
import { config } from '../server/config.js';
import { postMessage } from '../server/lib/hub.js';
import { leaderboard } from '../server/lib/views.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const at = args.includes('--at') ? args[args.indexOf('--at') + 1] : nowIso();

const log = (...a) => console.log('[rollover]', ...a);

// Every season that has finished but not yet been rolled over. Normally zero or one;
// more only if the Pi was off for a season boundary, which this handles in order.
const pending = db.prepare(`
  SELECT * FROM seasons WHERE ends_at <= ? AND escalation_applied = 0 ORDER BY id`).all(at);

if (pending.length === 0) {
  const current = db.prepare('SELECT * FROM seasons WHERE starts_at <= ? AND ends_at > ?')
    .get(at, at);
  log(current ? `${current.name} is still running — nothing to do.` : 'Between seasons — nothing to do.');
  process.exit(0);
}

for (const season of pending) {
  const next = db.prepare('SELECT * FROM seasons WHERE starts_at >= ? ORDER BY id LIMIT 1')
    .get(season.ends_at);

  const untouched = db.prepare('SELECT * FROM hoods WHERE ever_conquered = 0 ORDER BY id').all();
  const cap = config.ESCALATION_CAP;
  const escalations = next
    ? untouched
        .map((h) => {
          const raised = h.unclaimed_value + config.ESCALATION_STEP;
          return { ...h, new_value: cap == null ? raised : Math.min(raised, cap) };
        })
        .filter((h) => h.new_value !== h.unclaimed_value)
    : [];

  const standings = leaderboard(season.id).filter((r) => r.claims > 0);
  const winner = standings[0] ?? null;

  log(`${season.name} ended ${season.ends_at}`);
  log(`  winner: ${winner ? `${winner.player.display_name} — ${winner.points} points` : 'nobody scored'}`);
  log(`  never-conquered Hoods: ${untouched.length}`);
  log(next
    ? `  escalating ${escalations.length} of them by ${config.ESCALATION_STEP}` +
      (cap == null ? '' : ` (capped at ${cap})`)
    : '  final season — no escalation, the game is over');

  if (dryRun) {
    for (const h of escalations) log(`    Hood ${h.id} ${h.name}: ${h.unclaimed_value} → ${h.new_value}`);
    continue;
  }

  db.transaction(() => {
    // Increment the counter, not the value. unclaimed_value is derived from difficulty
    // plus escalations, and recomputeValues() is the only thing allowed to write it.
    const bump = db.prepare('UPDATE hoods SET escalations = escalations + 1 WHERE id = ?');
    for (const h of escalations) bump.run(h.id);
    db.prepare('UPDATE seasons SET escalation_applied = 1 WHERE id = ?').run(season.id);
    recomputeValues();
  })();

  const lines = [`${season.name} is over.`];
  if (winner) {
    lines.push(`Season winner: ${winner.player.display_name} with ${winner.points} points.`);
  } else {
    lines.push('Nobody scored a single point. Genuinely impressive.');
  }
  if (next) {
    lines.push(`${next.name} starts now — season points reset to zero, Hoods stay where they are.`);
    if (escalations.length) {
      const top = escalations[0];
      lines.push(
        `${escalations.length} Hood${escalations.length === 1 ? '' : 's'} nobody has ever claimed ` +
        `${escalations.length === 1 ? 'is' : 'are'} now worth ${top.new_value} to conquer.`);
    }
  } else {
    const champion = leaderboard(null).filter((r) => r.claims > 0)[0];
    lines.push(champion
      ? `That is the whole game. Champion: ${champion.player.display_name} with ${champion.points} points across all four seasons.`
      : 'That is the whole game, and nobody scored. Go outside.');
  }

  postMessage({
    body: lines.join(' '),
    kind: 'system',
    meta: {
      event: 'season_rollover',
      season_id: season.id,
      next_season_id: next?.id ?? null,
      winner_id: winner?.player.id ?? null,
      escalated: escalations.length,
    },
  });
  log('  posted the rollover message to chat');
}

// The running server holds its own connection; it will pick up the new values on the
// next read. Nothing here needs to signal it.
db.close();
log(dryRun ? 'dry run complete — nothing written' : 'done');
