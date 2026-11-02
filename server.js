const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const { createSecureStore } = require('./lib/secure-store');
const localAi = require('./lib/local-ai');
const db = require('./lib/database');
const { processUpload, generateContentPreview } = require('./lib/image-pipeline');
const keywordSearch = require('./lib/keyword-search');
const ocr = require('./lib/ocr');

// Prevent unexpected process exits
process.on('uncaughtException', err => {
  console.error('⚠️  Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Rejection at:', promise, 'reason:', reason);
});

const root = __dirname;
const dataDir = path.join(root, 'data');
const dataFile = path.join(dataDir, 'household.json');
const encryptedDataFile = path.join(dataDir, 'household.enc');
const uploadsDir = path.join(dataDir, 'documents');
const secureStore = createSecureStore({ dataDir, legacyDataFile: dataFile, encryptedDataFile, documentsDir: uploadsDir });

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.json': 'application/json'
};

const send = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
};

// ── Enhanced local-ai: add askWithContext method for keyword search ──
if (!localAi.askWithContext) {
  localAi.askWithContext = async function(question, context) {
    if (!localAi.configured()) throw new Error('Local AI not configured.');
    const url = (process.env.LOCAL_LLM_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = process.env.LOCAL_LLM_MODEL || '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          prompt: `You are Hearth, an ultra-fast private household vault AI assistant. Answer in 1 to 2 direct sentences from the records below. State key details (name, document type, number, dates).\n\nHOUSEHOLD RECORDS:\n${context}\n\nQUESTION: ${question}\nANSWER:`,
          options: { temperature: 0.1, num_predict: 50, num_thread: 8 }
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Local AI returned ${response.status}`);
      const data = await response.json();
      return { answer: data.response?.trim() || 'No answer produced.' };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Start Server ──
async function startServer() {
  try {
    await db.initializeSchema();
    console.log('✅ PostgreSQL connected and schema ready');
  } catch (error) {
    console.warn('⚠️  PostgreSQL not available, falling back to encrypted file storage:', error.message);
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Handle CORS preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        });
        return res.end();
      }

      const url = new URL(req.url, 'http://localhost');

      // ── DATA API (PostgreSQL with secureStore fallback) ──
      if (url.pathname === '/api/data' && req.method === 'GET') {
        try {
          const data = await db.readDbCompat();
          return send(res, 200, data);
        } catch {
          return send(res, 200, secureStore.readDb());
        }
      }

      // ── SEARCH API (PostgreSQL Full-Text Search) ──
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        if (!q.trim()) return send(res, 400, { error: 'Query parameter q is required' });
        try {
          const results = await keywordSearch.searchWithKeywords(q);
          return send(res, 200, results);
        } catch (error) {
          return send(res, 500, { error: error.message });
        }
      }

      // ── AI ASK (Enhanced with PostgreSQL keyword search) ──
      if (url.pathname === '/api/ai/ask' && req.method === 'POST') {
        return body(req, res, async payload => {
          const question = String(payload.question || '').trim();
          if (!question) return send(res, 400, { error: 'question is required' });
          try {
            const answer = await keywordSearch.enhancedAsk(question, localAi);
            return send(res, 200, answer);
          } catch (error) {
            return send(res, 503, { error: error.message || 'Search unavailable' });
          }
        });
      }

      if (url.pathname === '/api/ai/status' && req.method === 'GET') {
        return send(res, 200, {
          configured: localAi.configured(),
          provider: 'local Ollama-compatible server',
          url: localAi.localUrl(),
          chatModel: localAi.chatModel() || null,
          embeddingModel: localAi.embeddingModel() || null,
          postgresqlConnected: await isDbConnected(),
          searchEnabled: true,
        });
      }

      if (url.pathname === '/api/ai/reindex' && req.method === 'POST') {
        return body(req, res, async () => {
          let dbData;
          try { dbData = await db.readDbCompat(); } catch { dbData = secureStore.readDb(); }
          dbData.ragIndex = await localAi.buildIndex(dbData);
          send(res, 200, { indexedChunks: dbData.ragIndex.chunks.length, indexedAt: dbData.ragIndex.createdAt });
        });
      }

      // ── DOCUMENT PREVIEW (returns OCR content in structured format) ──
      if (url.pathname === '/api/document-preview' && req.method === 'GET') {
        const docId = url.searchParams.get('id');
        if (!docId) return send(res, 400, { error: 'Document id is required' });
        try {
          let doc = null;
          try {
            doc = await db.getDocumentById(docId);
          } catch (e) {
            console.warn('DB getDocumentById notice:', e.message);
          }
          if (!doc) {
            const dbData = secureStore.readDb();
            for (const m of (dbData.members || [])) {
              doc = (m.documents || []).find(d => d.id === docId);
              if (doc) break;
            }
          }
          if (!doc) return send(res, 404, { error: 'Document not found' });
          const preview = generateContentPreview(doc.ocrText, doc.type, {
            documentName: doc.documentName,
            number: doc.number,
            documentDate: doc.documentDate,
            birthYear: doc.birthYear,
            expiry: doc.expiry,
            address: doc.address,
            issuer: doc.issuer,
            ...(doc.metadata || {})
          });
          return send(res, 200, { ...preview, document: doc });
        } catch (error) {
          return send(res, 500, { error: error.message });
        }
      }

      // ── MEMBERS ──
      if (url.pathname === '/api/members' && req.method === 'POST') {
        return body(req, res, async d => {
          try {
            const member = await db.createMember(d);
            send(res, 201, member);
          } catch {
            const dbData = secureStore.readDb();
            const member = { id: crypto.randomUUID(), documents: [], finance: [], ...d };
            dbData.members.push(member);
            secureStore.writeDb(dbData);
            send(res, 201, member);
          }
        });
      }

      const memberRoute = url.pathname.match(/^\/api\/members\/([^/]+)$/);
      if (memberRoute && req.method === 'PUT') {
        return body(req, res, async d => {
          try {
            const member = await db.updateMember(memberRoute[1], d);
            if (!member) return send(res, 404, { error: 'Not found' });
            send(res, 200, member);
          } catch {
            const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === memberRoute[1]);
            if (!member) return send(res, 404, { error: 'Not found' });
            Object.assign(member, d, { id: member.id, documents: member.documents, finance: member.finance || [] });
            secureStore.writeDb(dbData);
            send(res, 200, member);
          }
        });
      }
      if (memberRoute && req.method === 'DELETE') {
        try {
          await db.deleteMember(memberRoute[1]);
        } catch {
          const dbData = secureStore.readDb(), i = dbData.members.findIndex(x => x.id === memberRoute[1]);
          if (i < 0) return send(res, 404, { error: 'Not found' });
          dbData.members.splice(i, 1);
          secureStore.writeDb(dbData);
        }
        return send(res, 204, {});
      }

      // ── DOCUMENT UPLOAD (with image enhancement + PDF conversion) ──
      const m = url.pathname.match(/^\/api\/members\/([^/]+)\/documents$/);
      if (m && req.method === 'POST') {
        return body(req, res, async d => {
          try {
            const uploadResult = await storeUploadEnhanced(d);
            const doc = {
              id: crypto.randomUUID(),
              status: 'Review needed',
              uploadedAt: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
              ...uploadResult
            };

            let saved;
            try {
              saved = await db.createDocument({ ...doc, memberId: m[1] });
            } catch (err) {
              console.warn('DB createDocument fallback to secureStore:', err.message);
              const dbData = secureStore.readDb();
              const member = dbData.members.find(x => x.id === m[1]);
              if (!member) return send(res, 404, { error: 'Family member not found' });
              member.documents ||= [];
              member.documents.push(doc);
              secureStore.writeDb(dbData);
              saved = doc;
            }

            return send(res, 201, {
              ...saved,
              contentPreview: uploadResult.contentPreview,
              enhancementInfo: uploadResult.enhancementInfo,
              fileUrl: uploadResult.fileUrl || saved.fileUrl,
              ocrText: uploadResult.ocrText || saved.ocrText,
              type: uploadResult.type || saved.type,
              documentName: uploadResult.documentName || saved.documentName,
              number: uploadResult.number || saved.number,
              documentDate: uploadResult.documentDate || saved.documentDate,
            });
          } catch (uploadError) {
            console.error('Document upload error:', uploadError);
            return send(res, 500, { error: uploadError.message || 'Upload failed' });
          }
        });
      }

      const docRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/documents\/([^/]+)$/);
      if (docRoute && req.method === 'PUT') {
        return body(req, res, async d => {
          const uploadResult = await storeUploadEnhanced(d);
          try {
            const updated = await db.updateDocument(docRoute[2], { ...uploadResult, id: docRoute[2] });
            send(res, 200, updated);
          } catch {
            const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === docRoute[1]),
                  doc = member?.documents.find(x => x.id === docRoute[2]);
            if (!doc) return send(res, 404, { error: 'Not found' });
            Object.assign(doc, uploadResult, { id: doc.id, uploadedAt: doc.uploadedAt });
            secureStore.writeDb(dbData);
            send(res, 200, doc);
          }
        });
      }

      if (docRoute && req.method === 'POST' && url.searchParams.get('action') === 'ocr') {
        try {
          let doc = null;
          try { doc = await db.getDocumentById(docRoute[2]); } catch {}
          if (!doc) {
            const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === docRoute[1]);
            doc = member?.documents.find(x => x.id === docRoute[2]);
          }
          const storageKey = doc?.storageKey || documentStorageKey(doc);
          if (!storageKey || !secureStore.hasDocument(storageKey)) return send(res, 404, { error: 'A stored scan is required' });
          const temporary = path.join(os.tmpdir(), `hearth-reread-${crypto.randomUUID()}${path.extname(doc.fileName || storageKey)}`);
          let ocrText = '';
          try {
            fs.writeFileSync(temporary, secureStore.readDocument(storageKey));
            ocrText = await ocr.extractText(temporary);
          } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
          }
          const extracted = Object.fromEntries(Object.entries(parseMetadata(ocrText, normaliseDocumentType(doc.type))).filter(([, v]) => v));
          const updates = { ...extracted, ocrText, ocrStatus: ocrText ? 'Read locally — review details' : 'Could not read this scan' };
          let updated;
          try {
            updated = await db.updateDocument(docRoute[2], updates);
          } catch {
            const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === docRoute[1]),
                  d = member?.documents.find(x => x.id === docRoute[2]);
            Object.assign(d, updates);
            secureStore.writeDb(dbData);
            updated = d;
          }
          return send(res, 200, updated);
        } catch (err) {
          return send(res, 500, { error: err.message });
        }
      }

      if (docRoute && req.method === 'DELETE') {
        try {
          await db.deleteDocument(docRoute[2]);
        } catch {
          const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === docRoute[1]);
          if (!member) return send(res, 404, { error: 'Not found' });
          const i = member.documents.findIndex(x => x.id === docRoute[2]);
          if (i < 0) return send(res, 404, { error: 'Not found' });
          member.documents.splice(i, 1);
          secureStore.writeDb(dbData);
        }
        return send(res, 204, {});
      }

      // ── FINANCE ──
      const financeRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/finance$/);
      if (financeRoute && req.method === 'POST') {
        return body(req, res, async d => {
          try { const record = await db.createFinanceRecord(financeRoute[1], d); send(res, 201, record); }
          catch { const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === financeRoute[1]); if (!member) return send(res, 404, { error: 'Not found' }); member.finance ||= []; const record = { id: crypto.randomUUID(), ...d }; member.finance.push(record); secureStore.writeDb(dbData); send(res, 201, record); }
        });
      }
      const financeRecordRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/finance\/([^/]+)$/);
      if (financeRecordRoute && req.method === 'PUT') {
        return body(req, res, async d => {
          try { const record = await db.updateFinanceRecord(financeRecordRoute[2], d); send(res, 200, record); }
          catch { const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === financeRecordRoute[1]), record = member?.finance?.find(x => x.id === financeRecordRoute[2]); if (!record) return send(res, 404, { error: 'Not found' }); Object.assign(record, d, { id: record.id }); secureStore.writeDb(dbData); send(res, 200, record); }
        });
      }
      if (financeRecordRoute && req.method === 'DELETE') {
        try { await db.deleteFinanceRecord(financeRecordRoute[2]); }
        catch { const dbData = secureStore.readDb(), member = dbData.members.find(x => x.id === financeRecordRoute[1]); if (!member) return send(res, 404, { error: 'Not found' }); const i = (member.finance || []).findIndex(x => x.id === financeRecordRoute[2]); if (i < 0) return send(res, 404, { error: 'Not found' }); member.finance.splice(i, 1); secureStore.writeDb(dbData); }
        return send(res, 204, {});
      }

      // ── PROPERTIES ──
      if (url.pathname === '/api/properties' && req.method === 'POST') {
        return body(req, res, async d => {
          try { const prop = await db.createProperty(d); send(res, 201, prop); }
          catch { const dbData = secureStore.readDb(); const prop = { id: crypto.randomUUID(), documents: [], appliances: [], services: [], ...d }; dbData.properties.push(prop); secureStore.writeDb(dbData); send(res, 201, prop); }
        });
      }
      const propertyRoute = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
      if (propertyRoute && req.method === 'PUT') {
        return body(req, res, async d => {
          try { const prop = await db.updateProperty(propertyRoute[1], d); send(res, 200, prop); }
          catch { const dbData = secureStore.readDb(), prop = dbData.properties.find(x => x.id === propertyRoute[1]); if (!prop) return send(res, 404, { error: 'Not found' }); Object.assign(prop, d, { id: prop.id }); secureStore.writeDb(dbData); send(res, 200, prop); }
        });
      }
      if (propertyRoute && req.method === 'DELETE') {
        try { await db.deleteProperty(propertyRoute[1]); }
        catch { const dbData = secureStore.readDb(), i = dbData.properties.findIndex(x => x.id === propertyRoute[1]); if (i < 0) return send(res, 404, { error: 'Not found' }); dbData.properties.splice(i, 1); secureStore.writeDb(dbData); }
        return send(res, 204, {});
      }

      const propertyDocuments = url.pathname.match(/^\/api\/properties\/([^/]+)\/documents$/);
      if (propertyDocuments && req.method === 'POST') {
        return body(req, res, async d => {
          const uploadResult = await storeUploadEnhanced(d);
          const doc = { id: crypto.randomUUID(), uploadedAt: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), ...uploadResult };
          try { const saved = await db.createDocument({ ...doc, propertyId: propertyDocuments[1] }); send(res, 201, saved); }
          catch { const dbData = secureStore.readDb(), prop = dbData.properties.find(x => x.id === propertyDocuments[1]); if (!prop) return send(res, 404, { error: 'Not found' }); prop.documents ||= []; prop.documents.push(doc); secureStore.writeDb(dbData); send(res, 201, doc); }
        });
      }

      const propertyAppliances = url.pathname.match(/^\/api\/properties\/([^/]+)\/appliances$/);
      if (propertyAppliances && req.method === 'POST') {
        return body(req, res, async d => {
          try { const a = await db.createAppliance(propertyAppliances[1], d); send(res, 201, a); }
          catch { const dbData = secureStore.readDb(), prop = dbData.properties.find(x => x.id === propertyAppliances[1]); if (!prop) return send(res, 404, { error: 'Not found' }); prop.appliances ||= []; const a = { id: crypto.randomUUID(), ...d }; prop.appliances.push(a); secureStore.writeDb(dbData); send(res, 201, a); }
        });
      }

      const propertyServices = url.pathname.match(/^\/api\/properties\/([^/]+)\/services$/);
      if (propertyServices && req.method === 'POST') {
        return body(req, res, async d => {
          const uploadResult = await storeUploadEnhanced(d);
          try { const s = await db.createService(propertyServices[1], uploadResult); send(res, 201, s); }
          catch { const dbData = secureStore.readDb(), prop = dbData.properties.find(x => x.id === propertyServices[1]); if (!prop) return send(res, 404, { error: 'Not found' }); prop.services ||= []; const s = { id: crypto.randomUUID(), ...uploadResult }; prop.services.push(s); secureStore.writeDb(dbData); send(res, 201, s); }
        });
      }

      // ── VEHICLES ──
      if (url.pathname === '/api/vehicles' && req.method === 'POST') {
        return body(req, res, async d => {
          const vehicleData = await storeVehicleAsync(d);
          try { const v = await db.createVehicle(vehicleData); send(res, 201, v); }
          catch { const dbData = secureStore.readDb(); dbData.vehicles ||= []; const v = { id: crypto.randomUUID(), ...vehicleData }; dbData.vehicles.push(v); secureStore.writeDb(dbData); send(res, 201, v); }
        });
      }
      const vehicleRoute = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/);
      if (vehicleRoute && req.method === 'PUT') {
        return body(req, res, async d => {
          const vehicleData = await storeVehicleAsync(d);
          try { const v = await db.updateVehicle(vehicleRoute[1], vehicleData); send(res, 200, v); }
          catch { const dbData = secureStore.readDb(), v = (dbData.vehicles || []).find(x => x.id === vehicleRoute[1]); if (!v) return send(res, 404, { error: 'Not found' }); Object.assign(v, vehicleData, { id: v.id }); secureStore.writeDb(dbData); send(res, 200, v); }
        });
      }
      if (vehicleRoute && req.method === 'DELETE') {
        try { await db.deleteVehicle(vehicleRoute[1]); }
        catch { const dbData = secureStore.readDb(), i = (dbData.vehicles || []).findIndex(x => x.id === vehicleRoute[1]); if (i < 0) return send(res, 404, { error: 'Not found' }); dbData.vehicles.splice(i, 1); secureStore.writeDb(dbData); }
        return send(res, 204, {});
      }

      // ── DOCUMENT INTAKE AGENT ──
      if (url.pathname === '/api/agent/document-intake' && req.method === 'POST') {
        return body(req, res, async payload => {
          try {
            const intakeResult = await inspectDocumentIntake(payload);
            send(res, 200, intakeResult);
          } catch (err) {
            console.error('Intake agent error:', err);
            send(res, 500, { error: err.message || 'Intake analysis failed' });
          }
        });
      }

      // ── FINANCE TEMPLATE & IMPORT ──
      if (url.pathname === '/api/finance/template' && req.method === 'GET') return sendFinanceTemplate(res);
      if (url.pathname === '/api/finance/import' && req.method === 'POST') return body(req, res, payload => { try { const result = importFinanceWorkbook(payload); send(res, 200, result); } catch (error) { send(res, 400, { error: error.message || 'Import failed' }); } });

      // ── CENTRAL DOCUMENT API ──
      if (url.pathname === '/api/v1/documents' && req.method === 'GET') {
        try { const data = await db.readDbCompat(); return send(res, 200, listCentralDocuments(data, url)); }
        catch { return send(res, 200, listCentralDocuments(secureStore.readDb(), url)); }
      }
      if (url.pathname === '/api/v1/documents' && req.method === 'POST') {
        return body(req, res, async payload => {
          try { const data = await db.readDbCompat(); const doc = await uploadCentralDocumentAsync(data, payload); if (doc.error) return send(res, doc.status || 400, { error: doc.error }); send(res, 201, doc); }
          catch { const data = secureStore.readDb(); const doc = await uploadCentralDocumentAsync(data, payload); if (doc.error) return send(res, doc.status || 400, { error: doc.error }); secureStore.writeDb(data); send(res, 201, doc); }
        });
      }

      // ── FILE SERVING ──
      const storedFileRoute = url.pathname.match(/^\/api\/files\/([^/]+)$/);
      if (storedFileRoute && req.method === 'GET') return sendStoredFile(res, decodeURIComponent(storedFileRoute[1]));

      const centralDocumentRoute = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(content))?$/);
      if (centralDocumentRoute && req.method === 'GET') {
        try {
          const data = await db.readDbCompat();
          const doc = findCentralDocument(data, centralDocumentRoute[1]);
          if (!doc) return send(res, 404, { error: 'Document not found' });
          return centralDocumentRoute[2] ? sendCentralContent(res, doc) : send(res, 200, doc);
        } catch {
          const doc = findCentralDocument(secureStore.readDb(), centralDocumentRoute[1]);
          if (!doc) return send(res, 404, { error: 'Document not found' });
          return centralDocumentRoute[2] ? sendCentralContent(res, doc) : send(res, 200, doc);
        }
      }

      // ── RESET ──
      if (url.pathname === '/api/data/reset' && req.method === 'POST') {
        try {
          await db.resetAll();
          secureStore.deleteAllDocuments();
          return send(res, 200, { data: { members: [], properties: [], vehicles: [] }, cleared: { members: 0, properties: 0, vehicles: 0, documents: 0 } });
        } catch {
          const prev = secureStore.readDb();
          const cleared = { members: (prev.members || []).length, properties: (prev.properties || []).length, vehicles: (prev.vehicles || []).length, documents: 0 };
          secureStore.deleteAllDocuments();
          secureStore.writeDb({ members: [], properties: [], vehicles: [] });
          return send(res, 200, { data: { members: [], properties: [], vehicles: [] }, cleared });
        }
      }

      // ── STATIC FILES ──
      const safe = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\.\.\//g, '');
      const file = path.join(root, 'public', safe);
      if (!file.startsWith(path.join(root, 'public'))) return send(res, 403, { error: 'Forbidden' });
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          return res.end('Not found');
        }
        res.writeHead(200, {
          'Content-Type': mime[path.extname(file)] || 'text/plain',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
      });

    } catch (error) {
      console.error('Request error:', error);
      if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
    }
  });

  // Listen on all network interfaces (IPv4 and IPv6)
  const PORT = parseInt(process.env.PORT || '3000', 10);
  server.listen(PORT, () => {
    console.log(`🏠 Hearth Vault v2.0 running at http://localhost:${PORT} and http://127.0.0.1:${PORT}`);
    console.log('   📦 PostgreSQL: keyword search + full-text search enabled');
    console.log('   🖼️  Image pipeline: enhancement + PDF conversion enabled');
    console.log('   🔍 Cross-platform OCR: Tesseract.js + pdf-parse enabled');
  });
}

