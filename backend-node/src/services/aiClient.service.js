const axios = require('axios');
const env = require('../config/env');

const analyzeMessage = async ({
  message,
  userRole,
  availableActions,
  conversationHistory,
  fileContext,
  profileContext,
}) => {
  const response = await axios.post(`${env.aiServiceUrl}/agent/analyze`, {
    message,
    userRole,
    availableActions,
    conversationHistory,
    fileContext,
    profileContext,
  });

  return response.data;
};

module.exports = {
  analyzeMessage,
};
