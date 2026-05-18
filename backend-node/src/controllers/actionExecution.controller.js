const { prepareAction } = require('../services/actionPreparation.service');

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

module.exports = {
  prepareAgentAction,
};
