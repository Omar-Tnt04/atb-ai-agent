const {
  getActionByName,
  getActionsByRole,
  getConnectedActionsByRole,
  isActionAllowedForRole,
} = require('../actions/actionRegistry');

const getActions = (req, res) => {
  return res.json({
    success: true,
    message: 'Actions retrieved successfully',
    data: getActionsByRole(req.user.role),
  });
};

const getConnectedActions = (req, res) => {
  return res.json({
    success: true,
    message: 'Connected actions retrieved successfully',
    data: getConnectedActionsByRole(req.user.role),
  });
};

const getAction = (req, res) => {
  const { actionName } = req.params;
  const action = getActionByName(actionName);

  if (!action) {
    return res.status(404).json({
      success: false,
      message: 'Action not found',
    });
  }

  if (!isActionAllowedForRole(actionName, req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Action is not allowed for this user role',
    });
  }

  return res.json({
    success: true,
    message: 'Action retrieved successfully',
    data: action,
  });
};

module.exports = {
  getActions,
  getConnectedActions,
  getAction,
};
