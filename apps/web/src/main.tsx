import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, Splash } from './App';
import { locale, t } from './lib/i18n';
import { LiveSession, takeToken } from './lib/session';
import './styles.css';

document.documentElement.lang = locale;
const root = createRoot(document.getElementById('root')!);
const token = takeToken();

if (!token) {
  root.render(<Splash message={t('statusNoToken')} />);
} else {
  const live = new LiveSession(token);
  root.render(
    <StrictMode>
      <App live={live} />
    </StrictMode>,
  );
}
