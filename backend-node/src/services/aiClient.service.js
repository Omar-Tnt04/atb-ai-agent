const axios = require('axios');
const env = require('../config/env');

const analyzeMessage = async ({
  message,
  userRole,
  availableActions,
  conversationHistory,
}) => {
  const response = await axios.post(`${env.aiServiceUrl}/agent/analyze`, {
    message,
    userRole,
    availableActions,
    conversationHistory,
  });

  return response.data;
};

module.exports = {
  analyzeMessage,
};
