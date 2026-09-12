import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { GameProvider } from './lib/store.jsx';
import { ThemeProvider } from './lib/theme-context.jsx';
import { applyAppearance, loadAppearance } from './lib/theme.js';
import App from './App.jsx';
import { BUILD } from './lib/build.js';
import { trackBottomInset } from './lib/viewport.js';
import './styles.css';

// Before the first render, so nobody sees a dark app repaint itself light.
applyAppearance(loadAppearance());

// Which build is this phone actually running? Printed so the answer never has to be
// guessed from behaviour again.
console.info(`[cth] build ${BUILD}`);

// Measure how much of the bottom of the screen the browser has taken, before anything
// is laid out against it.
trackBottomInset();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <GameProvider>
          <App />
        </GameProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
