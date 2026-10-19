import './components/desktopCompanion/desktopCompanion.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import CompanionScreenshot from './components/desktopCompanion/CompanionScreenshot';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <CompanionScreenshot />
</React.StrictMode>);
