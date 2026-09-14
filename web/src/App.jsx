import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useGame } from './lib/store.jsx';
import { MapIcon, FeedIcon, CupIcon, ChatIcon, CardIcon } from './components/icons.jsx';
import { Spinner } from './components/bits.jsx';
import MapScreen from './screens/MapScreen.jsx';
import Feed from './screens/Feed.jsx';
import Standings from './screens/Standings.jsx';
import Chat from './screens/Chat.jsx';
import HoodDetail from './screens/HoodDetail.jsx';
import Login from './screens/Login.jsx';
import Profile from './screens/Profile.jsx';
import Parkemans from './screens/Parkemans.jsx';
import Binder from './screens/Binder.jsx';
import Trades from './screens/Trades.jsx';
import Items from './screens/Items.jsx';

export default function App() {
  const { session, booting, unreadChat } = useGame();
  const { pathname } = useLocation();

  if (booting) {
    return <div className="empty" style={{ paddingTop: '6rem' }}><Spinner /></div>;
  }
  if (!session) return <Login />;

  // The map and chat manage their own scrolling; every other screen scrolls normally.
  // The parks screen's map view manages its own scrolling too, but its list view does not,
  // so it stays a normal scrolling screen and the map fills the viewport inside it.
  const flush = pathname === '/' || pathname === '/chat';

  return (
    <div className="app">
      <Header />

      <main className={`screen ${flush ? 'screen-flush' : ''}`}>
        <Routes>
          <Route path="/" element={<MapScreen />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/standings" element={<Standings />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/hood/:id" element={<HoodDetail />} />
          <Route path="/me" element={<Profile />} />
          <Route path="/hood/:id/parks" element={<Parkemans />} />
          <Route path="/binder" element={<Binder />} />
          <Route path="/binder/:playerId" element={<Binder />} />
          <Route path="/trades" element={<Trades />} />
          {/* Not a sixth tab: reached from the binder and the profile. */}
          <Route path="/items" element={<Items />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="tabbar">
        <Tab to="/" icon={MapIcon} label="Map" />
        {/* The collection is the point of the app, so it gets a tab. The badge counts
            trade offers waiting on you — the binder's own Offers link is the next tap,
            and it carries the same number. */}
        <Tab to="/binder" icon={CardIcon} label="Cards" badge={session?.trades_pending ?? 0} />
        <Tab to="/feed" icon={FeedIcon} label="Feed" />
        <Tab to="/standings" icon={CupIcon} label="Standings" />
        <Tab to="/chat" icon={ChatIcon} label="Chat" badge={unreadChat} />
      </nav>
    </div>
  );
}

function Tab({ to, icon: Icon, label, badge }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon />
      <span>{label}</span>
      {badge > 0 && <span className="tab-badge">{badge > 9 ? '9+' : badge}</span>}
    </NavLink>
  );
}

function Header() {
  const { session, player, hoods, connected } = useGame();
  const mine = hoods.filter((h) => h.owner?.id === player?.id).length;

  return (
    <header className="header">
      <NavLink to="/me" className="brand" title="Profile and settings"
               style={{ textDecoration: 'none', color: 'inherit' }}>
        {/* A tappable wordmark alone reads as a logo, not a button. */}
        <svg className="brand-menu" viewBox="0 0 10 8" aria-hidden="true">
          <rect y="0" width="10" height="1.4" />
          <rect y="3.3" width="10" height="1.4" />
          <rect y="6.6" width="10" height="1.4" />
        </svg>
        Park-E-Mans <b>GO!</b>
      </NavLink>

      <span className="spacer" />

      {!connected && <span className="chip chip-bad" title="Reconnecting">offline</span>}

      <div className="header-stat" title={`${session.season?.name ?? 'No season'} points`}>
        <b>{session.season_points}</b>
        {session.season?.name?.split(' ')[0] ?? 'pts'}
      </div>
      <div className="header-stat" title="Hoods you hold">
        <b>{mine}</b>
        Hoods
      </div>

      {session.xp && (
        <NavLink to="/me" className="level-badge"
                 title={`${session.xp.title} · ${session.xp.xp.toLocaleString()} XP lifetime · ${session.xp.to_next} to level ${session.xp.level + 1}`}>
          <b>{session.xp.level}</b>
          <i style={{ width: `${Math.round(session.xp.fraction * 100)}%` }} />
        </NavLink>
      )}
    </header>
  );
}
