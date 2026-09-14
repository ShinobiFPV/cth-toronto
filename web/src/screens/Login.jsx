// Sign in, or register against an invite code. Registration is the only way in —
// there is no open signup, because this is six people and a group chat.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { Banner } from '../components/bits.jsx';

export default function Login() {
  const { signIn } = useGame();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ handle: '', password: '', display_name: '', invite_code: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // With nobody registered yet, lead with "join" — the first player is the admin.
  useEffect(() => {
    api.status()
      .then(({ players }) => { if (players === 0) setMode('register'); })
      .catch(() => {});
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = mode === 'login'
        ? await api.login({ handle: form.handle, password: form.password })
        : await api.register(form);
      await signIn(result);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="screen-pad" style={{ maxWidth: 420, margin: '0 auto', paddingTop: '3rem' }}>
      {/* The wordmark, set the same as the header once you are in. Not an
          <h1> default: this is the app's name rather than a page title. */}
      <h1 className="login-mark">
        Park-E-Mans<br /><span>GO!</span>
      </h1>
      <p className="dim tiny" style={{ margin: '0.5rem 0 2rem', letterSpacing: '0.1em' }}>
        TORONTO · 1,513 PARKS · 25 HOODS · 4 SEASONS
      </p>

      <div className="toggle" role="group" aria-label="Sign in or join">
        <button aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(null); }}>
          Sign in
        </button>
        <button aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(null); }}>
          Join
        </button>
      </div>

      <form onSubmit={submit}>
        {mode === 'register' && (
          <label className="field">
            <span>Invite code</span>
            <input className="input" value={form.invite_code} onChange={set('invite_code')}
                   placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" required />
          </label>
        )}

        <label className="field">
          <span>Handle</span>
          <input className="input" value={form.handle} onChange={set('handle')}
                 autoCapitalize="none" autoCorrect="off" autoComplete="username" required />
        </label>

        {mode === 'register' && (
          <label className="field">
            <span>Display name <span className="dim">(optional)</span></span>
            <input className="input" value={form.display_name} onChange={set('display_name')}
                   autoComplete="nickname" />
          </label>
        )}

        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={form.password} onChange={set('password')}
                 autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                 minLength={mode === 'register' ? 8 : undefined} required />
        </label>

        {error && <Banner kind="bad">{error}</Banner>}

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Hold on…' : mode === 'login' ? 'Sign in' : 'Join the game'}
        </button>
      </form>

      <div className="footer-note" style={{ marginTop: '2rem', borderTop: 0, padding: 0 }}>
        Hood boundaries contain information licensed under the
        {' '}<a href="https://open.toronto.ca/open-data-license/">Open Government Licence – Toronto</a>.
        <br />A ShinTech Electronics thing.
      </div>
    </div>
  );
}
