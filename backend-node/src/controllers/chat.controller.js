const {
  getConnectedActionsByRole,
} = require('../actions/actionRegistry');
const { analyzeMessage } = require('../services/aiClient.service');

const toAiAction = (action) => {
  return {
    name: action.name,
    riskLevel: action.riskLevel,
    requiredFields: action.requiredFields,
  };
};

const analyzeChatMessage = async (req, res) => {
  const { message, conversationHistory = [] } = req.body;

  if (!message) {
    return res.status(400).json({
      success: false,
      message: 'message is required',
    });
  }

  try {
    const availableActions = getConnectedActionsByRole(req.user.role).map(
      toAiAction,
    );

    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions,
      conversationHistory,
    });

    return res.json({
      success: true,
      message: 'Message analyzed successfully',
      data: aiResponse.data,
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

module.exports = {
  analyzeChatMessage,
};
