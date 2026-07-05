process.env.DEV_MODE = 'hosted-browser';
// Default to demo mode when launched via `npm run dev`. Explicit env override still wins.
process.env.DEMO_CONSOLE ??= 'true';
process.env.DEV_LAUNCHER_DEBUG ??= 'false';
require('./start.js');
