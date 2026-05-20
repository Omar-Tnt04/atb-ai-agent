const {
  getAvailableConnectors,
} = require('../connectors/connectorRegistry');
const {
  getAllExternalServiceStatuses,
} = require('../connectors/external/externalService.config');

const listConnectors = (req, res) => {
  return res.json({
    success: true,
    data: getAvailableConnectors(),
  });
};

const getExternalStatus = (req, res) => {
  return res.json({
    success: true,
    data: getAllExternalServiceStatuses(),
  });
};

module.exports = {
  getExternalStatus,
  listConnectors,
};
