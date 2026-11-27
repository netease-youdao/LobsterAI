import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';

import App from './App';
import WindowZoomIndicator from './components/window/WindowZoomIndicator';
import { installCleanRichTextCopy } from './services/clipboardRichText';
import { store } from './store';

installCleanRichTextCopy(document);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
        <WindowZoomIndicator />
      </Provider>
    </React.StrictMode>
  );
} catch (error) {
  console.error('Failed to render the app:', error);
}
