// Season table and Champion table, toggled. Both are the same ledger; the only
// difference is whether the query filters by season (spec §1.6).
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { Spinner } from '../components/bits.jsx';

export default function Standings() {
  const { player, hoods } = useGame();
  const [mode, setMode] = useState('season');
  const [data, setData] = useState(null);
  const [seasons, setSeasons] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const fetcher = mode === 'season' ? api.leaderboard() : api.champion();
    Promise.all([fetcher, seasons ? Promise.resolve({ seasons }) : api.seasons()])
      .then(([board, s]) => {
        if (cancelled) return;
        setData(board);
        setSeasons(s.seasons);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // hoods.length changes whenever a claim lands, which is exactly when the table moves
  }, [mode, hoods]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="screen-pad">
      <div className="toggle" role="group" aria-label="Standings scope">
        <button aria-pressed={mode === 'season'} onClick={() => setMode('season')}>
          {data?.season?.name ?? 'This season'}
        </button>
        <button aria-pressed={mode === 'champion'} onClick={() => setMode('champion')}>
          Champion
        </button>
      </div>

      <p className="tiny dim">
        {mode === 'season'
          ? 'Points scored inside the current season. Resets at rollover; Hoods do not.'
          : 'Every point ever scored, across all four seasons. One winner at the end of it.'}
        {' '}Levels are lifetime and never reset, so they read the same on both tables.
      </p>

      {loading && <div className="empty"><Spinner /></div>}

      {!loading && data && (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '2.5rem' }}>#</th>
              <th>Player</th>
              <th className="r">Hoods</th>
              <th className="r">Parks</th>
              <th className="r">Points</th>
            </tr>
          </thead>
          <tbody>
            {data.standings.map((row) => (
              <tr key={row.player.id} className={row.player.id === player?.id ? 'me' : ''}>
                <td className="dim">{row.rank}</td>
                <td>
                  <span className="cluster" style={{ gap: '0.4rem' }}>
                    <i className="dot" style={{ background: row.player.colour }} />
                    <span className="truncate">{row.player.display_name}</span>
                  </span>
                  <span className="tiny dim">
                    <b className="lvl">L{row.level}</b> {row.title} ·{' '}
                    {row.conquers}C · {row.steals}S · {row.reinforces}R
                    {row.parks > 0 && ` · ${row.parks} parks`}
                  </span>
                </td>
                <td className="r">{row.hoods_held}</td>
                <td className="r tiny dim">{row.park_points || '—'}</td>
                <td className="r num">{row.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {seasons && (
        <>
          <h2 style={{ margin: '1.5rem 0 0.5rem' }}>Schedule</h2>
          <table className="table">
            <tbody>
              {seasons.map((s) => (
                <tr key={s.id}>
                  <td>{s.active ? <span className="chip chip-solid">Now</span> : <span className="dim">{s.id}</span>}</td>
                  <td>{s.name}</td>
                  <td className="r tiny dim">
                    {new Date(s.starts_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                    {' – '}
                    {new Date(new Date(s.ends_at).getTime() - 1).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
