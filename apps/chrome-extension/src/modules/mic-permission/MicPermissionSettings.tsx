import React, { useCallback, useEffect, useState } from 'react';
import { logger } from '@openplan/core';
import { checkMicPermission, requestMicPermission, MicPermissionState } from './mic-access.js';

export const MicPermissionSettings: React.FC = () => {
  const [state, setState] = useState<MicPermissionState | 'checking'>('checking');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await checkMicPermission());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleGrant = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setState(await requestMicPermission());
    } catch (err) {
      logger.error('Microphone permission request failed:', err);
    } finally {
      setBusy(false);
    }
  };

  if (state === 'unsupported') {
    return null;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap', fontSize: '13px' }}>
      <MicIcon />
      <span style={{ color: '#475569', fontWeight: 500 }}>Microphone</span>

      {state === 'checking' && <span style={{ color: '#94a3b8' }}>Checking…</span>}

      {state === 'granted' && <Badge tone="success" icon={<CheckIcon />} title="Microphone access granted" />}

      {state === 'needs-permission' && (
        <>
          <Badge tone="warn" icon={<WarnIcon />} title="Recordings will have no microphone audio until this is granted.">
            Not granted
          </Badge>
          <LinkButton label="Grant access" onClick={handleGrant} disabled={busy} />
        </>
      )}

      {state === 'denied' && (
        <Badge
          tone="error"
          icon={<WarnIcon />}
          title="Click the icon left of the address bar on this page → Site settings → allow Microphone, then reload this tab."
        >
          Blocked
        </Badge>
      )}
    </div>
  );
};

export const MicIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="8" y1="22" x2="16" y2="22" />
  </svg>
);

export const CheckIcon: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const WarnIcon: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 L22.5 21 L1.5 21 Z" />
    <line x1="12" y1="9.5" x2="12" y2="13.5" />
    <circle cx="12" cy="17" r="0.75" fill="currentColor" stroke="none" />
  </svg>
);

export const Badge: React.FC<{
  tone: 'success' | 'warn' | 'error' | 'neutral';
  icon?: React.ReactNode;
  title?: string;
  children?: React.ReactNode;
}> = ({ tone, icon, title, children }) => {
  const palette = {
    success: { bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
    warn: { bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
    error: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
    neutral: { bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0' },
  }[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: children ? '4px' : 0,
        padding: children ? '3px 9px' : '4px',
        borderRadius: '999px',
        background: palette.bg,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        fontSize: '11.5px',
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {icon}
      {children}
    </span>
  );
};

export const LinkButton: React.FC<{ label: string; onClick: () => void; disabled?: boolean }> = ({
  label,
  onClick,
  disabled,
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      background: 'none',
      border: 'none',
      padding: 0,
      color: disabled ? '#94a3b8' : '#2563eb',
      fontWeight: 600,
      fontSize: '12.5px',
      cursor: disabled ? 'default' : 'pointer',
    }}
  >
    {label}
  </button>
);
