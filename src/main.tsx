import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { FeedbackProvider } from '@/components/ui/feedback';
import './index.css';

// Apply saved theme before first render to prevent flash of wrong theme
if (localStorage.getItem('denos-theme') === 'light') {
    document.documentElement.classList.add('light');
}
ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <FeedbackProvider>
            <App />
        </FeedbackProvider>
    </React.StrictMode>,
);
