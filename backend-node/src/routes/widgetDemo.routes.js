const express = require('express');
const path = require('path');

const {
  cancelAgentAction,
  confirmAgentAction,
  executeAgentAction,
  prepareAgentAction,
  verifyAndExecuteAgentAction,
} = require('../controllers/actionExecution.controller');
const { handleChatMessage } = require('../controllers/chat.controller');
const env = require('../config/env');
const { getGeneratedFile } = require('../services/generatedFile.service');

const router = express.Router();

const DEMO_USER = {
  id: 'user_client_001',
  demoUserId: 'user_001',
  fullName: 'Omar Tentouch',
  email: 'widget.demo@atb.local',
  role: 'CLIENT',
  phoneNumber: '+21655123456',
  phoneVerified: true,
  accounts: ['acc_001', 'acc_002'],
};

const isWidgetDemoEnabled = () =>
  env.widgetDemoMode || env.nodeEnv !== 'production';

// Development-only route guard for the standalone widget preview.
// This bypasses normal token auth only for synthetic demo data and must not be
// used as a production authentication path.
const widgetDemoGuard = (req, res, next) => {
  if (!isWidgetDemoEnabled()) {
    return res.status(403).json({
      success: false,
      status: 'widget_demo_disabled',
      message: 'Widget demo mode is disabled.',
    });
  }

  req.user = DEMO_USER;
  return next();
};

router.use(widgetDemoGuard);

router.post('/chat', handleChatMessage);
router.post('/actions/cancel', cancelAgentAction);
router.post('/actions/confirm', confirmAgentAction);
router.post('/actions/execute', executeAgentAction);
router.post('/actions/prepare', prepareAgentAction);
router.post('/actions/verify-and-execute', verifyAndExecuteAgentAction);

router.get('/generated/:fileId/download', async (req, res) => {
  const { fileId } = req.params;

  if (!/^[a-f0-9]{32}$/.test(fileId)) {
    return res.status(400).json({ success: false, message: 'Invalid file ID' });
  }

  try {
    const fileInfo = await getGeneratedFile(fileId);

    if (!fileInfo) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    const mimeTypes = {
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
    };

    const mime = mimeTypes[fileInfo.extension] || 'application/octet-stream';
    const safeFileName = path.basename(fileInfo.fileName).replace(/[^a-z0-9._-]/gi, '_');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);

    return res.sendFile(fileInfo.filePath);
  } catch {
    return res.status(500).json({ success: false, message: 'File download failed' });
  }
});

module.exports = router;
