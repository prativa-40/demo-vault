// lib/keyword-search.js — Enhanced Keyword Search with PostgreSQL FTS + LLM
const db = require('./database');

const typeAliases = {
  'aadhaar': 'Aadhaar', 'aadhar': 'Aadhaar', 'aadhar card': 'Aadhaar',
  'passport': 'Passport',
  'voter': 'Voter ID', 'voter id': 'Voter ID', 'voter card': 'Voter ID',
  'pan': 'PAN Card', 'pan card': 'PAN Card',
  'driving': 'Driving Licence', 'driving licence': 'Driving Licence', 'driving license': 'Driving Licence', 'dl': 'Driving Licence',
  'birth': 'Birth Certificate', 'birth certificate': 'Birth Certificate', 'born': 'Birth Certificate', 'dob': 'Birth Certificate', 'birthday': 'Birth Certificate',
  'marriage': 'Marriage Certificate', 'marriage certificate': 'Marriage Certificate',
  'class 10': 'Class 10', '10th': 'Class 10',
  'class 12': 'Class 12', '12th': 'Class 12',
  'graduation': 'Graduation', 'degree': 'Graduation',
};

const stopWords = new Set([
  'show','me','my','the','a','an','is','are','was','were',
  'find','get','give','search','look','for','what','where',
  'when','which','who','how','do','does','did','can','could',
  'would','should','will','shall','may','might','must','have',
  'has','had','been','being','be','i','you','he','she','it',
  'we','they','them','their','this','that','these','those',
  'of','in','to','and','or','not','with','from','at','by',
  'about','up','down','out','on','off','over','under',
  'please','want','need','document','documents','card','certificate',
]);

