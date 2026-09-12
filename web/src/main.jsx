import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { GameProvider } from './lib/store.jsx';
import { ThemeProvider } from './lib/theme-context.jsx';
import { applyAppearance, loadAppearance } from './lib/theme.js';
import App from './App.jsx';
import './styles.css';

// Before the first render, so nobody sees a dark app repaint itself light.
applyAppearance(loadAppearance());

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
