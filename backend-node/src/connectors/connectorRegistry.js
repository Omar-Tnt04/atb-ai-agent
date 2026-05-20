const mockDocumentConnector = require('./documents/mockDocument.connector');
const externalDocumentConnector = require('./documents/externalDocument.connector');
const hybridDocumentConnector = require('./documents/hybridDocument.connector');
const mockComplaintConnector = require('./complaints/mockComplaint.connector');
const externalComplaintConnector = require('./complaints/externalComplaint.connector');
const hybridComplaintConnector = require('./complaints/hybridComplaint.connector');
const mockAppointmentConnector = require('./appointments/mockAppointment.connector');
const externalAppointmentConnector = require('./appointments/externalAppointment.connector');
const hybridAppointmentConnector = require('./appointments/hybridAppointment.connector');
const sandboxPaymentConnector = require('./payments/sandboxPayment.connector');
const externalPaymentConnector = require('./payments/externalPayment.connector');
const hybridPaymentConnector = require('./payments/hybridPayment.connector');
const sandboxTransferConnector = require('./transfers/sandboxTransfer.connector');
const simulatedSmsConnector = require('./notifications/simulatedSms.connector');

// This registry is the stable connector layer boundary. Demo connectors can be
// replaced later with real ATB application connectors without changing actions.
const connectors = [
  mockDocumentConnector,
  externalDocumentConnector,
  hybridDocumentConnector,
  mockComplaintConnector,
  externalComplaintConnector,
  hybridComplaintConnector,
  mockAppointmentConnector,
  externalAppointmentConnector,
  hybridAppointmentConnector,
  sandboxPaymentConnector,
  externalPaymentConnector,
  hybridPaymentConnector,
  sandboxTransferConnector,
  simulatedSmsConnector,
];

const connectorMap = connectors.reduce((registry, connector) => {
  registry[connector.name] = connector;
  return registry;
}, {});

const getConnector = (connectorName) => connectorMap[connectorName] || null;

const getAvailableConnectors = () => {
  return connectors.map((connector) => ({
    name: connector.name,
    description: connector.description,
    operations: Object.keys(connector.operations),
  }));
};

const executeConnectorOperation = async ({
  connectorName,
  operationName,
  user,
  payload = {},
}) => {
  const connector = getConnector(connectorName);

  if (!connector) {
    return {
      success: false,
      status: 'connector_not_found',
      message: `Connector not found: ${connectorName}`,
    };
  }

  const operation = connector.operations[operationName];

  if (!operation) {
    return {
      success: false,
      status: 'operation_not_found',
      message: `Operation not found: ${operationName}`,
    };
  }

  return operation({ user, payload });
};

module.exports = {
  executeConnectorOperation,
  getAvailableConnectors,
  getConnector,
};
