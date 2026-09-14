// A running Clover, counted down. It sits on the capture sheets because that is where a
// player is when it matters: a Clover that ran out while nobody was looking is a wasted
// item and a bad feeling, so its window is never something you have to go and find.
import { useEffect, useState } from 'react';
import { useGame } from '../lib/store.jsx';
import { until, clock } from '../lib/game.js';
import { CloverIcon } from './icons.jsx';
import { Banner } from './bits.jsx';

export default function CloverClock() {
  const { session } = useGame();
  const ends = session?.items?.clover_until ?? null;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!ends) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [ends]);

  if (!ends || Date.parse(ends) <= now) return null;
  return (
    <Banner kind="ok">
      <span className="cluster" style={{ gap: '0.4rem' }}>
        <CloverIcon style={{ width: 16, height: 16, flex: 'none' }} />
        <span>
          <b>Clover running — {until(ends, now)} left.</b> Double Gold and Hologram odds
          until {clock(ends)}.
        </span>
      </span>
    </Banner>
  );
}
