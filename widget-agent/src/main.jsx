import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/chatWidget.css';

const searchParams = new URLSearchParams(window.location.search);
const normalizedPath = window.location.pathname.replace(/\/+$/, '');
const isEmbeddedWidget =
  normalizedPath === '/embed' ||
  normalizedPath.endsWith('/embed') ||
  searchParams.get('embed') === 'true';

document.documentElement.classList.toggle('widget-embedded-document', isEmbeddedWidget);
document.body.classList.toggle('widget-embedded-document', isEmbeddedWidget);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App isEmbedded={isEmbeddedWidget} />
  </React.StrictMode>,
);
