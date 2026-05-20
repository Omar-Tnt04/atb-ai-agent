const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const TEXT_PREVIEW_LIMIT = 50000;
const COMBINED_TEXT_LIMIT = 120000;

const getExtension = (fileName = '') => {
  return path.extname(fileName).toLowerCase().replace('.', '');
};

const truncate = (value, limit) => {
  if (!value || value.length <= limit) {
    return value || '';
  }

  return `${value.slice(0, limit)}\n[Content truncated for analysis]`;
};

const normalizeText = (value = '') => {
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};

const extractTextFile = async (filePath) => {
  const rawText = await fs.readFile(filePath, 'utf8');
  return normalizeText(truncate(rawText, TEXT_PREVIEW_LIMIT));
};

const extractPdfFile = async (filePath) => {
  const buffer = await fs.readFile(filePath);
  const parsed = await pdfParse(buffer);
  return normalizeText(truncate(parsed.text || '', TEXT_PREVIEW_LIMIT));
};

const extractDocxFile = async (filePath) => {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeText(truncate(result.value || '', TEXT_PREVIEW_LIMIT));
};

const extractSingleFile = async (file) => {
  const extension = getExtension(file.originalname);
  const base = {
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    storedPath: file.path,
    extractedText: '',
    extractionStatus: 'unsupported',
  };

  try {
    if (extension === 'txt' || extension === 'csv') {
      const extractedText = await extractTextFile(file.path);
      return {
        ...base,
        extractedText,
        extractionStatus: extractedText ? 'extracted' : 'empty',
      };
    }

    if (extension === 'pdf') {
      const extractedText = await extractPdfFile(file.path);
      return {
        ...base,
        extractedText,
        extractionStatus: extractedText ? 'extracted' : 'empty',
      };
    }

    if (extension === 'docx') {
      const extractedText = await extractDocxFile(file.path);
      return {
        ...base,
        extractedText,
        extractionStatus: extractedText ? 'extracted' : 'empty',
      };
    }

    if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
      return {
        ...base,
        extractionStatus: 'metadata_only',
      };
    }

    return base;
  } catch (error) {
    return {
      ...base,
      extractionStatus: 'failed',
    };
  }
};

const buildFileContext = async (files = []) => {
  const extractedFiles = await Promise.all(files.map(extractSingleFile));
  const combinedText = truncate(
    extractedFiles
      .filter((file) => file.extractedText)
      .map(
        (file) =>
          `File: ${file.originalName}\nMIME: ${file.mimeType}\n${file.extractedText}`,
      )
      .join('\n\n---\n\n'),
    COMBINED_TEXT_LIMIT,
  );

  console.log('[fileContext] combinedText length:', combinedText.length);
  console.log('[fileContext] combinedText:', combinedText.slice(0, 200));

  return {
    files: extractedFiles,
    combinedText,
    hasUploadedFiles: files.length > 0,
  };
};

module.exports = {
  buildFileContext,
};
