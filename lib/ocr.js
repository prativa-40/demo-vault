// lib/ocr.js — Cross-platform OCR supporting Images and PDFs (Windows, macOS, Linux)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let tesseractWorker = null;

async function getTesseractWorker() {
  if (!tesseractWorker) {
    const { createWorker } = require('tesseract.js');
    tesseractWorker = await createWorker('eng');
  }
  return tesseractWorker;
}

/**
 * Extract text from a file (PDF or Image)
 */
async function extractText(filePath, mimeType = '') {
  const ext = path.extname(filePath).toLowerCase();
  const isPdf = ext === '.pdf' || mimeType === 'application/pdf';

  // 1. If PDF, use pdf-parse (extracts text cleanly from PDFs)
  if (isPdf) {
    try {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      if (pdfData && pdfData.text) {
        return pdfData.text.trim();
      }
    } catch (pdfErr) {
      console.warn('pdf-parse failed:', pdfErr.message);
    }
    // NEVER pass a .pdf file to Tesseract.js (Tesseract does NOT support PDF input)
    return '';
  }

  // 2. If macOS and Swift script is available, try Swift OCR as first choice on Mac
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/swift')) {
    try {
      const swiftCacheDir = path.join(os.tmpdir(), 'household-vault-swift-cache');
      fs.mkdirSync(swiftCacheDir, { recursive: true });
      const swiftScript = path.join(__dirname, '..', 'scripts', 'ocr.swift');
      if (fs.existsSync(swiftScript)) {
        const text = execFileSync('/usr/bin/swift', [swiftScript, filePath], {
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, CLANG_MODULE_CACHE_PATH: swiftCacheDir }
        }).trim();
        if (text) return text;
      }
    } catch (swiftErr) {
      console.warn('macOS Swift OCR failed, falling back to Tesseract:', swiftErr.message);
    }
  }

  // 3. For image files (JPG, PNG, WebP, etc.), use Tesseract.js
  const imageExts = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tiff', '.tif'];
  if (imageExts.includes(ext) || (mimeType && mimeType.startsWith('image/'))) {
    try {
      const worker = await getTesseractWorker();
      const ret = await worker.recognize(filePath);
      return ret && ret.data && ret.data.text ? ret.data.text.trim() : '';
    } catch (tessErr) {
      console.error('Tesseract OCR error:', tessErr.message);
      return '';
    }
  }

  return '';
}

/**
 * Wrapper method
 */
async function runOcrAsync(filePath, mimeType = '') {
  try {
    return await extractText(filePath, mimeType);
  } catch (err) {
    console.error('runOcrAsync error:', err.message);
    return '';
  }
}

module.exports = {
  extractText,
  runOcrAsync,
  getTesseractWorker
};
