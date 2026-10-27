const crypto = require('crypto');

const localUrl = () => (process.env.LOCAL_LLM_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const chatModel = () => process.env.LOCAL_LLM_MODEL || '';
const embeddingModel = () => process.env.LOCAL_EMBEDDING_MODEL || chatModel();
const configured = () => Boolean(chatModel() && embeddingModel());

async function request(route, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(localUrl() + route, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:controller.signal });
    if (!response.ok) throw new Error(`Local AI returned ${response.status}. Confirm the model is downloaded and running.`);
    return response.json();
  } finally { clearTimeout(timer); }
}

function documentChunks(db) {
  const chunks = [];
  for (const member of db.members || []) for (const document of member.documents || []) {
    const content = [document.type, document.documentName, document.number, document.documentDate, document.expiry, document.address, document.ocrText].filter(Boolean).join('\n');
    if (content) chunks.push({id:`member:${member.id}:${document.id}`,owner:member.name,kind:document.type,text:content.slice(0,6000)});
  }
  for (const property of db.properties || []) for (const document of property.documents || []) {
    const content = [document.type, property.title, property.address, document.documentDate, document.ocrText].filter(Boolean).join('\n');
    if (content) chunks.push({id:`property:${property.id}:${document.id}`,owner:property.title,kind:document.type,text:content.slice(0,6000)});
  }
  return chunks;
}

async function embeddings(input) {
  const response = await request('/api/embed', { model:embeddingModel(), input });
  if (!Array.isArray(response.embeddings)) throw new Error('The local embedding model did not return vectors.');
  return response.embeddings;
}

function cosine(a,b) {
  let dot=0, aa=0, bb=0;
  for (let i=0;i<Math.min(a.length,b.length);i++) { dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  return dot / (Math.sqrt(aa)*Math.sqrt(bb) || 1);
}

async function buildIndex(db) {
  if (!configured()) throw new Error('Set LOCAL_LLM_MODEL and LOCAL_EMBEDDING_MODEL before creating the private vector index.');
  const chunks=documentChunks(db);
  const vectors=[];
  for (let i=0;i<chunks.length;i+=24) vectors.push(...await embeddings(chunks.slice(i,i+24).map(chunk=>chunk.text)));
  return { version:1, createdAt:new Date().toISOString(), model:embeddingModel(), sourceHash:crypto.createHash('sha256').update(JSON.stringify(chunks.map(chunk=>[chunk.id,chunk.text]))).digest('hex'), chunks:chunks.map((chunk,index)=>({...chunk,vector:vectors[index]})) };
}

async function ask(db, question) {
  if (!configured()) throw new Error('Local AI is not configured. Set LOCAL_LLM_MODEL and LOCAL_EMBEDDING_MODEL on the home server.');
  let index=db.ragIndex;
  const sourceHash=crypto.createHash('sha256').update(JSON.stringify(documentChunks(db).map(chunk=>[chunk.id,chunk.text]))).digest('hex');
  if (!index || index.sourceHash!==sourceHash || index.model!==embeddingModel()) { index=await buildIndex(db); db.ragIndex=index; }
  const [queryVector]=await embeddings([question]);
  const matches=index.chunks.map(chunk=>({...chunk,score:cosine(queryVector,chunk.vector)})).sort((a,b)=>b.score-a.score).slice(0,6);
  const context=matches.map((chunk,index)=>`[${index+1}] ${chunk.kind} — ${chunk.owner}\n${chunk.text}`).join('\n\n');
  const response=await request('/api/generate',{model:chatModel(),stream:false,prompt:`You are Hearth, a private household vault assistant. Answer only from the supplied household records. If the answer is absent, say so. Do not invent facts. Cite sources as [1], [2].\n\nHOUSEHOLD RECORDS:\n${context}\n\nQUESTION: ${question}\nANSWER:`});
  return { answer:response.response?.trim() || 'No answer was produced.', sources:matches.map((chunk,index)=>({citation:index+1,owner:chunk.owner,type:chunk.kind,score:Number(chunk.score.toFixed(3))})), indexCreatedAt:index.createdAt };
}

function jsonFromResponse(text) {
  const candidate=String(text||'').match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error('The local model did not return a document-intake result.');
  return JSON.parse(candidate);
}

async function intakeDocument({ fileName, ocrText, members }) {
  if (!configured()) throw new Error('Local AI is not configured. Set LOCAL_LLM_MODEL and LOCAL_EMBEDDING_MODEL on the home server.');
  const family=members.map(member=>({id:member.id,name:member.name}));
  const prompt=`You are Hearth's private document-intake agent. Analyse OCR from one household scan. Work in two strict stages: first extract only evidence visible in OCR (document type, person's printed name, DOB, address, number, issuer); then compare that extracted printed name with the family list to choose memberId. Return ONLY valid JSON with this exact structure: {"documentType":"Aadhaar|Passport|Voter ID|PAN Card|Driving Licence|Birth Certificate|Marriage Certificate|Class 10|Class 12|Graduation|Post Graduation|PhD|Other","memberId":"one listed id or empty","confidence":0,"metadata":{"number":"","documentName":"","documentDate":"YYYY-MM-DD or empty","expiry":"YYYY-MM-DD or empty","issuer":"","address":""},"missingFields":["field names"],"reviewNote":"short explanation"}. Never use a family member's details to fill metadata. Do not use generic words such as Aadhaar, Government of India, or Authority as the person's name. Extract DOB only when the date is visible in OCR. If a value is not visible, leave it empty. If the name does not exactly match a family member, leave memberId empty.\n\nFAMILY MEMBERS (matching only):\n${JSON.stringify(family)}\n\nFILE: ${fileName}\n\nOCR:\n${String(ocrText||'').slice(0,12000)}`;
  const response=await request('/api/generate',{model:chatModel(),stream:false,format:'json',prompt});
  const result=jsonFromResponse(response.response);
  result.confidence=Math.max(0,Math.min(1,Number(result.confidence)||0));
  result.metadata=result.metadata||{};
  result.missingFields=Array.isArray(result.missingFields)?result.missingFields:[];
  return result;
}

module.exports = { configured, localUrl, chatModel, embeddingModel, buildIndex, ask, intakeDocument };