// ── Check PostgreSQL connection ──
async function isDbConnected() {
  try { await db.pool.query('SELECT 1'); return true; } catch { return false; }
}

// ── Enhanced upload: image enhancement + PDF conversion ──
async function storeUploadEnhanced(data) {
  const { fileData, fileName, ...record } = data;
  if (!fileData) return record;

  const match = fileData.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return record;

  const mimeType = match[1];
  const raw = Buffer.from(match[2], 'base64');
  const ext = path.extname(fileName || '') || ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[mimeType] || '.bin');

  // Run image enhancement + PDF conversion pipeline
  let pipelineResult;
  try {
    pipelineResult = await processUpload(raw, fileName || `scan${ext}`, mimeType);
  } catch (error) {
    console.error('Pipeline error:', error.message);
    pipelineResult = { originalBuffer: raw, isImage: false, isPdf: false, enhancedBuffer: null, pdfBuffer: null };
  }

  // Determine storage buffer and filename
  const isNowPdf = !!pipelineResult.pdfBuffer;
  const storageName = crypto.randomUUID() + (isNowPdf ? '.pdf' : ext);
  const storageBuffer = pipelineResult.pdfBuffer || pipelineResult.enhancedBuffer || raw;

  // Run OCR on the file only if not already extracted by intake
  let ocrText = record.ocrText || (record.agentIntake && record.agentIntake.ocrText) || '';
  if (!ocrText || ocrText.length < 5) {
    const temporary = path.join(os.tmpdir(), `hearth-ocr-${crypto.randomUUID()}${ext}`);
    try {
      fs.writeFileSync(temporary, raw);
      ocrText = await ocr.extractText(temporary, mimeType);
    } catch (ocrErr) {
      console.warn('OCR extraction warning:', ocrErr.message);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  // Store in secure store
  secureStore.writeDocument(storageName, storageBuffer);

  const guessedType = guessDocumentType(ocrText, fileName);
  const documentType = normaliseDocumentType(record.type || guessedType);
  const extracted = parseMetadata(ocrText, documentType);
  const safeRecord = { ...record, type: documentType };
  const missingOnly = Object.fromEntries(Object.entries(extracted).filter(([key, value]) => value && !safeRecord[key]));

  // Generate content preview for the UI
  const previewMetadata = { ...extracted, ...missingOnly, ...(record.metadata || {}) };
  const contentPreview = generateContentPreview(ocrText, documentType, previewMetadata);

  return {
    ...safeRecord,
    ...missingOnly,
    fileName: fileName || storageName,
    storageKey: storageName,
    fileUrl: '/api/files/' + encodeURIComponent(storageName),
    ocrText,
    ocrStatus: ocrText ? 'Read locally — review details' : 'Scan processed — review details',
    contentPreview,
    enhancementInfo: pipelineResult.enhancementInfo || null,
    isPdf: isNowPdf || ext === '.pdf',
    metadata: previewMetadata,
  };
}

async function inspectDocumentIntake(payload) {
  const match = String(payload.fileData || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Choose a PDF or image scan first.');
  const mimeType = match[1];
  const ext = path.extname(payload.fileName || '') || ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[mimeType] || '.bin');
  const temporary = path.join(os.tmpdir(), `hearth-intake-${crypto.randomUUID()}${ext}`);
  let ocrText = '';
  try {
    fs.writeFileSync(temporary, Buffer.from(match[2], 'base64'));
    ocrText = await ocr.extractText(temporary, mimeType);
  } catch (ocrErr) {
    console.warn('Intake OCR warning:', ocrErr.message);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }

  let dbData;
  try { dbData = await db.readDbCompat(); } catch { dbData = secureStore.readDb(); }

  const detectedType = guessDocumentType(ocrText, payload.fileName);
  const metadata = parseMetadata(ocrText, detectedType);
  const matchingMember = findMatchingMember(dbData.members, metadata.documentName);
  const extracted = formatIntakeEvidence(metadata);

  if (localAi.configured() && ocrText) {
    try {
      const intake = await localAi.intakeDocument({ fileName: payload.fileName || 'scan', ocrText, members: dbData.members || [] });
      intake.documentType = normaliseDocumentType(intake.documentType || detectedType);
      const evidence = parseMetadata(ocrText, intake.documentType);
      intake.metadata = { ...(intake.metadata || {}), ...metadata, ...evidence };
      if (!isPersonName(intake.metadata.documentName)) intake.metadata.documentName = metadata.documentName || '';
      const matched = findMatchingMember(dbData.members, intake.metadata.documentName);
      if (matched) {
        intake.memberId = matched.id;
        intake.confidence = Math.max(Number(intake.confidence) || 0, 0.95);
        intake.reviewNote = `${formatIntakeEvidence(intake.metadata)} Matched to ${matched.name}; review before saving.`;
      } else {
        intake.confidence = intake.confidence || (ocrText ? 0.85 : 0.4);
      }
      return { ...intake, ocrStatus: ocrText ? 'Read locally — review details' : 'Scan processed — review details', ocrText };
    } catch (llmErr) {
      console.warn('Local LLM intake error:', llmErr.message);
    }
  }

  return {
    documentType: detectedType,
    memberId: matchingMember ? matchingMember.id : '',
    confidence: matchingMember ? 0.98 : (ocrText ? 0.85 : 0.45),
    metadata,
    missingFields: metadata.documentName ? [] : ['Name on document'],
    reviewNote: matchingMember
      ? `${extracted} Matched to ${matchingMember.name}; review before saving.`
      : `${extracted} Review extracted details and verify the family member.`,
    ocrStatus: ocrText ? 'Read locally — review details' : 'Scan processed — review details',
    ocrText,
  };
}

function normaliseDocumentType(type = '') {
  const str = String(type || '').trim();
  if (/aadh?a+r/i.test(str)) return 'Aadhaar';
  if (/birth/i.test(str)) return 'Birth Certificate';
  if (/marriage/i.test(str)) return 'Marriage Certificate';
  if (/passport/i.test(str)) return 'Passport';
  if (/voter/i.test(str)) return 'Voter ID';
  if (/\bpan\b/i.test(str)) return 'PAN Card';
  if (/licen[sc]e|driving/i.test(str)) return 'Driving Licence';
  return str || 'Other';
}

function isPersonName(value = '') {
  const name = String(value || '').trim(), words = name.split(/\s+/), wordLengths = words.map(w => w.replace(/[^A-Za-z]/g, '').length);
  return /^[A-Za-z][A-Za-z .'-]{1,80}$/.test(name) && words.length >= 2 && wordLengths.every(l => l > 0 && l <= 24) &&
         !/(aadhaar|aadhar|government|authority|identification|india|address|date|birth|male|female|enrolment|municipal|corporation|registrar)/i.test(name);
}

function formatIntakeEvidence(metadata = {}) {
  const fields = [['Name', metadata.documentName], ['DOB', metadata.documentDate || metadata.birthYear], ['Number', metadata.number], ['Address', metadata.address], ['Issuer', metadata.issuer]].filter(([, value]) => value);
  return fields.length ? `Read from scan: ${fields.map(([label, value]) => `${label}: ${value}`).join(' · ')}.` : 'Scan loaded — review extracted details below.';
}

function findMatchingMember(members = [], documentName = '') {
  const normalise = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = value => String(value || '').toLowerCase().replace(/\b(dr|mr|mrs|ms)\.?\b/g, '').match(/[a-z0-9]+/g)?.sort().join(' ') || '';
  const wanted = normalise(documentName), wantedTokens = tokens(documentName);
  if (!wanted) return null;
  return members.find(member => normalise(member.name) === wanted) || members.find(member => wantedTokens && tokens(member.name) === wantedTokens) || null;
}

function guessDocumentType(text = '', fileName = '') {
  const content = `${fileName} ${text}`.toLowerCase();
  if (/aadhaar|aadhar|unique identification/i.test(content)) return 'Aadhaar';
  if (/birth certificate|certificate of birth|form\s*(?:no\.?\s*)?5|janm\s*praman|\bbirth\b/i.test(content)) return 'Birth Certificate';
  if (/marriage certificate|certificate of marriage/i.test(content)) return 'Marriage Certificate';
  if (/passport/i.test(content)) return 'Passport';
  if (/voter|election commission/i.test(content)) return 'Voter ID';
  if (/permanent account number|income tax|\bpan\b/i.test(content)) return 'PAN Card';
  if (/driving licence|driving license|\bdl\b|transport department/i.test(content)) return 'Driving Licence';
  if (/class\s*10|secondary school|tenth|ssc|matric/i.test(content)) return 'Class 10';
  if (/class\s*12|senior secondary|twelfth|hsc|intermediate/i.test(content)) return 'Class 12';
  return 'Other';
}

function parseMetadata(text, type) {
  if (!text) return {};
  const dateValue = value => {
    const cleaned = String(value || '').replace(/[०-९]/g, digit => String('०१२३४५६७८९'.indexOf(digit))).replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/Z/g, '2').replace(/B/g, '8');
    const match = cleaned.match(/(\d{1,2})\s*(?:[\/\.\-]|\s)\s*(\d{1,2})\s*(?:[\/\.\-]|\s)\s*((?:19|20)\d{2})/) || cleaned.match(/\b(\d{2})(\d{2})((?:19|20)\d{2})\b/);
    if (!match) return undefined;
    const day = Number(match[1]), month = Number(match[2]);
    return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : undefined;
  };

  const rawLines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const cleaned = rawLines.join(' ');
  const addressStart = rawLines.findIndex(x => /\baddress\b/i.test(x));
  const address = addressStart >= 0 ? rawLines.slice(addressStart, addressStart + 5).join(', ').replace(/^.*?address\s*[:\-]?\s*/i, '') : undefined;

  const findLineVal = (patterns) => {
    for (const line of rawLines) {
      for (const p of patterns) {
        const m = line.match(p);
        if (m && m[1] && m[1].trim()) return m[1].trim();
      }
    }
    return undefined;
  };

  // ── Birth Certificate Parsing ──
  if (type === 'Birth Certificate') {
    const number = findLineVal([
      /(?:registration\s*(?:no|number)|reg(?:ist)?\.?\s*(?:no|number)|cert(?:ificate)?\.?\s*(?:no|number))\s*[:\-\/]?\s*([A-Za-z0-9\/\-]+)/i,
      /\b([A-Z]{1,4}\/\d{4}\/\d+|\d{4}\/\d{4,8})\b/
    ]);
    const documentName = findLineVal([
      /^(?:name\s*(?:of\s*(?:the\s*)?child)?|child(?:'s)?\s*name)\s*[:\-]\s*([A-Za-z][A-Za-z .]{2,})/i,
      /\bname\s*[:\-]\s*([A-Za-z][A-Za-z .]{2,})/i
    ]);
    const dobStr = findLineVal([
      /(?:date\s*of\s*birth|dob|born\s*on)\s*[:\-]?\s*([0-9]{1,2}[\/\-\.][0-9]{1,2}[\/\-\.](?:19|20)?[0-9]{2})/i
    ]);
    const fatherName = findLineVal([
      /(?:father(?:'s)?\s*name|name\s*of\s*father)\s*[:\-]\s*([A-Za-z][A-Za-z .]{2,})/i
    ]);
    const motherName = findLineVal([
      /(?:mother(?:'s)?\s*name|name\s*of\s*mother)\s*[:\-]\s*([A-Za-z][A-Za-z .]{2,})/i
    ]);
    const place = findLineVal([
      /(?:place\s*of\s*birth|born\s*at)\s*[:\-]\s*(.+)/i
    ]);
    const parentAddress = findLineVal([
      /(?:permanent\s*address|address\s*of\s*parents|address)\s*[:\-]\s*(.+)/i
    ]) || place || address;
    const issuer = findLineVal([
      /(municipal\s+corporation\s+of\s+[A-Za-z]+|[A-Za-z\s]+municipal\s+corporation|registrar\s+of\s+births\s+and\s+deaths|gram\s+panchayat|department\s+of\s+health|government\s+of\s+[A-Za-z]+)/i
    ]);

    return {
      number,
      documentName: documentName || rawLines.find(x => isPersonName(x) && !/(birth|certificate|government|municipal|registrar)/i.test(x)),
      documentDate: dateValue(dobStr),
      address: parentAddress,
      issuer,
      fatherName,
      motherName,
      placeOfBirth: place,
    };
  }

  // ── Aadhaar Parsing ──
  if (type === 'Aadhaar') {
    const number = (cleaned.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/) || [])[0];
    const govtIndex = rawLines.findIndex(x => /government\s+of\s+india/i.test(x));
    const personLine = value => isPersonName(value) && !/(unique|d\.?o\.?b|issue|year)/i.test(value);
    const labelledName = (cleaned.match(/\bname\s*[:\-]\s*([A-Za-z][A-Za-z .]{2,})/i) || [])[1]?.trim();
    const dobLabel = /\b(?:d\s*\.?\s*[o0]\s*\.?\s*[b8]|date\s*(?:of|0f)\s*birth|y\s*\.?\s*[o0]\s*\.?\s*[b8]|year\s*(?:of|0f)\s*birth)\b|जन्म\s*(?:तिथि|दिनांक|वर्ष)/i;
    const dobIndex = rawLines.findIndex(x => dobLabel.test(x));
    const nearbyName = dobIndex >= 0 ? rawLines.slice(Math.max(0, dobIndex - 3), dobIndex).filter(personLine).pop() : undefined;
    const nameCandidates = (govtIndex >= 0 ? rawLines.slice(govtIndex + 1) : rawLines).filter(personLine).sort((a, b) => b.replace(/[^A-Za-z]/g, '').length - a.replace(/[^A-Za-z]/g, '').length);
    const name = (personLine(labelledName) ? labelledName : undefined) || nearbyName || nameCandidates[0] || rawLines.filter(personLine).sort((a, b) => b.length - a.length)[0];
    const dobContexts = dobIndex >= 0 ? [rawLines.slice(Math.max(0, dobIndex - 1), dobIndex + 4).join(' ')] : [];
    for (let index = 0; index < rawLines.length; index += 1) if (dobLabel.test(rawLines[index])) dobContexts.push(rawLines.slice(Math.max(0, index - 1), index + 4).join(' '));
    const dobContext = dobContexts.find(context => dateValue(context)) || '';
    const documentDate = dateValue(dobContext);
    const yearMatch = (dobContext || '').match(/(?:year\s*(?:of|0f)\s*birth|y\s*\.?\s*[o0]\s*\.?\s*[b8])\s*[:\-]?\s*((?:19|20)\d{2})/i);
    return { number, documentName: name, documentDate, birthYear: yearMatch?.[1], address };
  }

  // ── PAN Card Parsing ──
  if (type === 'PAN Card') {
    const panNumber = (cleaned.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/) || [])[0];
    const dates = [...cleaned.matchAll(/\b(\d{1,2}\s*[\/\.\-]\s*\d{1,2}\s*[\/\.\-]\s*(?:19|20)\d{2})\b/g)].map(x => x[1]);
    const personLines = rawLines.filter(x => isPersonName(x) && !/(income|tax|department|govt|india|permanent|account|number)/i.test(x));
    return { number: panNumber, documentName: personLines[0], documentDate: dateValue(dates[0]) };
  }

  // Generic document parsing
  const dates = [...cleaned.matchAll(/\b(\d{1,2}\s*[\/\.\-]\s*\d{1,2}\s*[\/\.\-]\s*(?:19|20)\d{2})\b/g)].map(x => x[1]);
  const lines = rawLines.filter(x => /^[A-Za-z][A-Za-z .]{2,}$/.test(x) && !/(government|india|d\.?o\.?b|year|male|female|address)/i.test(x));
  return { documentDate: dateValue(dates[0]), documentName: lines[0], address };
}

// ── Additional Helper Functions ──
const workbookNode = process.execPath;
const workbookScript = path.join(root, 'scripts', 'finance-workbook.mjs');
const financeImportTypes = ['Banking accounts', 'Credit cards', 'Debit cards', 'Forex Cards', 'UPI', 'Fixed Deposits', 'PPF Account', 'EPF Account', 'NPS Account', 'Demat Account', 'Postoffice Savings', 'Insurance policies'];

function sendFinanceTemplate(res) {
  const output = path.join(os.tmpdir(), `hearth-finance-${crypto.randomUUID()}.xlsx`);
  const snapshot = path.join(os.tmpdir(), `hearth-records-${crypto.randomUUID()}.json`);
  try {
    fs.writeFileSync(snapshot, JSON.stringify(secureStore.readDb()));
    execFileSync(workbookNode, [workbookScript, 'build', snapshot, output], { timeout: 30000 });
    const file = fs.readFileSync(output);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="hearth-finance-template.xlsx"',
      'Cache-Control': 'no-store'
    });
    res.end(file);
  } finally {
    for (const file of [output, snapshot]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function importFinanceWorkbook(payload) {
  const fileData = payload.fileData || '';
  const match = fileData.match(/^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64,(.+)$/);
  if (!match) throw new Error('Please upload an .xlsx Finance Import workbook.');
  const input = path.join(os.tmpdir(), `hearth-finance-${crypto.randomUUID()}.xlsx`);
  const output = input + '.json';
  try {
    fs.writeFileSync(input, Buffer.from(match[1], 'base64'));
    execFileSync(workbookNode, [workbookScript, 'read', input, output], { timeout: 30000 });
    const rows = JSON.parse(fs.readFileSync(output, 'utf8'));
    const dbData = secureStore.readDb();
    const imported = [], skipped = [];
    for (const [index, row] of rows.entries()) {
      const member = dbData.members.find(item => item.name === String(row['Family Member'] || '').trim());
      const type = String(row['Finance Subsection'] || '').trim();
      const values = Object.entries(row).filter(([key]) => !['Family Member', 'Finance Subsection', 'Account Type'].includes(key)).map(([, value]) => value).filter(value => String(value || '').trim());
      if (!values.length) continue;
      if (!member) { skipped.push({ row: index + 6, reason: 'Family member not found' }); continue; }
      if (!financeImportTypes.includes(type)) { skipped.push({ row: index + 6, reason: 'Choose a Finance subsection from the template' }); continue; }
      member.finance ||= [];
      member.finance.push({
        id: crypto.randomUUID(), type, bankName: row['Bank Name'] || '',
        accountNumber: row['Account Number / ID'] || '', accountType: row['Account Type'] || '',
        uan: row['UAN Number'] || '', policyId: row['Policy ID'] || '',
        policyName: row['Policy Name'] || '', maturityDate: excelDate(row['Maturity Date']),
        cardNumber: row['Card Number'] || '', cardNetwork: row['Card Network / Currency'] || '',
        expiryDate: excelDate(row['Expiry Date']), upiId: row['UPI ID'] || '',
        provider: row['Provider'] || '', lender: row['Lender / Bank'] || '',
        loanNumber: row['Loan Account Number'] || '', loanType: row['Loan Type'] || '',
        emiAmount: row['EMI Amount'] || '', emiDueDate: excelDate(row['EMI Due Date']),
        outstandingAmount: row['Outstanding Amount'] || '', depositAmount: row['FD Deposit Amount'] || ''
      });
      imported.push({ row: index + 6, member: member.name, type });
    }
    secureStore.writeDb(dbData);
    return { imported: imported.length, skipped, records: imported };
  } finally {
    for (const file of [input, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function excelDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value || '';
}

function body(req, res, done) {
  let b = '';
  req.on('data', c => {
    b += c;
  });
  req.on('error', err => {
    console.error('Request stream error:', err);
    if (!res.headersSent) send(res, 400, { error: 'Request stream error' });
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(b || '{}');
      Promise.resolve(done(parsed)).catch(error => {
        console.error('Handler error:', error);
        if (!res.headersSent) send(res, 500, { error: error.message || 'Service error' });
      });
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      if (!res.headersSent) send(res, 400, { error: 'Invalid JSON' });
    }
  });
}

function centralRecord(owner, ownerKind, document) {
  const { fileUrl, ocrText, ...metadata } = document;
  return {
    id: document.id,
    owner: { kind: ownerKind, id: owner.id, name: owner.name || owner.title },
    ...metadata,
    hasFile: !!fileUrl,
    contentUrl: fileUrl ? `/api/v1/documents/${document.id}/content` : null
  };
}

function centralRecords(dbData) {
  return [
    ...(dbData.members || []).flatMap(member => (member.documents || []).map(doc => ({ ...centralRecord(member, 'member', doc), _fileUrl: doc.fileUrl }))),
    ...(dbData.properties || []).flatMap(prop => (prop.documents || []).map(doc => ({ ...centralRecord(prop, 'property', doc), _fileUrl: doc.fileUrl })))
  ];
}

function listCentralDocuments(dbData, url) {
  const ownerKind = url.searchParams.get('ownerKind'), ownerId = url.searchParams.get('ownerId'), type = url.searchParams.get('type'), q = (url.searchParams.get('q') || '').toLowerCase();
  return {
    documents: centralRecords(dbData).filter(doc => (!ownerKind || doc.owner.kind === ownerKind) && (!ownerId || doc.owner.id === ownerId) && (!type || doc.type === type) && (!q || JSON.stringify(doc).toLowerCase().includes(q))).map(({ _fileUrl, ...doc }) => doc)
  };
}

function findCentralDocument(dbData, id) {
  const doc = centralRecords(dbData).find(item => item.id === id);
  if (!doc) return null;
  const { _fileUrl, ...metadata } = doc;
  return { ...metadata, _fileUrl };
}

function documentStorageKey(doc = {}) {
  if (doc.storageKey) return doc.storageKey;
  const match = String(doc.fileUrl || '').match(/^\/api\/files\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : doc.fileName || '';
}

function sendCentralContent(res, doc) {
  const storageKey = documentStorageKey(doc);
  if (!storageKey) return send(res, 404, { error: 'No scan attached' });
  return sendStoredFile(res, storageKey);
}

function sendStoredFile(res, name) {
  if (path.basename(name) !== name || !secureStore.hasDocument(name)) return send(res, 404, { error: 'Stored scan not found' });
  try {
    const file = secureStore.readDocument(name);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(name)] || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(file);
  } catch {
    send(res, 500, { error: 'Could not decrypt stored scan' });
  }
}

async function uploadCentralDocumentAsync(dbData, payload) {
  const owner = payload.owner || {}, document = payload.document || {}, file = payload.file || {};
  const collection = owner.kind === 'member' ? dbData.members : owner.kind === 'property' ? dbData.properties : null;
  const target = collection?.find(item => item.id === owner.id);
  if (!target) return { status: 404, error: 'Document owner not found' };
  if (!document.type) return { error: 'document.type is required' };
  const uploadData = { ...document, fileName: file.name, fileData: file.dataUrl || payload.fileData };
  const uploadResult = await storeUploadEnhanced(uploadData);
  const saved = {
    id: crypto.randomUUID(),
    status: 'Review needed',
    uploadedAt: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    ...uploadResult
  };
  target.documents ||= [];
  target.documents.push(saved);
  return centralRecord(target, owner.kind, saved);
}

async function storeVehicleAsync(data) {
  const { insuranceFileData, insuranceFileName, pucFileData, pucFileName, challanFileData, challanFileName, maintenanceFileData, maintenanceFileName, ...vehicleData } = data;
  const vehicle = await storeUploadEnhanced(vehicleData);
  const storeExtra = async (d, n, t) => d ? await storeUploadEnhanced({ fileData: d, fileName: n, type: t }) : null;
  const insurance = await storeExtra(insuranceFileData, insuranceFileName, 'Vehicle Insurance');
  const puc = await storeExtra(pucFileData, pucFileName, 'Pollution Under Check');
  const challan = await storeExtra(challanFileData, challanFileName, 'Challan');
  const maintenance = await storeExtra(maintenanceFileData, maintenanceFileName, 'Maintenance Service');
  return {
    ...vehicle,
    ...(insurance ? { insuranceFileName: insurance.fileName, insuranceFileUrl: insurance.fileUrl, insuranceOcrText: insurance.ocrText, insuranceOcrStatus: insurance.ocrStatus } : {}),
    ...(puc ? { pucFileName: puc.fileName, pucFileUrl: puc.fileUrl } : {}),
    ...(challan ? { challanFileName: challan.fileName, challanFileUrl: challan.fileUrl } : {}),
    ...(maintenance ? { maintenanceFileName: maintenance.fileName, maintenanceFileUrl: maintenance.fileUrl } : {})
  };
}

// Start the server
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
