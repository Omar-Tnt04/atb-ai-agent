const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const accountRoutes = require('./routes/account.routes');
const actionExecutionRoutes = require('./routes/actionExecution.routes');
const actionRoutes = require('./routes/action.routes');
const appointmentRoutes = require('./routes/appointment.routes');
const auditRoutes = require('./routes/audit.routes');
const authRoutes = require('./routes/auth.routes');
const billRoutes = require('./routes/bill.routes');
const chatRoutes = require('./routes/chat.routes');
const complaintRoutes = require('./routes/complaint.routes');
const documentRoutes = require('./routes/document.routes');
const generatedFileRoutes = require('./routes/generatedFile.routes');
const healthRoutes = require('./routes/health.routes');
const integrationRoutes = require('./routes/integration.routes');
const resourceRoutes = require('./routes/resource.routes');
const smsVerificationRoutes = require('./routes/smsVerification.routes');
const transferRoutes = require('./routes/transfer.routes');
const widgetDemoRoutes = require('./routes/widgetDemo.routes');
const devLauncherRoutes = require('./routes/devLauncher.routes');
const { notFoundHandler, errorHandler } = require('./middleware/error.middleware');

const app = express();

app.use(cors());
app.use(express.json());

// In DEMO_CONSOLE mode suppress all HTTP access logs (replaced by [DEMO] step lines).
// In debug mode keep morgan 'dev'; suppress only poll GETs when LOG_BROWSER_POLLING=false.
const _isDemoConsole = () =>
  ['1', 'true', 'yes', 'on'].includes(String(process.env.DEMO_CONSOLE || '').toLowerCase());
const _isLogPolling = () =>
  ['1', 'true', 'yes', 'on'].includes(String(process.env.LOG_BROWSER_POLLING || '').toLowerCase());

app.use(morgan('dev', {
  skip: (req) => {
    if (_isDemoConsole()) return true;
    if (!_isLogPolling() && /\/browser-agent\/[a-f0-9]{16}$/.test(req.path)) return true;
    return false;
  },
}));

app.use('/generated', generatedFileRoutes);
app.use('/health', healthRoutes);
app.use('/resources', resourceRoutes);
app.use('/auth', authRoutes);
app.use('/chat', chatRoutes);
app.use('/actions', actionRoutes);
app.use('/agent/actions', actionExecutionRoutes);
app.use('/agent/audit', auditRoutes);
app.use('/integrations', integrationRoutes);
app.use('/mock/accounts', accountRoutes);
app.use('/mock/bills', billRoutes);
app.use('/mock/documents', documentRoutes);
app.use('/mock/complaints', complaintRoutes);
app.use('/mock/appointments', appointmentRoutes);
app.use('/mock/transfers', transferRoutes);
app.use('/sms', smsVerificationRoutes);
app.use('/api/widget', widgetDemoRoutes);
app.use('/dev', devLauncherRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
