import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { ExtensionMessage, LocalVideoSession, ApiResponse, ApiErrorResponse } from '@openplan/contracts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MessageListener = (message: ExtensionMessage) => void;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseSession(overrides: Partial<LocalVideoSession> = {}): LocalVideoSession {
  const now = new Date().toISOString();
  return {
    sessionId: 'widget-test-session',
    title: 'Widget Test',
    status: 'RECORDING',
    captureMode: 'SCREEN_SYSTEM_MIC',
    createdAt: now,
    updatedAt: now,
    totalChunks: 0,
    isPaused: false,
    microphoneEnabled: true,
    systemAudioEnabled: true,
    hasMicrophone: true,
    hasSystemAudio: true,
    ...overrides,
  };
}

type SendMessageCall = [ExtensionMessage, (r: ApiResponse<unknown> | ApiErrorResponse) => void];

describe('RecordingWidget (recording-widget.tsx)', () => {
  let messageListeners: MessageListener[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sendMessageMock: any;
  let statusResponse: ApiResponse<LocalVideoSession | null> | ApiErrorResponse;

  function getHost(): HTMLElement | null {
    return document.getElementById('openplan-recording-widget-host');
  }

  function getShadowRoot(): ShadowRoot {
    const host = getHost();
    if (!host || !host.shadowRoot) throw new Error('Widget host/shadow root not found');
    return host.shadowRoot;
  }

  function findCall(action: string): SendMessageCall | undefined {
    const calls = sendMessageMock.mock.calls as SendMessageCall[];
    return calls.find((call) => call[0].action === action);
  }

  function queueControlResponse(response: ApiResponse<unknown> | ApiErrorResponse) {
    sendMessageMock.mockImplementationOnce(
      (_message: ExtensionMessage, callback: (r: ApiResponse<unknown> | ApiErrorResponse) => void) => {
        Promise.resolve().then(() => callback(response));
      }
    );
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    messageListeners = [];
    statusResponse = { success: true, data: null, meta: { timestamp: '', requestId: '' } };

    sendMessageMock = vi.fn((message: ExtensionMessage, callback: (r: unknown) => void) => {
      if (message.action === 'GET_SESSION_STATUS') {
        Promise.resolve().then(() => callback(statusResponse));
        return;
      }
      // Default: echo success with no-op data; individual tests override via queueControlResponse
      Promise.resolve().then(() =>
        callback({ success: true, data: {}, meta: { timestamp: '', requestId: '' } })
      );
    });

    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: sendMessageMock,
        lastError: undefined,
        onMessage: {
          addListener: (listener: MessageListener) => messageListeners.push(listener),
          removeListener: (listener: MessageListener) => {
            messageListeners = messageListeners.filter((l) => l !== listener);
          },
        },
      },
    };

    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function broadcast(payload: Record<string, unknown>) {
    const message: ExtensionMessage = {
      target: 'POPUP',
      action: 'RECORDING_STATE_CHANGED',
      payload,
      meta: { timestamp: new Date().toISOString(), requestId: 'r1' },
    };
    messageListeners.forEach((listener) => listener(message));
  }

  async function mountWidget() {
    await act(async () => {
      await import('../recording-widget.js');
      await flushMicrotasks();
    });
  }

  it('does not render any control when there is no active recording session', async () => {
    statusResponse = { success: true, data: null, meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    // The host/shadow root may exist (so it can keep listening for a future
    // RECORDING_STATE_CHANGED broadcast), but it must render no visible control.
    expect(getShadowRoot().querySelector('button[aria-label]')).toBeNull();
  });

  it('shows the compact floating icon while a recording is active', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]');
    expect(icon).not.toBeNull();
    // Collapsed by default: no expanded panel with "Stop Recording"
    expect(shadow.textContent).not.toContain('Stop Recording');
  });

  it('explicitly isolates pointer-events/inherited styles so a Meet overlay cannot silently swallow clicks', async () => {
    // Regression guard for the real-world bug: Shadow DOM blocks Meet's
    // *selectors* from matching our elements, but does NOT block *inherited*
    // properties like pointer-events from cascading in from a Meet ancestor
    // (e.g. an overlay layer with `pointer-events: none`). Simulate that here.
    document.body.style.pointerEvents = 'none';
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    const container = icon.parentElement as HTMLElement;

    expect(container).not.toBeNull();
    // `all: initial` resets every inherited property (pointer-events, font,
    // color, ...) back to CSS-spec initial values before we re-declare the
    // ones we need, breaking any inheritance chain from Meet's page.
    expect(container.style.cssText).toContain('all: initial');
    expect(container.style.pointerEvents).toBe('auto');
    expect(icon.style.pointerEvents).toBe('auto');

    document.body.style.pointerEvents = '';
  });

  it('expands into the control menu when the icon is clicked', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;

    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });

    expect(shadow.textContent).toContain('Stop Recording');
    expect(shadow.textContent).toContain('Microphone');
    expect(shadow.textContent).toContain('System Audio');
  });

  it('collapses the menu when clicking outside the widget', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    expect(shadow.textContent).toContain('Stop Recording');

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    });

    expect(shadow.textContent).not.toContain('Stop Recording');
  });

  it('collapses the menu when the main icon is clicked again', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    expect(shadow.textContent).toContain('Stop Recording');

    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    expect(shadow.textContent).not.toContain('Stop Recording');
  });

  it('sends STOP_RECORDING via the existing stop/finalization flow when Stop Recording is clicked', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });

    queueControlResponse({
      success: true,
      data: { sessionId: 'widget-test-session', status: 'STOPPED', totalChunks: 3, durationSeconds: 15 },
      meta: { timestamp: '', requestId: '' },
    });

    const buttons = Array.from(shadow.querySelectorAll('button'));
    const stopButton = buttons.find((b) => b.textContent?.includes('Stop Recording')) as HTMLButtonElement;

    await act(async () => {
      stopButton.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await flushMicrotasks();
    });

    const stopCall = findCall('STOP_RECORDING');
    expect(stopCall).toBeDefined();
    expect(stopCall![0].target).toBe('SERVICE_WORKER');

    // Widget must not render Stop Recording again — it hid itself post-stop.
    expect(getShadowRoot().textContent).not.toContain('Stop Recording');
  });

  it('toggles the microphone off without sending STOP_RECORDING', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });

    queueControlResponse({
      success: true,
      data: {
        sessionId: 'widget-test-session',
        status: 'RECORDING',
        isPaused: false,
        microphoneEnabled: false,
        systemAudioEnabled: true,
        hasMicrophone: true,
        hasSystemAudio: true,
      },
      meta: { timestamp: '', requestId: '' },
    });

    const buttons = Array.from(shadow.querySelectorAll('button'));
    const micButton = buttons.find((b) => b.textContent?.includes('Microphone')) as HTMLButtonElement;

    await act(async () => {
      micButton.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await flushMicrotasks();
    });

    const micCall = findCall('SET_MICROPHONE_ENABLED');
    expect(micCall).toBeDefined();
    expect(micCall![0].payload).toMatchObject({ enabled: false });

    expect(findCall('STOP_RECORDING')).toBeUndefined();
    expect(shadow.textContent).toContain('Off');
  });

  it('toggles system audio off without affecting the microphone or stopping the recording', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });

    queueControlResponse({
      success: true,
      data: {
        sessionId: 'widget-test-session',
        status: 'RECORDING',
        isPaused: false,
        microphoneEnabled: true,
        systemAudioEnabled: false,
        hasMicrophone: true,
        hasSystemAudio: true,
      },
      meta: { timestamp: '', requestId: '' },
    });

    const buttons = Array.from(shadow.querySelectorAll('button'));
    const sysAudioButton = buttons.find((b) => b.textContent?.includes('System Audio')) as HTMLButtonElement;

    await act(async () => {
      sysAudioButton.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await flushMicrotasks();
    });

    const sysCall = findCall('SET_SYSTEM_AUDIO_ENABLED');
    expect(sysCall).toBeDefined();
    expect(sysCall![0].payload).toMatchObject({ enabled: false });
  });

  it('updates live from RECORDING_STATE_CHANGED broadcasts and hides on automatic meeting-end stop', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    expect(getHost()).not.toBeNull();

    await act(async () => {
      broadcast({
        sessionId: 'widget-test-session',
        status: 'STOPPED',
        chunksRecorded: 5,
        activeCaptureMode: 'SCREEN_SYSTEM_MIC',
      });
      await flushMicrotasks();
    });

    expect(getShadowRoot().querySelector('button[aria-label]')).toBeNull();
  });

  it('shows a non-blocking error indication when a control action fails, without crashing', async () => {
    statusResponse = { success: true, data: baseSession(), meta: { timestamp: '', requestId: '' } };
    await mountWidget();

    const shadow = getShadowRoot();
    const icon = shadow.querySelector('button[aria-label]') as HTMLButtonElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });

    queueControlResponse({
      success: false,
      error: { code: 'ERR_MICROPHONE_TOGGLE_FAILED', message: 'Microphone toggle failed' },
      meta: { timestamp: '', requestId: '' },
    });

    const buttons = Array.from(shadow.querySelectorAll('button'));
    const micButton = buttons.find((b) => b.textContent?.includes('Microphone')) as HTMLButtonElement;

    await act(async () => {
      micButton.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await flushMicrotasks();
    });

    expect(shadow.textContent).toContain('Microphone toggle failed');
    // Widget stays usable/mounted after a failed control action.
    expect(getHost()).not.toBeNull();
  });
});
