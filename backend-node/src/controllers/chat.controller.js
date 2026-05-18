const {
  getConnectedActionsByRole,
} = require('../actions/actionRegistry');
const { prepareAction } = require('../services/actionPreparation.service');
const { analyzeMessage } = require('../services/aiClient.service');

const toAiAction = (action) => {
  return {
    name: action.name,
    riskLevel: action.riskLevel,
    requiredFields: action.requiredFields,
  };
};

const getAvailableAiActions = (role) => {
  return getConnectedActionsByRole(role).map(toAiAction);
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
    const availableActions = getAvailableAiActions(req.user.role);

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

const createMissingFieldsMessage = (missingFields) => {
  return `Please provide the following information: ${missingFields.join(', ')}.`;
};

const handleChatMessage = async (req, res) => {
  const { message, payload = {}, conversationHistory = [] } = req.body;

  if (!message) {
    return res.status(400).json({
      success: false,
      message: 'message is required',
    });
  }

  try {
    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions: getAvailableAiActions(req.user.role),
      conversationHistory,
    });

    const ai = aiResponse.data;

    if (!ai.actionName || ai.intent === 'unknown') {
      return res.json({
        success: true,
        status: 'needs_clarification',
        assistantMessage: ai.assistantMessage,
        data: {
          ai,
        },
      });
    }

    const preparation = prepareAction({
      actionName: ai.actionName,
      payload,
      user: req.user,
    });

    if (preparation.body.status === 'missing_fields') {
      return res.json({
        success: true,
        status: 'missing_fields',
        assistantMessage:
          ai.assistantMessage ||
          createMissingFieldsMessage(preparation.body.missingFields),
        data: {
          ai,
          missingFields: preparation.body.missingFields,
        },
      });
    }

    if (preparation.body.status === 'not_connected') {
      return res.json({
        success: true,
        status: 'not_connected',
        assistantMessage:
          'I understood your request, but this action is not connected in the current MVP.',
        data: {
          ai,
          actionName: ai.actionName,
        },
      });
    }

    if (preparation.body.status === 'prepared') {
      return res.json({
        success: true,
        status: 'action_prepared',
        assistantMessage:
          'I prepared this action. Please review the summary before continuing.',
        data: {
          ai,
          preparation: preparation.body.data,
        },
      });
    }

    return res.status(preparation.httpStatus).json(preparation.body);
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

module.exports = {
  analyzeChatMessage,
  handleChatMessage,
};
