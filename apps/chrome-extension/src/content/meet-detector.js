import { logger } from '@openplan/core';
/**
 * Content script running on https://meet.google.com/* tabs.
 * Detects tab unloading/closing and notifies the background service worker.
 */
function initMeetDetector() {
    logger.info('Google Meet detector initialized');
    window.addEventListener('beforeunload', () => {
        try {
            const message = {
                target: 'SERVICE_WORKER',
                action: 'STOP_RECORDING',
                payload: { url: window.location.href },
                meta: {
                    timestamp: new Date().toISOString(),
                    requestId: crypto.randomUUID(),
                },
            };
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(message).catch((err) => {
                    logger.warn('Failed to send meet tab unload message to service worker:', err);
                });
            }
        }
        catch (err) {
            logger.error('Error during meet beforeunload handler:', err);
        }
    });
    // DOM Observer for Google Meet call-end screen ("You left the call")
    let stopTriggered = false;
    const observer = new MutationObserver(() => {
        if (stopTriggered)
            return;
        const bodyText = document.body ? document.body.innerText || '' : '';
        if (bodyText.includes('You left the call') || bodyText.includes('You have left the meeting') || document.querySelector('[data-call-ended="true"]')) {
            stopTriggered = true;
            logger.info('Google Meet call-end DOM screen detected. Auto-stopping recording.');
            const message = {
                target: 'SERVICE_WORKER',
                action: 'STOP_RECORDING',
                payload: { reason: 'TAB_CLOSED' },
                meta: {
                    timestamp: new Date().toISOString(),
                    requestId: crypto.randomUUID(),
                },
            };
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(message).catch((err) => {
                    logger.warn('Failed to send call-end message to service worker:', err);
                });
            }
            observer.disconnect();
        }
    });
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }
}
initMeetDetector();
