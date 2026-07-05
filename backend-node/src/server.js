const app = require('./app');
const env = require('./config/env');
const { loadResourceCatalog } = require('./services/resourceCatalog.service');
const { DEBUG_BUILD, HANDLER_FILE } = require('./services/routeTrace.service');

const start = async () => {
  try {
    await loadResourceCatalog();
  } catch (error) {
    console.error('[startup] Resource catalog validation failed:', error.message);
    process.exit(1);
  }

  app.listen(env.port, () => {
    // Version marker — only in debug mode (suppress in DEMO_CONSOLE to keep startup clean).
    if (!env.demoConsole) {
      console.log(`[BACKEND_CODE_VERSION] dom-debug-v1 pid=${process.pid} port=${env.port}`);
    }
    if (env.backendDebugBoot) {
      // Boot proof: reveals which process/code booted + the live flag value when explicitly enabled.
      console.log(
        `[BACKEND_DEBUG_BOOT] build=${DEBUG_BUILD} pid=${process.pid} cwd=${process.cwd()} ` +
        `handlerExpected=${HANDLER_FILE} DEBUG_AGENT_ROUTING=${env.debugAgentRouting} PORT=${env.port}`,
      );
    }
    console.log(`ATB AI Banking Agent Backend running on port ${env.port}`);
  });
};

start();
