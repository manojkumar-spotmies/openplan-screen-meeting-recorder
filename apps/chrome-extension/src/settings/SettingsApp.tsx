import React from 'react';
import { StorageSettings } from '../modules/local-storage-settings/StorageSettings.js';

export const SettingsApp: React.FC = () => {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: '24px', maxWidth: '640px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: '16px', marginBottom: '24px' }}>
        <h1 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700, color: '#f8fafc' }}>
          Openplan Recorder Settings
        </h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>
          Choose where recordings should eventually be saved on your computer.
        </p>
      </header>

      <StorageSettings />
    </div>
  );
};
