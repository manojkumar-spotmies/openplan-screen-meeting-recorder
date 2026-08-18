import React from 'react';
import ReactDOM from 'react-dom/client';
import { LocalInspector } from './LocalInspector.js';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <LocalInspector />
    </React.StrictMode>
  );
}
