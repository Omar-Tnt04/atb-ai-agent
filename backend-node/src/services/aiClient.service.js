const axios = require('axios');
const env = require('../config/env');

const analyzeMessage = async ({
  message,
  userRole,
  availableActions,
  conversationHistory,
  fileContext,
  resolvedResourceContext,
  profileContext,
  agentContext,
}) => {
  const response = await axios.post(`${env.aiServiceUrl}/agent/analyze`, {
    message,
    userRole,
    availableActions,
    conversationHistory,
    fileContext,
    resolvedResourceContext,
    profileContext,
    agentContext,
  });

  return response.data;
};

module.exports = {
  analyzeMessage,
};
