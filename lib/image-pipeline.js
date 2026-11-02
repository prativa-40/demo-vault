// lib/image-pipeline.js — Image Enhancement + PDF Conversion Pipeline
const fs = require('fs');
const path = require('path');

let sharp, PDFDocument;

function loadSharp() {
  if (!sharp) {
    try { sharp = require('sharp'); }
    catch { sharp = null; console.warn('⚠️  sharp not available — image enhancement disabled'); }
  }
  return sharp;
}

function loadPDFKit() {
  if (!PDFDocument) {
    try { PDFDocument = require('pdfkit'); }
    catch { PDFDocument = null; console.warn('⚠️  pdfkit not available — PDF conversion disabled'); }
  }
  return PDFDocument;
}

/**
 * Enhance an image buffer for clarity:
 * - Auto-level contrast (normalize)
 * - Sharpen for text readability
 * - Output as high-quality PNG
 */
async function enhanceImage(inputBuffer, options = {}) {
  const sharpLib = loadSharp();
  if (!sharpLib) return { enhanced: inputBuffer, format: 'original' };

  try {
    let pipeline = sharpLib(inputBuffer);
    const metadata = await pipeline.metadata();

    pipeline = sharpLib(inputBuffer);
    pipeline = pipeline.normalize();
    pipeline = pipeline.sharpen({ sigma: 1.5, m1: 1.0, m2: 2.0 });

    if (options.grayscale) {
      pipeline = pipeline.grayscale();
    }

    const maxDim = options.maxDimension || 4000;
    if (metadata.width > maxDim || metadata.height > maxDim) {
      pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
    }

    const enhancedBuffer = await pipeline.png({ quality: 95, compressionLevel: 6 }).toBuffer();
    return {
      enhanced: enhancedBuffer, format: 'png',
      width: metadata.width, height: metadata.height,
      originalSize: inputBuffer.length, enhancedSize: enhancedBuffer.length,
    };
  } catch (error) {
    console.error('Image enhancement failed:', error.message);
    return { enhanced: inputBuffer, format: 'original', error: error.message };
  }
}

/**
 * Convert an image buffer to a PDF document.
 * Returns a Buffer containing the PDF.
 */
async function imageToPdf(imageBuffer, options = {}) {
  const PDFDoc = loadPDFKit();
  if (!PDFDoc) return null;

  const sharpLib = loadSharp();
  let width = options.width || 595;
  let height = options.height || 842;

  if (sharpLib) {
    try {
      const metadata = await sharpLib(imageBuffer).metadata();
      if (metadata.width && metadata.height) {
        const scale = Math.min(595 / metadata.width, 842 / metadata.height, 1);
        width = Math.round(metadata.width * scale);
        height = Math.round(metadata.height * scale);
      }
    } catch { /* use defaults */ }
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({
        size: [width + 40, height + 40],
        margins: { top: 20, bottom: 20, left: 20, right: 20 },
        info: {
          Title: options.title || 'Scanned Document',
          Author: 'Hearth Household Vault',
          Creator: 'Hearth Image Pipeline',
          CreationDate: new Date(),
        },
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.image(imageBuffer, 20, 20, {
        width, height,
        fit: [width, height],
        align: 'center', valign: 'center',
      });

      doc.fontSize(7).fillColor('#999999').text(
        `Digitized by Hearth Vault · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
        20, height + 25, { width, align: 'center' }
      );

      doc.end();
    } catch (error) { reject(error); }
  });
}

/**
 * Full processing pipeline:
 * 1. Detect if input is image or PDF
 * 2. If image: enhance → convert to PDF
 * 3. Return both the enhanced image and the PDF
 */
async function processUpload(fileBuffer, fileName, mimeType) {
  const ext = path.extname(fileName || '').toLowerCase();
  const isImage = ['.jpg','.jpeg','.png','.bmp','.tiff','.tif','.webp'].includes(ext) ||
                  (mimeType && mimeType.startsWith('image/'));
  const isPdf = ext === '.pdf' || mimeType === 'application/pdf';

  const result = {
    originalBuffer: fileBuffer, originalName: fileName,
    isImage, isPdf,
    enhancedBuffer: null, pdfBuffer: null, pdfFileName: null, enhancementInfo: null,
  };

  if (isImage) {
    const enhancement = await enhanceImage(fileBuffer, { grayscale: false });
    result.enhancedBuffer = enhancement.enhanced;
    result.enhancementInfo = {
      originalSize: enhancement.originalSize, enhancedSize: enhancement.enhancedSize,
      width: enhancement.width, height: enhancement.height, format: enhancement.format,
    };

    const baseName = path.basename(fileName || 'scan', ext);
    result.pdfFileName = `${baseName}.pdf`;

    try {
      const pdfBuffer = await imageToPdf(enhancement.enhanced, {
        title: baseName, width: enhancement.width, height: enhancement.height,
      });
      if (pdfBuffer) result.pdfBuffer = pdfBuffer;
    } catch (error) {
      console.error('PDF conversion failed:', error.message);
    }
  } else if (isPdf) {
    result.pdfBuffer = fileBuffer;
    result.pdfFileName = fileName;
  }

  return result;
}

/**
 * Generate a content preview of OCR text in structured format.
 */
function generateContentPreview(ocrText, documentType, metadata = {}) {
  const preview = {
    documentType: documentType || 'Unknown',
    fields: [],
    rawText: ocrText || '',
    summary: '',
  };

  if (metadata.documentName) preview.fields.push({ label: 'Name / Child Name', value: metadata.documentName, icon: '👤', key: 'documentName' });
  if (metadata.number) preview.fields.push({ label: 'Document / Reg Number', value: metadata.number, icon: '🔢', key: 'number' });
  if (metadata.documentDate) preview.fields.push({ label: 'Date of Birth / Date', value: metadata.documentDate, icon: '📅', key: 'documentDate' });
  if (metadata.birthYear) preview.fields.push({ label: 'Birth Year', value: metadata.birthYear, icon: '📅', key: 'birthYear' });
  if (metadata.fatherName) preview.fields.push({ label: "Father's Name", value: metadata.fatherName, icon: '👨', key: 'fatherName' });
  if (metadata.motherName) preview.fields.push({ label: "Mother's Name", value: metadata.motherName, icon: '👩', key: 'motherName' });
  if (metadata.placeOfBirth) preview.fields.push({ label: 'Place of Birth', value: metadata.placeOfBirth, icon: '🏥', key: 'placeOfBirth' });
  if (metadata.expiry) preview.fields.push({ label: 'Expiry Date', value: metadata.expiry, icon: '⏰', key: 'expiry' });
  if (metadata.address) preview.fields.push({ label: 'Address / Place', value: metadata.address, icon: '📍', key: 'address' });
  if (metadata.issuer) preview.fields.push({ label: 'Issuing Authority', value: metadata.issuer, icon: '🏛️', key: 'issuer' });

  const fieldSummary = preview.fields.map(f => `${f.label}: ${f.value}`).join(' · ');
  preview.summary = fieldSummary || 'No structured data could be extracted.';

  return preview;
}

module.exports = { enhanceImage, imageToPdf, processUpload, generateContentPreview };
