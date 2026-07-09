// ATB AI Widget Injector URL configuration.
// This tracked file must stay safe for GitHub delivery.
// Do not put live tunnel URLs, ngrok URLs, Cloudflare tunnel URLs, or private deployment values here.
//
// For HTTPS tunnel demos, use widget-config.local.js or the backend-provided
// /dev/widget-config flow. widget-config.local.js is ignored by Git.

window.__ATB_WIDGET_CONFIG__ = {
  // Widget SPA (React app served by Vite).
  widgetUrl: 'http://localhost:5174',

  // Backend API (Node.js service).
  apiUrl: 'http://localhost:5000',
};
