const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const {
  analyzeChatMessage,
  handleChatMessage,
  handleChatMessageWithFiles,
} = require('../controllers/chat.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

const uploadDir = path.resolve(__dirname, '..', '..', 'uploads', 'chat');
fs.mkdirSync(uploadDir, { recursive: true });

const blockedExtensions = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.js',
  '.ps1',
  '.vbs',
  '.msi',
  '.scr',
]);

const DOCX_UNSUPPORTED_MESSAGE =
  'DOCX files are not supported. Please upload a PDF, image, TXT, CSV, or JSON file.';

const UNSUPPORTED_FILE_MESSAGE =
  'Unsupported file type. Please upload a PDF, image, TXT, CSV, or JSON file.';

const allowedExtensions = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.csv',
  '.json',
]);

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, uploadDir);
  },
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const safeBaseName = path
      .basename(file.originalname, extension)
      .replace(/[^a-z0-9_-]/gi, '_')
      .slice(0, 80);
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    callback(null, `${safeBaseName || 'upload'}-${uniqueSuffix}${extension}`);
  },
});

const fileFilter = (req, file, callback) => {
  const extension = path.extname(file.originalname).toLowerCase();

  if (extension === '.docx') {
    return callback(new Error(DOCX_UNSUPPORTED_MESSAGE));
  }

  if (blockedExtensions.has(extension)) {
    return callback(new Error('Executable or script files are not allowed'));
  }

  if (!allowedExtensions.has(extension)) {
    return callback(new Error(UNSUPPORTED_FILE_MESSAGE));
  }

  return callback(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

const handleUpload = (req, res, next) => {
  const middleware = upload.array('files', 5);

  middleware(req, res, (error) => {
    if (!error) {
      return next();
    }

    const statusCode = error instanceof multer.MulterError ? 400 : 415;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'File upload failed',
    });
  });
};

router.use(authMiddleware);

router.post('/analyze', analyzeChatMessage);
router.post('/message', handleChatMessage);
router.post('/message-with-files', handleUpload, handleChatMessageWithFiles);

module.exports = router;
