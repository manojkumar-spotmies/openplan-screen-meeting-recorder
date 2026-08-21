import React from 'react';
import ReactDOM from 'react-dom/client';
import { SettingsApp } from './SettingsApp.js';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <SettingsApp />
    </React.StrictMode>
  );
}
