const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const accountRoutes = require('./routes/account.routes');
const actionExecutionRoutes = require('./routes/actionExecution.routes');
const actionRoutes = require('./routes/action.routes');
const appointmentRoutes = require('./routes/appointment.routes');
const auditRoutes = require('./routes/audit.routes');
const authRoutes = require('./routes/auth.routes');
const complaintRoutes = require('./routes/complaint.routes');
const documentRoutes = require('./routes/document.routes');
const healthRoutes = require('./routes/health.routes');
const { notFoundHandler, errorHandler } = require('./middleware/error.middleware');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/actions', actionRoutes);
app.use('/agent/actions', actionExecutionRoutes);
app.use('/agent/audit', auditRoutes);
app.use('/mock/accounts', accountRoutes);
app.use('/mock/documents', documentRoutes);
app.use('/mock/complaints', complaintRoutes);
app.use('/mock/appointments', appointmentRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
