import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useGame } from './lib/store.jsx';
import { MapIcon, FeedIcon, CupIcon, ChatIcon } from './components/icons.jsx';
import { Spinner } from './components/bits.jsx';
import MapScreen from './screens/MapScreen.jsx';
import Feed from './screens/Feed.jsx';
import Standings from './screens/Standings.jsx';
import Chat from './screens/Chat.jsx';
import HoodDetail from './screens/HoodDetail.jsx';
import Login from './screens/Login.jsx';
import Profile from './screens/Profile.jsx';

export default function App() {
  const { session, booting, unreadChat } = useGame();
  const { pathname } = useLocation();

  if (booting) {
    return <div className="empty" style={{ paddingTop: '6rem' }}><Spinner /></div>;
  }
  if (!session) return <Login />;

  // The map and chat manage their own scrolling; every other screen scrolls normally.
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="tabbar">
        <Tab to="/" icon={MapIcon} label="Map" />
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
      <NavLink to="/me" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        CAPTURE THE <b>HOOD</b>
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
    </header>
  );
}