function extractSearchTerms(question) {
  const questionLower = question.toLowerCase();
  let detectedType = null;
  for (const [alias, type] of Object.entries(typeAliases)) {
    if (questionLower.includes(alias)) { detectedType = type; break; }
  }
  const words = question.replace(/[?!.,;:'"]/g, '').split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w.toLowerCase())).map(w => w.trim()).filter(Boolean);
  return { type: detectedType, terms: words, query: words.join(' ') };
}

async function searchWithKeywords(question) {
  const { type, terms, query } = extractSearchTerms(question);
  let results = [];
  if (query) results = await db.searchDocuments(query);
  if (results.length === 0 && query) results = await db.searchDocumentsFallback(query);
  if (type) {
    const typeMatches = results.filter(r => r.type === type);
    const others = results.filter(r => r.type !== type);
    results = [...typeMatches, ...others];
  }
  return { results, searchTerms: terms, detectedType: type, totalResults: results.length };
}

function formatResultsForLLM(searchResults) {
  if (!searchResults.results.length) return 'No matching documents found in the vault.';
  return searchResults.results.slice(0, 4).map((doc, i) =>
    [`[${i+1}] ${doc.type||'Document'}`, doc.memberName?`Owner: ${doc.memberName}`:null,
     doc.documentName?`Name: ${doc.documentName}`:null, doc.number?`Number: ${doc.number}`:null,
     doc.documentDate?`Date: ${doc.documentDate}`:null, doc.issuer?`Issuer: ${doc.issuer}`:null,
     doc.address?`Address: ${doc.address}`:null
    ].filter(Boolean).join(' · ')
  ).join('\n');
}

async function enhancedAsk(question, localAi) {
  const searchResults = await searchWithKeywords(question);

  if (searchResults.results.length === 0) {
    return {
      answer: `No documents found matching "${question}". Try searching by document name (e.g. "birth certificate"), family member name, or document number.`,
      sources: [],
      searchTerms: searchResults.searchTerms,
      totalResults: 0,
    };
  }

  // Fast direct lookup for quick keyword queries (instant response < 50ms)
  const qClean = question.trim().toLowerCase().replace(/[?!.,;:'"]/g, '');
  const isComplexQuestion = /^(why|how|explain|calculate|compare|summarize)/i.test(qClean);
  const isDirectLookup = !isComplexQuestion && (
    /^(?:show|get|give|view|find|where\s+is|what\s+is|my|open|check|search)?\s*(?:the\s+|my\s+|our\s+)?(?:birth|aadhaar|aadhar|pan|passport|voter|licen[sc]e|driving|marriage|class\s*10|class\s*12|rc\s*book|degree|certificate|document|file|record|pdf)?\s*(?:certificate|card|doc|document|pdf|scan)?$/i.test(qClean) ||
    searchResults.results.some(doc => qClean.includes((doc.type || '').toLowerCase()) || (doc.documentName && qClean.includes(doc.documentName.toLowerCase())))
  );

  if (isDirectLookup && searchResults.results.length > 0) {
    const doc = searchResults.results[0];
    const details = [
      doc.documentName ? `Name: **${doc.documentName}**` : null,
      doc.documentDate ? `Date of Birth / Issue: **${doc.documentDate}**` : null,
      doc.number ? `Registration No: **${doc.number}**` : null,
      doc.address ? `Location / Hospital: **${doc.address}**` : null,
      doc.issuer ? `Issuing Authority: **${doc.issuer}**` : null,
    ].filter(Boolean).join(' · ');

    return {
      answer: `Found your **${doc.type}** for **${doc.memberName || 'Family Member'}**.\n\n${details ? details + '\n\n' : ''}Click **Open ${doc.type} (PDF)** below to view or download it directly:`,
      sources: searchResults.results.slice(0, 6).map((d, i) => ({
        citation: i + 1,
        id: d.id,
        owner: d.memberName || 'Unknown',
        type: d.type || 'Document',
        fileUrl: d.fileUrl || null,
        fileName: d.fileName || null,
        documentName: d.documentName || null,
        documentDate: d.documentDate || null,
      })),
      searchTerms: searchResults.searchTerms,
      totalResults: searchResults.totalResults,
    };
  }

  // For conversational questions, use local AI with a strict fast timeout (3.5s)
  if (localAi && localAi.configured()) {
    const context = formatResultsForLLM(searchResults);
    try {
      const askPromise = localAi.askWithContext(question, context);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 3500));
      const response = await Promise.race([askPromise, timeoutPromise]);
      if (response && response.answer && response.answer !== 'No answer produced.') {
        return {
          answer: response.answer,
          sources: searchResults.results.slice(0, 6).map((doc, i) => ({
            citation: i + 1,
            id: doc.id,
            owner: doc.memberName || 'Unknown',
            type: doc.type || 'Document',
            fileUrl: doc.fileUrl || null,
            fileName: doc.fileName || null,
            documentName: doc.documentName || null,
            documentDate: doc.documentDate || null,
          })),
          searchTerms: searchResults.searchTerms,
          totalResults: searchResults.totalResults,
        };
      }
    } catch (error) {
      console.warn('Fast LLM notice:', error.message);
    }
  }

  // Instant fallback formatted answer from database facts
  const doc = searchResults.results[0];
  const answer = searchResults.results.slice(0, 3).map((d, i) =>
    [`[${i+1}] **${d.type || 'Document'}**`, d.memberName ? `Owner: **${d.memberName}**` : null,
     d.documentDate ? `Date: **${d.documentDate}**` : null,
     d.number ? `No: **${d.number}**` : null].filter(Boolean).join(' · ')
  ).join('\n\n');

  return {
    answer: `Found ${searchResults.totalResults} matching record(s) for **${doc.memberName || 'Family Member'}**:\n\n${answer}\n\nClick below to open the PDF directly:`,
    sources: searchResults.results.slice(0, 6).map((d, i) => ({
      citation: i + 1,
      id: d.id,
      owner: d.memberName || 'Unknown',
      type: d.type || 'Document',
      fileUrl: d.fileUrl || null,
      fileName: d.fileName || null,
      documentName: d.documentName || null,
      documentDate: d.documentDate || null,
    })),
    searchTerms: searchResults.searchTerms,
    totalResults: searchResults.totalResults,
  };
}

module.exports = { extractSearchTerms, searchWithKeywords, formatResultsForLLM, enhancedAsk };
