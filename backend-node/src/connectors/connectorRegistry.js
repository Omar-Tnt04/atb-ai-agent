const mockDocumentConnector = require('./documents/mockDocument.connector');
const externalDocumentConnector = require('./documents/externalDocument.connector');
const hybridDocumentConnector = require('./documents/hybridDocument.connector');
const mockAppointmentConnector = require('./appointments/mockAppointment.connector');
const externalAppointmentConnector = require('./appointments/externalAppointment.connector');
const hybridAppointmentConnector = require('./appointments/hybridAppointment.connector');
const sandboxPaymentConnector = require('./payments/sandboxPayment.connector');
const externalPaymentConnector = require('./payments/externalPayment.connector');
const hybridPaymentConnector = require('./payments/hybridPayment.connector');
const sandboxTransferConnector = require('./transfers/sandboxTransfer.connector');
const simulatedSmsConnector = require('./notifications/simulatedSms.connector');
const internalAtbConnector = require('./internal/internalAtb.connector');
const internalPaymentConnector = require('./internal/internalPayment.connector');
const internalDocumentConnector = require('./internal/internalDocument.connector');
const internalAppointmentConnector = require('./internal/internalAppointment.connector');
const internalAccountConnector = require('./internal/internalAccount.connector');

// This registry is the stable connector layer boundary. The normal action path
// routes through the internal* connectors, which call the separate internal demo
// services over HTTP. In production those service URLs are replaced by real ATB
// internal APIs without changing the actions above. The legacy mock/sandbox/
// external connectors are kept registered only for the read-only list_documents
// action and for reference; they are not used by the high-value action path.
const connectors = [
  internalAccountConnector,
  internalAtbConnector,
  internalPaymentConnector,
  internalDocumentConnector,
  internalAppointmentConnector,
  hybridDocumentConnector,
  mockDocumentConnector,
  externalDocumentConnector,
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
