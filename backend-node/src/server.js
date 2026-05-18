const app = require('./app');
const env = require('./config/env');

app.listen(env.port, () => {
  console.log(`ATB AI Banking Agent Backend running on port ${env.port}`);
});
