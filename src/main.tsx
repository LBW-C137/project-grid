import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './glass.css';
import './themes.css';
import './polish.css';
import './typography.css';
import './interaction.css';
import './clarity.css';
import { restoreTheme } from './themes';
import './platform';

restoreTheme();
createRoot(document.getElementById('root')!).render(<App />);
