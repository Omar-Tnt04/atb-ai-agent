const express = require('express');
const path = require('path');

const authMiddleware = require('../middleware/auth.middleware');
const { getGeneratedFile } = require('../services/generatedFile.service');

const router = express.Router();

router.use(authMiddleware);

router.get('/:fileId/download', async (req, res) => {
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
