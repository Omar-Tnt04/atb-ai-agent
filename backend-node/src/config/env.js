require('dotenv').config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET || 'replace_with_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  widgetDemoMode: process.env.WIDGET_DEMO_MODE === 'true',
};

module.exports = env;
