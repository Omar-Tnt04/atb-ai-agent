const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const GENERATED_DIR = path.resolve(__dirname, '..', '..', 'generated');

const ensureDir = async () => {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
};

const generateId = () => crypto.randomBytes(16).toString('hex');

const buildCsvContent = (content, data) => {
  if (Array.isArray(data) && data.length > 0) {
    const headers = Object.keys(data[0]);
    const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = data.map((row) => headers.map((h) => escapeCell(row[h])).join(','));
    return [headers.join(','), ...rows].join('\n');
  }
  return content || '';
};

const buildJsonContent = (content, data) => {
  if (data !== null && data !== undefined) {
    return JSON.stringify(data, null, 2);
  }
  return JSON.stringify({ content: content || '' }, null, 2);
};

const buildTxtContent = (content) => content || '';

const buildFileContent = (fileType, content, data) => {
  switch (fileType) {
    case 'csv':
      return buildCsvContent(content, data);
    case 'json':
      return buildJsonContent(content, data);
    default:
      return buildTxtContent(content);
  }
};

const sanitizeTitle = (title) =>
  (title || 'file').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 60) || 'file';

const generateFile = async ({
  fileType = 'txt',
  title = 'Generated File',
  content = '',
  data = null,
}) => {
  await ensureDir();

  const extension = ['csv', 'json', 'txt'].includes(fileType.toLowerCase())
    ? fileType.toLowerCase()
    : 'txt';

  const fileId = generateId();
  const fileName = `${fileId}.${extension}`;
  const filePath = path.join(GENERATED_DIR, fileName);
  const displayName = `${sanitizeTitle(title)}.${extension}`;

  const fileContent = buildFileContent(extension, content, data);
  await fs.writeFile(filePath, fileContent, 'utf8');

  return {
    fileId,
    fileName: displayName,
    fileType: extension,
    title: title || 'Generated File',
    filePath,
    downloadUrl: `/generated/${fileId}/download`,
  };
};

const getGeneratedFile = async (fileId) => {
  if (!/^[a-f0-9]{32}$/.test(fileId)) {
    return null;
  }

  await ensureDir();

  const files = await fs.readdir(GENERATED_DIR);
  const match = files.find((f) => f.startsWith(fileId));

  if (!match) {
    return null;
  }

  const extension = path.extname(match).slice(1);
  return {
    filePath: path.join(GENERATED_DIR, match),
    fileName: match,
    extension,
  };
};

module.exports = {
  generateFile,
  getGeneratedFile,
};
