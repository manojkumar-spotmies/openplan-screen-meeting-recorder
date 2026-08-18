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
}
initMeetDetector();
