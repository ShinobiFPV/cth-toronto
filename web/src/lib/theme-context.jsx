// The appearance, in React. Kept separate from theme.js so the plain functions there can
// be called before React mounts — which is how the app avoids a flash of the wrong theme.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  loadAppearance, saveAppearance, applyAppearance, resolveMode, onSystemThemeChange,
} from './theme.js';

const Ctx = createContext(null);

export const useTheme = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useTheme outside <ThemeProvider>');
  return value;
};

export function ThemeProvider({ children }) {
  const [appearance, setAppearance] = useState(loadAppearance);
  const [resolved, setResolved] = useState(() => resolveMode(appearance.mode));

  useEffect(() => {
    setResolved(applyAppearance(appearance));
    saveAppearance(appearance);
  }, [appearance]);

  // With mode 'system', follow the OS while the app is open rather than only at load.
  useEffect(() => {
    if (appearance.mode !== 'system') return undefined;
    return onSystemThemeChange(() => setResolved(applyAppearance(appearance)));
  }, [appearance]);

  const value = useMemo(() => ({
    appearance,
    resolved,
    setMode: (mode) => setAppearance((a) => ({ ...a, mode })),
    setAccent: (accent) => setAppearance((a) => ({ ...a, accent })),
  }), [appearance, resolved]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
