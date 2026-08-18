import React from 'react';
import ReactDOM from 'react-dom/client';
import { PopupApp } from './PopupApp.js';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <PopupApp />
    </React.StrictMode>
  );
}
