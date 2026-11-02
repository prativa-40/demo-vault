// document-preview.js — Document Preview & OCR Content Display UI
(function() {
  'use strict';

  const docTypeIcons = {
    'Aadhaar': '🪪', 'Passport': '📕', 'Voter ID': '🗳️', 'PAN Card': '💳',
    'Driving Licence': '🚗', 'Birth Certificate': '👶', 'Marriage Certificate': '💍',
    'Class 10': '🎓', 'Class 12': '🎓', 'Graduation': '🎓', 'Post Graduation': '🎓', 'PhD': '🎓',
    'Sports': '🏆', 'Extracurricular': '⭐', 'Other': '📄',
  };

  function getDocIcon(type) { return docTypeIcons[type] || '📄'; }

  function getIconClass(type) {
    const t = (type || '').toLowerCase();
    if (t.includes('aadhaar') || t.includes('aadhar')) return 'aadhaar';
    if (t.includes('passport')) return 'passport';
    if (t.includes('pan')) return 'pan';
    if (t.includes('driving') || t.includes('licence')) return 'driving';
    if (t.includes('birth')) return 'birth';
    if (t.includes('voter')) return 'voter';
    if (t.includes('class') || t.includes('graduation') || t.includes('phd')) return 'education';
    return 'default';
  }

  function confidenceLevel(score) {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return String(text || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function createPreviewOverlay() {
    let overlay = document.getElementById('docPreviewOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'docPreviewOverlay';
    overlay.className = 'doc-preview-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDocPreview(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  // ── Open document preview panel ──
  window.openDocPreview = async function(options = {}) {
    const overlay = createPreviewOverlay();

    // If passed a document ID string or file URL
    if (typeof options === 'string') {
      if (options.startsWith('/api/files/') || options.startsWith('http')) {
        const isPdfFile = options.toLowerCase().includes('.pdf');
        options = {
          fileUrl: options,
          fileName: options.split('/').pop().split('?')[0] || 'document.pdf',
          documentType: isPdfFile ? 'PDF Document' : 'Document Scan',
          isPdf: isPdfFile,
          isImage: !isPdfFile,
          confidence: 0.95,
          fields: [{ label: 'Format', value: isPdfFile ? 'PDF Document' : 'Image Scan', icon: '📄' }]
        };
      } else {
        overlay.innerHTML = `
        <div class="doc-preview-panel" style="max-width:500px;min-height:200px;align-items:center;justify-content:center;display:flex;flex-direction:column;gap:16px;">
          <div class="progress-spinner"></div>
          <p style="color:#666;font-size:14px;">Loading document preview...</p>
        </div>`;
      requestAnimationFrame(() => overlay.classList.add('visible'));

      try {
        const res = await fetch('/api/document-preview?id=' + encodeURIComponent(options));
        if (!res.ok) throw new Error('Could not load document preview');
        const data = await res.json();
        const doc = data.document || {};
        options = {
          fileUrl: doc.fileUrl,
          fileName: doc.fileName,
          documentType: doc.type,
          ocrText: doc.ocrText || data.rawText || '',
          fields: data.fields || [],
          confidence: doc.ocrText ? 0.95 : 0.5,
          isImage: !doc.isPdf,
          isPdf: !!doc.isPdf,
          enhancementInfo: doc.enhancementInfo,
          memberId: doc.memberId,
          documentId: doc.id
        };
      } catch (err) {
        overlay.innerHTML = `
          <div class="doc-preview-panel" style="max-width:400px;padding:30px;text-align:center;">
            <h3>Document Preview</h3>
            <p style="color:#d32f2f;margin:16px 0;">${escapeHtml(err.message)}</p>
            <button class="btn-download" onclick="closeDocPreview()">Close</button>
          </div>`;
        return;
      }
      }
    }

    const {
      fileUrl, fileName, documentType, ocrText, fields = [], confidence = 0,
      isImage = false, isPdf = false, enhancementInfo = null,
      onSave = null, memberId = '', documentId = ''
    } = options;

    const icon = getDocIcon(documentType);
    const level = confidenceLevel(confidence || (ocrText ? 0.9 : 0.4));
    const ext = (fileName || fileUrl || '').split('?')[0].split('.').pop().toLowerCase();
    const previewIsPdf = isPdf || ext === 'pdf';
    const previewIsImage = isImage || ['jpg', 'jpeg', 'png', 'bmp', 'webp'].includes(ext);

    overlay.innerHTML = `
      <div class="doc-preview-panel">
        <div class="doc-preview-left">
          <div class="preview-header">
            <h3>📄 Document View</h3>
            ${previewIsPdf ? '<span class="preview-badge pdf">PDF</span>' : ''}
            ${previewIsImage ? '<span class="preview-badge image">IMAGE</span>' : ''}
            ${enhancementInfo ? '<span class="preview-badge enhanced">✨ ENHANCED</span>' : ''}
          </div>
          <div class="doc-preview-image-container">
            ${previewIsPdf
              ? `<iframe src="${fileUrl}" title="Document preview"></iframe>`
              : (fileUrl ? `<img src="${fileUrl}" alt="Document scan" onerror="this.parentElement.innerHTML='<p style=\\'padding:40px;color:#999\\'>Preview not available</p>'">` : '<p style="padding:40px;color:#999">No scan attached</p>')
            }
          </div>
        </div>

        <div class="doc-preview-right">
          <div class="content-header">
            <h3>📝 Extracted Content</h3>
            <button class="doc-preview-close" onclick="closeDocPreview()" title="Close">✕</button>
          </div>

          <div class="doc-preview-content">
            <div class="doc-type-badge">
              <span class="type-icon">${icon}</span>
              ${escapeHtml(documentType || 'Document')}
            </div>

            <div class="confidence-bar">
              <div class="confidence-label">Extraction Accuracy</div>
              <div class="confidence-track">
                <div class="confidence-fill ${level}" style="width:${Math.round((confidence || (ocrText ? 0.95 : 0.5)) * 100)}%"></div>
              </div>
              <div class="confidence-value ${level}">${Math.round((confidence || (ocrText ? 0.95 : 0.5)) * 100)}% — ${
                level === 'high' ? 'High accuracy' : level === 'medium' ? 'Review recommended' : 'Verify details'
              }</div>
            </div>

            ${enhancementInfo ? `
            <div class="upload-enhancement">
              <span class="enhance-icon">✨</span>
              <div class="enhance-info">
                <strong>Image Enhanced & Converted to PDF</strong>
                <small>Sharpening & auto-contrast applied for clear text readability</small>
              </div>
            </div>` : ''}

            <div class="extracted-fields" style="margin-top:16px">
              ${fields.length > 0 ? fields.map(f => `
                <div class="extracted-field">
                  <div class="field-label">
                    <span class="field-icon">${f.icon || '📋'}</span> ${escapeHtml(f.label)}
                  </div>
                  ${f.editable
                    ? `<input class="field-value editable" data-field="${f.key || f.label}" value="${escapeAttr(f.value || '')}" />`
                    : `<div class="field-value">${escapeHtml(f.value || 'Not detected')}</div>`
                  }
                </div>
              `).join('') : `
                <div class="extracted-field">
                  <div class="field-label"><span class="field-icon">ℹ️</span> STATUS</div>
                  <div class="field-value">Details saved in vault. See OCR text below.</div>
                </div>
              `}
            </div>

            ${ocrText ? `
            <div class="ocr-raw-section">
              <button class="ocr-raw-toggle" onclick="toggleOcrRawText()">
                <span>📜</span> View raw extracted OCR text <span style="margin-left:auto">▼</span>
              </button>
              <pre class="ocr-raw-text" id="ocrRawText">${escapeHtml(ocrText)}</pre>
            </div>` : ''}
          </div>

          <div class="doc-preview-actions">
            ${fileUrl ? `<a href="${fileUrl}" target="_blank" class="btn-primary" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;background:#4338ca;color:#fff;padding:8px 16px;border-radius:8px;font-weight:600;font-size:13px;">↗ Open Full PDF</a>` : ''}
            ${fileUrl ? `<a href="${fileUrl}" download target="_blank" class="btn-download" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">⬇️ Download Scan</a>` : ''}
            ${onSave ? `<button class="btn-save" onclick="saveDocPreviewEdits('${memberId}','${documentId}')">💾 Save Changes</button>` : ''}
            <button class="btn-download" onclick="closeDocPreview()">Close</button>
          </div>
        </div>
      </div>
    `;

    requestAnimationFrame(() => overlay.classList.add('visible'));
    document.addEventListener('keydown', handlePreviewEscape);
  };

  window.closeDocPreview = function() {
    const overlay = document.getElementById('docPreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.innerHTML = ''; }, 300);
    }
    document.removeEventListener('keydown', handlePreviewEscape);
  };

  function handlePreviewEscape(e) { if (e.key === 'Escape') closeDocPreview(); }

  window.toggleOcrRawText = function() {
    const text = document.getElementById('ocrRawText');
    if (text) text.classList.toggle('visible');
  };

  window.saveDocPreviewEdits = async function(memberId, documentId) {
    const fields = document.querySelectorAll('.extracted-field .field-value.editable');
    const updates = {};
    fields.forEach(f => { if (f.dataset.field) updates[f.dataset.field] = f.value; });

    if (memberId && documentId) {
      try {
        const r = await fetch(`/api/members/${memberId}/documents/${documentId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
        });
        if (r.ok) { closeDocPreview(); if (typeof load === 'function') load(); }
        else alert('Could not save changes.');
      } catch { alert('Could not save changes.'); }
    }
  };

  window.renderSearchResults = function(results, container) {
    if (!container) return;
    if (!results || results.length === 0) {
      container.innerHTML = '<p style="padding:20px;color:#999;text-align:center">No documents found matching keywords.</p>';
      return;
    }
    container.innerHTML = results.map(doc => {
      const icon = getDocIcon(doc.type);
      const iconClass = getIconClass(doc.type);
      return `
        <div class="search-result-card" onclick="openDocPreview('${doc.id}')">
          <div class="search-result-icon ${iconClass}">${icon}</div>
          <div class="search-result-info">
            <h4>${escapeHtml(doc.type || 'Document')}${doc.documentName ? ' — ' + escapeHtml(doc.documentName) : ''}</h4>
            <p>${[doc.memberName || doc.owner, doc.number, doc.documentDate].filter(Boolean).join(' · ')}</p>
          </div>
          <div class="search-result-actions">
            <button class="preview-btn" onclick="event.stopPropagation(); openDocPreview('${doc.id}')">👁️ View</button>
            ${doc.fileUrl ? `<a href="${doc.fileUrl}" target="_blank" onclick="event.stopPropagation()">Download</a>` : ''}
          </div>
        </div>`;
    }).join('');
  };

  window.showUploadProgress = function(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'upload-progress'; el.id = 'uploadProgress';
    el.innerHTML = `<div class="progress-spinner"></div><span class="progress-text">${escapeHtml(message || 'Processing scan & enhancing...')}</span>`;
    container.appendChild(el); return el;
  };

  window.hideUploadProgress = function() {
    const el = document.getElementById('uploadProgress');
    if (el) el.remove();
  };

  window.showEnhancementResult = function(container, info) {
    if (!container || !info) return;
    const el = document.createElement('div');
    el.className = 'upload-enhancement';
    el.innerHTML = `<span class="enhance-icon">✨</span><div class="enhance-info">
      <strong>Image enhanced & converted to PDF</strong>
      <small>Sharpened and contrast-adjusted${info.originalSize ? ' · ' + formatBytes(info.originalSize) + ' → ' + formatBytes(info.enhancedSize) : ''}</small>
    </div>`;
    container.appendChild(el);
  };
})();
