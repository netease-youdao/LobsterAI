import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';

import CompanionComposer from './components/desktopCompanion/CompanionComposer';
import { store } from './store';

// The desktop companion's quick panel runs the home composer with its own store.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <CompanionComposer />
    </Provider>
  </React.StrictMode>,
);
