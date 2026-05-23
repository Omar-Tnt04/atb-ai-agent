const {
  getAvailableConnectors,
} = require('../connectors/connectorRegistry');
const {
  getAllInternalServiceStatuses,
} = require('../connectors/internal/internalService.config');

const listConnectors = (req, res) => {
  return res.json({
    success: true,
    data: getAvailableConnectors(),
  });
};

const getInternalServiceStatus = async (req, res) => {
  const statuses = await getAllInternalServiceStatuses();

  return res.json({
    success: true,
    data: statuses,
  });
};

module.exports = {
  getInternalServiceStatus,
  listConnectors,
};
