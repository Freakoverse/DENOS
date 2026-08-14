import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FeedbackProvider } from '@/components/ui/feedback';
import { SignerNotification, SignerNotificationManager } from '@/components/SignerNotification';
import './index.css';

// Apply saved theme before first render to prevent flash of wrong theme
if (localStorage.getItem('denos-theme') === 'light') {
    document.documentElement.classList.add('light');
}

// The signing-request popup runs in its own OS window (label 'signer-notif') off the same
// bundle; render only that window's UI there, and the full app (+ its lifecycle manager) elsewhere.
let windowLabel = 'main';
try { windowLabel = getCurrentWindow().label; } catch { /* non-Tauri (browser dev) → main */ }

const root = ReactDOM.createRoot(document.getElementById('root')!);
if (windowLabel === 'signer-notif') {
    // IMPORTANT: never import App here — the popup window must stay a tiny webview. Pulling the
    // full app bundle into a second webview is heavy enough to freeze/blank the popup.
    root.render(
        <React.StrictMode>
            <FeedbackProvider>
                <SignerNotification />
            </FeedbackProvider>
        </React.StrictMode>,
    );
} else {
    // Lazy-load the heavy app graph only for the main window (keeps the popup webview light).
    Promise.all([import('./App'), import('@/lib/blossomMediaCache')]).then(([{ default: App }, media]) => {
        media.requestPersistentStorage(); // keep cached media across sessions (best-effort)
        root.render(
            <React.StrictMode>
                <FeedbackProvider>
                    <App />
                    <SignerNotificationManager />
                </FeedbackProvider>
            </React.StrictMode>,
        );
    });
}
