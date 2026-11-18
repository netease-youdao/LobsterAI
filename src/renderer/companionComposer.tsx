import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';

import CompanionComposer from './components/desktopCompanion/CompanionComposer';
import { observeCompanionTheme } from './components/desktopCompanion/companionTheme';
import { store } from './store';

const stopObservingTheme = observeCompanionTheme();
if (import.meta.hot) import.meta.hot.dispose(stopObservingTheme);

// The desktop companion's quick panel runs the home composer with its own store.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <CompanionComposer />
    </Provider>
  </React.StrictMode>,
);
