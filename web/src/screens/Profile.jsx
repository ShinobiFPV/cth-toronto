// You, your Hoods, the rules, and — if you are the admin — invite codes.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { article, until, SUBJECTS, SUBJECT_BLURB, BEATS } from '../lib/game.js';
import { Subject, Banner, PlayerName } from '../components/bits.jsx';
import { BackIcon } from '../components/icons.jsx';
import Appearance from '../components/Appearance.jsx';
import { BUILD } from '../lib/build.js';

export default function Profile() {
  const { session, player, players, hoods, signOut } = useGame();
  const navigate = useNavigate();
  const [rules, setRules] = useState(null);
  const [invites, setInvites] = useState(null);
  const [newCode, setNewCode] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.seasons().then((s) => setRules(s.rules)).catch(() => {});
    if (player?.is_admin) api.invites().then((r) => setInvites(r.invites)).catch(() => {});
  }, [player?.is_admin]);

  const mine = hoods.filter((h) => h.owner?.id === player?.id);
  const xp = session?.xp;
  const ready = mine.filter((h) => h.viewer?.reinforce_ready);

  const mintInvite = async () => {
    try {
      const { code } = await api.createInvite(null);
      setNewCode(code);
      const r = await api.invites();
      setInvites(r.invites);
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="screen-pad stack">
      <div className="cluster">
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
      </div>

      <div className="sheet">
        <div className="sheet-head">
          <PlayerName player={player} />
          <span className="spacer grow" />
          {player?.is_admin && <span className="chip chip-accent">admin</span>}
        </div>

        {/* Lifetime XP. Deliberately above the seasonal numbers: it is the only line
            here that will still mean something a year from now. */}
        {xp && (
          <div className="sheet-body xp-card" style={{ borderBottom: '1px solid var(--rule)' }}>
            <div className="cluster" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>
                <span className="xp-title">Level {xp.level}</span>
                <span className="dim"> · {xp.title}</span>
              </span>
              <span className="tiny dim">{xp.xp.toLocaleString()} XP</span>
            </div>
            <div className="xp-bar" style={{ margin: '0.45rem 0 0.3rem' }}>
              <i style={{ width: `${Math.round(xp.fraction * 100)}%` }} />
            </div>
            <div className="tiny dim">
              {xp.into_level} / {xp.level_span} through this level ·{' '}
              {xp.to_next} XP to level {xp.level + 1}
            </div>
          </div>
        )}
        <div className="row">
          <span className="grow dim">{session.season?.name ?? 'Between seasons'}</span>
          <b className="num">{session.season_points}</b>
        </div>
        <div className="row">
          <span className="grow dim">All seasons</span>
          <b className="num">{session.total_points}</b>
        </div>
        <div className="row">
          <span className="grow dim">Hoods held</span>
          <b className="num">{mine.length}</b>
        </div>
      </div>

      {ready.length > 0 && (
        <Banner kind="info">
          {ready.length} of your Hoods {ready.length === 1 ? 'is' : 'are'} ready to reinforce.
          That is {ready.length * (rules?.reinforce_points ?? 25)} points sitting there.
        </Banner>
      )}

      <Link className="btn btn-block" to="/binder" style={{ justifyContent: 'space-between' }}>
        <span>Parkemans binder</span>
        <span className="tiny dim">your cards, and everybody else's</span>
      </Link>

      <Link className="btn btn-block" to="/trades" style={{ justifyContent: 'space-between' }}>
        <span>Card offers</span>
        {(session?.trades_pending ?? 0) > 0
          ? <span className="chip chip-accent">{session.trades_pending} waiting</span>
          : <span className="tiny dim">trade cards, not points</span>}
      </Link>

      <div>
        <h2 style={{ marginBottom: '0.5rem' }}>Your Hoods</h2>
        {!mine.length && <div className="empty">None yet. The map is right there.</div>}
        <div className="sheet">
          {mine.map((h) => (
            <Link key={h.id} to={`/hood/${h.id}`} className="row"
                  style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="grow truncate">{h.label}</span>
              <Subject type={h.photo_type} label={false} />
              <span className="tiny dim">
                {h.viewer?.reinforce_ready
                  ? <b style={{ color: 'var(--accent-text)' }}>reinforce</b>
                  : until(h.viewer?.available_at)}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <h2 style={{ marginBottom: '0.5rem' }}>The rules</h2>
        <div className="sheet">
          <div className="sheet-body stack" style={{ gap: '0.6rem' }}>
            <div className="stack" style={{ gap: '0.35rem' }}>
              {SUBJECTS.map((s) => (
                <div key={s} className="cluster">
                  <Subject type={s} />
                  <span className="tiny dim grow">{SUBJECT_BLURB[s]}</span>
                  <span className="tiny">beats {BEATS[s]}</span>
                </div>
              ))}
            </div>
            {rules && (
              <ul className="tiny dim" style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.8 }}>
                <li>Every Hood has a difficulty score from 5 to 50, set by how far out it
                    is and how few Hoods border it. Rouge Park is 50; University-Rosedale
                    is 5.</li>
                <li>Conquer an unclaimed Hood with any subject and it pays its difficulty,
                    plus anything seasonal escalation has added.</li>
                <li>Steal a held Hood with the subject that beats theirs and it pays
                    difficulty x {rules.steal_multiplier} — so 10 to 100.</li>
                <li>Reinforce your own after {rules.reinforce_gate_hours}h, with the subject
                    that beats your own photo: a flat +{rules.reinforce_points} on any Hood,
                    however hard. Never escalates.</li>
                <li>After a Hood changes hands it is locked from stealing
                    for {rules.steal_cooldown_hours}h. A reinforce does not lock it.</li>
                {rules.adjacent_conquer_cooldown_hours > 0 && (
                  <li>Conquer an unclaimed Hood and its neighbours close to
                      you for {rules.adjacent_conquer_cooldown_hours}h — so one drone flight
                      cannot sweep a whole block. Only you, and only conquering;
                      steal and reinforce are unaffected.</li>
                )}
                <li><b>XP is forever.</b> Every claim and every park earns it, it never
                    resets at a season rollover, and it goes up with activity rather than
                    value — so the player who has been everywhere once out-levels the one
                    who farms four Hoods near home. Somewhere new you have never claimed
                    is worth a big bonus.</li>
                <li>Losing a Hood costs you nothing. Points are never taken back.</li>
                <li>{rules.flag_threshold} flags revert a claim and cancel its points.</li>
                <li><b>Parkemans GO:</b> every Toronto park has a sign with its name on it.
                    Photograph one and you collect that park for a card, worth 5 to 100 by
                    how far out it is. Each park once a season, nobody competes over them,
                    and the points go straight into your total.</li>
                <li>Honour system: recent photo, taken inside the Hood, actually showing
                    what you declared. Nobody checks. Everybody can flag.</li>
              </ul>
            )}
          </div>
        </div>
      </div>

      <Appearance />

      {player?.is_admin && (
        <div>
          <h2 style={{ marginBottom: '0.5rem' }}>Invites</h2>
          {error && <Banner kind="bad">{error}</Banner>}
          {newCode && <Banner kind="ok">New code: <b>{newCode}</b></Banner>}
          <div className="sheet">
            {invites?.map((i) => (
              <div key={i.code} className="row">
                <code className="grow">{i.code}</code>
                {i.used_by_handle
                  ? <span className="tiny dim">used by {i.used_by_handle}</span>
                  : <span className="chip chip-ok">open</span>}
              </div>
            ))}
            {invites && !invites.length && <div className="row dim tiny">No codes yet.</div>}
          </div>
          <button className="btn btn-block" style={{ marginTop: '0.6rem' }} onClick={mintInvite}>
            Mint an invite
          </button>
        </div>
      )}

      <div>
        <h2 style={{ marginBottom: '0.5rem' }}>Players</h2>
        <div className="sheet">
          {players.map((p) => (
            <Link key={p.id} className="row" to={p.id === player?.id ? '/binder' : `/binder/${p.id}`}
                  style={{ color: 'inherit', textDecoration: 'none' }}>
              <i className="dot" style={{ background: p.colour }} />
              <span className="grow">{p.display_name}</span>
              <span className="tiny dim">
                {hoods.filter((h) => h.owner?.id === p.id).length} Hoods · binder
              </span>
            </Link>
          ))}
        </div>
      </div>

      <button className="btn btn-block btn-danger" onClick={signOut}>Sign out</button>

      <div className="footer-note">
        Hood boundaries contain information licensed under the{' '}
        <a href="https://open.toronto.ca/open-data-license/">Open Government Licence – Toronto</a>,
        from the City of Toronto <code>city-wards</code> dataset (25-ward model, 2018).
        Map tiles © <a href="https://carto.com/attributions">CARTO</a>, data ©{' '}
        <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors.
        <br />
        Capture the Hood is a ShinTech Electronics build. You are playing{' '}
        {article(SUBJECTS[0])}-beats-{BEATS[SUBJECTS[0]]} with your camera. Go outside.
        <br />
        {/* So "is my phone actually running the new version?" is a readable fact rather
            than something inferred from whether a bug still happens. */}
        <code>build {BUILD}</code>
      </div>
    </div>
  );
}
