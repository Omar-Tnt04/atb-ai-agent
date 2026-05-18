require('dotenv').config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET || 'replace_with_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
};

module.exports = env;
