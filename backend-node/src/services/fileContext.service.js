const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { PSM, createWorker } = require('tesseract.js');

const TEXT_PREVIEW_LIMIT = 50000;
const COMBINED_TEXT_LIMIT = 120000;
const OCR_ENABLED = process.env.OCR_ENABLED !== 'false';
const OCR_LANGUAGES = process.env.OCR_LANGUAGES || 'eng+fra';
const OCR_MIN_READABLE_CHARS = Number(process.env.OCR_MIN_READABLE_CHARS || 8);
const OCR_IMAGE_MAX_WIDTH = Number(process.env.OCR_IMAGE_MAX_WIDTH || 1800);
const OCR_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const OCR_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

let ocrWorkerPromise = null;
let ocrQueue = Promise.resolve();

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
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/^--\s*\d+\s+of\s+\d+\s*--$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const readableCharacterCount = (value = '') => {
  const matches = String(value).match(/[A-Za-z0-9]/g);
  return matches ? matches.length : 0;
};

const hasReadableText = (value = '') =>
  readableCharacterCount(value) >= OCR_MIN_READABLE_CHARS;

const buildTextExtractionResult = (extractedText, emptyMessage) => {
  const normalizedText = normalizeText(truncate(extractedText, TEXT_PREVIEW_LIMIT));

  if (normalizedText) {
    return {
      extractedText: normalizedText,
      extractionStatus: 'extracted',
    };
  }

  return {
    extractedText: '',
    extractionStatus: 'failed',
    extractionError: emptyMessage || 'No readable text found',
  };
};

const buildOcrExtractionResult = (extractedText) => {
  const normalizedText = normalizeText(truncate(extractedText, TEXT_PREVIEW_LIMIT));

  if (hasReadableText(normalizedText)) {
    return {
      extractedText: normalizedText,
      extractionStatus: 'ocr_extracted',
    };
  }

  return {
    extractedText: '',
    extractionStatus: 'ocr_empty',
    extractionError: 'OCR did not find enough readable text',
  };
};

const buildOcrDisabledResult = () => ({
  extractedText: '',
  extractionStatus: 'ocr_empty',
  extractionError: 'OCR is not enabled for scanned or image-based documents',
});

const getFileKind = (file) => {
  const extension = getExtension(file.originalname);
  const mimeType = String(file.mimetype || '').toLowerCase();

  if (extension === 'txt' || mimeType.startsWith('text/plain')) return 'text';
  if (extension === 'csv' || mimeType.includes('csv')) return 'csv';
  if (extension === 'json' || mimeType.includes('json')) return 'json';
  if (extension === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (OCR_IMAGE_EXTENSIONS.has(extension) || OCR_IMAGE_MIME_TYPES.has(mimeType)) {
    return 'image';
  }

  return 'unsupported';
};

const extractTextFile = async (filePath) => {
  const rawText = await fs.readFile(filePath, 'utf8');
  return normalizeText(truncate(rawText, TEXT_PREVIEW_LIMIT));
};

const extractJsonFile = async (filePath) => {
  const rawText = await fs.readFile(filePath, 'utf8');

  try {
    return normalizeText(
      truncate(JSON.stringify(JSON.parse(rawText), null, 2), TEXT_PREVIEW_LIMIT),
    );
  } catch {
    return normalizeText(truncate(rawText, TEXT_PREVIEW_LIMIT));
  }
};

const getOcrWorker = async () => {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(OCR_LANGUAGES).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
      });
      return worker;
    });
  }

  return ocrWorkerPromise;
};

const runWithOcrWorker = (task) => {
  const nextTask = ocrQueue.then(async () => task(await getOcrWorker()));
  ocrQueue = nextTask.catch(() => {});
  return nextTask;
};

const shutdownOcrWorker = async () => {
  await ocrQueue.catch(() => {});

  if (!ocrWorkerPromise) {
    return;
  }

  const worker = await ocrWorkerPromise.catch(() => null);
  ocrWorkerPromise = null;

  if (worker) {
    await worker.terminate();
  }
};

const prepareImageForOcr = async (input) =>
  sharp(input, { limitInputPixels: false })
    .rotate()
    .grayscale()
    .normalize()
    .resize({
      width: OCR_IMAGE_MAX_WIDTH,
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

const recognizeImageBuffer = async (imageBuffer) => {
  const preparedImage = await prepareImageForOcr(imageBuffer);
  const result = await runWithOcrWorker((worker) => worker.recognize(preparedImage));
  return normalizeText(truncate(result?.data?.text || '', TEXT_PREVIEW_LIMIT));
};

const extractImageFile = async (filePath) => {
  if (!OCR_ENABLED) {
    return buildOcrDisabledResult();
  }

  const ocrText = await recognizeImageBuffer(await fs.readFile(filePath));
  return buildOcrExtractionResult(ocrText);
};

const extractSingleFile = async (file) => {
  const fileKind = getFileKind(file);
  const isVisualInput = fileKind === 'image' || fileKind === 'pdf';
  const base = {
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    storedPath: file.path,
    fileKind,
    isVisualInput,
    extractedText: '',
    extractionStatus: 'unsupported',
  };

  try {
    if (fileKind === 'text' || fileKind === 'csv') {
      const extractedText = await extractTextFile(file.path);
      return {
        ...base,
        ...buildTextExtractionResult(extractedText),
      };
    }

    if (fileKind === 'json') {
      const extractedText = await extractJsonFile(file.path);
      return {
        ...base,
        ...buildTextExtractionResult(extractedText),
      };
    }

    if (fileKind === 'pdf') {
      return {
        ...base,
        extractionStatus: 'vision_pending',
        isOcrDerived: false,
        isScannedOrImageBased: true,
      };
    }

    if (fileKind === 'image') {
      const result = await extractImageFile(file.path);
      return {
        ...base,
        ...result,
        isOcrDerived: result.extractionStatus === 'ocr_extracted',
        isScannedOrImageBased: true,
      };
    }

    return {
      ...base,
      extractionStatus: 'failed',
      extractionError: 'Unsupported file type for text extraction',
    };
  } catch (error) {
    return {
      ...base,
      extractionStatus: 'failed',
      extractionError: error.message || 'Text extraction failed',
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

  extractedFiles.forEach((file) => {
    console.log('[fileContext] file:', {
      originalName: file.originalName,
      mimeType: file.mimeType,
      extractionStatus: file.extractionStatus,
      extractedTextLength: file.extractedText?.length || 0,
      extractionError: file.extractionError,
    });
  });
  console.log('[fileContext] combinedText length:', combinedText.length);

  return {
    files: extractedFiles,
    combinedText,
    hasUploadedFiles: files.length > 0,
  };
};

module.exports = {
  buildFileContext,
  shutdownOcrWorker,
};
