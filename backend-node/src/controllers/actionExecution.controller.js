const { prepareAction } = require('../services/actionPreparation.service');
const { executeAction } = require('../services/actionExecution.service');

const prepareAgentAction = (req, res) => {
  const { actionName, payload = {} } = req.body;

  if (!actionName) {
    return res.status(400).json({
      success: false,
      status: 'missing_fields',
      missingFields: ['actionName'],
    });
  }

  const result = prepareAction({
    actionName,
    payload,
    user: req.user,
  });

  return res.status(result.httpStatus).json(result.body);
};

const executeAgentAction = (req, res) => {
  const { actionName, payload = {} } = req.body;

  if (!actionName) {
    const result = executeAction({
      actionName,
      payload,
      user: req.user,
    });

    return res.status(result.httpStatus).json(result.body);
  }

  const result = executeAction({
    actionName,
    payload,
    user: req.user,
  });

  return res.status(result.httpStatus).json(result.body);
};

module.exports = {
  executeAgentAction,
  prepareAgentAction,
};
