const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const { createSecureStore } = require('./lib/secure-store');
const localAi = require('./lib/local-ai');

const root = __dirname;
const dataDir = path.join(root, 'data');
const dataFile = path.join(dataDir, 'household.json');
const encryptedDataFile = path.join(dataDir, 'household.enc');
const uploadsDir = path.join(dataDir, 'documents');
const swiftCacheDir = path.join('/tmp', 'household-vault-swift-cache');
fs.mkdirSync(swiftCacheDir, { recursive: true });
const secureStore = createSecureStore({ dataDir, legacyDataFile:dataFile, encryptedDataFile, documentsDir:uploadsDir });
const { readDb, writeDb } = secureStore;
function migrateLegacyStorage() {
  if (fs.existsSync(encryptedDataFile)) return;
  const db = readDb();
  const updateFileUrl = record => {
    if (!record || typeof record !== 'object') return;
    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value === 'object') updateFileUrl(value);
      if (typeof value !== 'string' || !key.toLowerCase().endsWith('fileurl') || !value.startsWith('/uploads/')) continue;
      const name = path.basename(value), legacy = path.join(root, 'public', 'uploads', name);
      if (fs.existsSync(legacy)) {
        secureStore.writeDocument(name, fs.readFileSync(legacy));
        record[key] = `/api/files/${encodeURIComponent(name)}`;
      }
    }
  };
  updateFileUrl(db);
  writeDb(db);
  const legacyUploads = path.join(root, 'public', 'uploads');
  if (fs.existsSync(legacyUploads)) for (const entry of fs.readdirSync(legacyUploads, { withFileTypes: true })) if (entry.isFile()) fs.unlinkSync(path.join(legacyUploads, entry.name));
}
migrateLegacyStorage();
function migrateDocumentStorageKeys() {
  const db=readDb(); let changed=false;
  const visit=value=>{if(!value||typeof value!=='object')return;for(const item of Object.values(value)){if(item&&typeof item==='object')visit(item)}if(typeof value.fileUrl==='string'&&!value.storageKey){const match=value.fileUrl.match(/^\/api\/files\/([^/]+)$/);if(match){value.storageKey=decodeURIComponent(match[1]);changed=true}}};
  visit(db); if(changed)writeDb(db);
}
migrateDocumentStorageKeys();
function repairUnreadableAadhaarNames() {
  const db=readDb(); let changed=false;
  for (const member of db.members||[]) for (const document of member.documents||[]) {
    if (document.type!=='Aadhaar'||!document.ocrText||isPersonName(document.documentName)) continue;
    const extracted=parseMetadata(document.ocrText,'Aadhaar');
    if (!isPersonName(extracted.documentName)) continue;
    Object.assign(document,extracted); changed=true;
  }
  if (changed) writeDb(db);
}
repairUnreadableAadhaarNames();
const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.pdf':'application/pdf' };
const send = (res, status, payload) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(payload)); };
http.createServer((req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/data' && req.method === 'GET') return send(res, 200, readDb());
  if (url.pathname === '/api/ai/status' && req.method === 'GET') return send(res,200,{configured:localAi.configured(),provider:'local Ollama-compatible server',url:localAi.localUrl(),chatModel:localAi.chatModel()||null,embeddingModel:localAi.embeddingModel()||null,indexedAt:readDb().ragIndex?.createdAt||null});
  if (url.pathname === '/api/ai/reindex' && req.method === 'POST') return body(req,res,async()=>{const db=readDb();db.ragIndex=await localAi.buildIndex(db);writeDb(db);send(res,200,{indexedChunks:db.ragIndex.chunks.length,indexedAt:db.ragIndex.createdAt})});
  if (url.pathname === '/api/ai/ask' && req.method === 'POST') return body(req,res,async payload=>{const question=String(payload.question||'').trim();if(!question)return send(res,400,{error:'question is required'});const db=readDb(),answer=await localAi.ask(db,question);writeDb(db);send(res,200,answer)});
  if (url.pathname === '/api/agent/document-intake' && req.method === 'POST') return body(req,res,async payload=>send(res,200,await inspectDocumentIntake(payload)));
  if (url.pathname === '/api/finance/template' && req.method === 'GET') return sendFinanceTemplate(res);
  if (url.pathname === '/api/finance/import' && req.method === 'POST') return body(req,res,payload=>{try{const result=importFinanceWorkbook(payload);send(res,200,result)}catch(error){send(res,400,{error:error.message||'The workbook could not be imported'})}});
  if (url.pathname === '/api/v1/documents' && req.method === 'GET') return send(res,200,listCentralDocuments(readDb(),url));
  if (url.pathname === '/api/v1/documents' && req.method === 'POST') return body(req,res,payload=>{const db=readDb(),document=uploadCentralDocument(db,payload);if(document.error)return send(res,document.status||400,{error:document.error});writeDb(db);send(res,201,document)});
  const storedFileRoute=url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (storedFileRoute && req.method === 'GET') return sendStoredFile(res, decodeURIComponent(storedFileRoute[1]));
  const centralDocumentRoute=url.pathname.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(content))?$/);
  if (centralDocumentRoute && req.method === 'GET') { const document=findCentralDocument(readDb(),centralDocumentRoute[1]); if(!document)return send(res,404,{error:'Document not found'}); return centralDocumentRoute[2]?sendCentralContent(res,document):send(res,200,document); }
  if (url.pathname === '/api/data/reset' && req.method === 'POST') { try { const previous=readDb(),cleared={members:(previous.members||[]).length,properties:(previous.properties||[]).length,vehicles:(previous.vehicles||[]).length,documents:[...(previous.members||[]).flatMap(member=>member.documents||[]),...(previous.properties||[]).flatMap(property=>property.documents||[])].filter(document=>document.fileName).length}; const db={members:[],properties:[],vehicles:[]}; secureStore.deleteAllDocuments(); writeDb(db); const verified=readDb(); if((verified.members||[]).length||(verified.properties||[]).length||(verified.vehicles||[]).length||fs.readdirSync(uploadsDir).length)throw new Error('The vault could not be fully cleared.'); return send(res,200,{data:verified,cleared}); } catch(error) { return send(res,500,{error:error.message||'Could not clear the vault.'}); } }
  if (url.pathname === '/api/members' && req.method === 'POST') return body(req, res, d => { const db=readDb(); const member={id:crypto.randomUUID(), documents:[], finance:[], ...d}; db.members.push(member); writeDb(db); send(res,201,member); });
  const memberRoute = url.pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberRoute && req.method === 'PUT') return body(req, res, d => { const db=readDb(), member=db.members.find(x=>x.id===memberRoute[1]); if(!member) return send(res,404,{error:'Not found'}); Object.assign(member, d, { id:member.id, documents:member.documents, finance:member.finance||[] }); writeDb(db); send(res,200,member); });
  if (memberRoute && req.method === 'DELETE') { const db=readDb(), index=db.members.findIndex(x=>x.id===memberRoute[1]); if(index<0) return send(res,404,{error:'Not found'}); db.members.splice(index,1); writeDb(db); return send(res,204,{}); }
  const m = url.pathname.match(/^\/api\/members\/([^/]+)\/documents$/);
  if (m && req.method === 'POST') return body(req, res, d => { const db=readDb(), member=db.members.find(x=>x.id===m[1]); if(!member) return send(res,404,{error:'Not found'}); const doc={id:crypto.randomUUID(), status:'Review needed', uploadedAt:new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}), ...storeUpload(d)}; member.documents.push(doc); writeDb(db); send(res,201,doc); });
  const docRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/documents\/([^/]+)$/);
  if (docRoute && req.method === 'PUT') return body(req, res, d => { const db=readDb(), member=db.members.find(x=>x.id===docRoute[1]), doc=member?.documents.find(x=>x.id===docRoute[2]); if(!doc) return send(res,404,{error:'Not found'}); Object.assign(doc,storeUpload(d),{id:doc.id,uploadedAt:doc.uploadedAt}); writeDb(db); send(res,200,doc); });
  if (docRoute && req.method === 'POST' && url.searchParams.get('action') === 'ocr') { const db=readDb(), member=db.members.find(x=>x.id===docRoute[1]), doc=member?.documents.find(x=>x.id===docRoute[2]),storageKey=documentStorageKey(doc); if(!storageKey||!secureStore.hasDocument(storageKey)) return send(res,404,{error:'A stored scan is required'}); const temporary=path.join(os.tmpdir(),`hearth-reread-${crypto.randomUUID()}${path.extname(doc.fileName||storageKey)}`); let ocrText=''; try{fs.writeFileSync(temporary,secureStore.readDocument(storageKey));ocrText=runOcr(temporary)}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary)} const extracted=Object.fromEntries(Object.entries(parseMetadata(ocrText,normaliseDocumentType(doc.type))).filter(([,value])=>value)); Object.assign(doc,extracted,{ocrText,ocrStatus:ocrText?'Read locally — review details':'Could not read this scan'}); writeDb(db); return send(res,200,doc); }
  if (docRoute && req.method === 'DELETE') { const db=readDb(), member=db.members.find(x=>x.id===docRoute[1]); if(!member) return send(res,404,{error:'Not found'}); const index=member.documents.findIndex(x=>x.id===docRoute[2]); if(index<0) return send(res,404,{error:'Not found'}); member.documents.splice(index,1); writeDb(db); return send(res,204,{}); }
  const financeRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/finance$/);
  if (financeRoute && req.method === 'POST') return body(req,res,d=>{const db=readDb(),member=db.members.find(x=>x.id===financeRoute[1]);if(!member)return send(res,404,{error:'Not found'});member.finance ||= [];const record={id:crypto.randomUUID(),...d};member.finance.push(record);writeDb(db);send(res,201,record)});
  const financeRecordRoute = url.pathname.match(/^\/api\/members\/([^/]+)\/finance\/([^/]+)$/);
  if (financeRecordRoute && req.method === 'PUT') return body(req,res,d=>{const db=readDb(),member=db.members.find(x=>x.id===financeRecordRoute[1]),record=member?.finance?.find(x=>x.id===financeRecordRoute[2]);if(!record)return send(res,404,{error:'Not found'});Object.assign(record,d,{id:record.id});writeDb(db);send(res,200,record)});
  if (financeRecordRoute && req.method === 'DELETE') {const db=readDb(),member=db.members.find(x=>x.id===financeRecordRoute[1]);if(!member)return send(res,404,{error:'Not found'});const index=(member.finance||[]).findIndex(x=>x.id===financeRecordRoute[2]);if(index<0)return send(res,404,{error:'Not found'});member.finance.splice(index,1);writeDb(db);return send(res,204,{})}
  if (url.pathname === '/api/properties' && req.method === 'POST') return body(req, res, d => { const db=readDb(); const property={id:crypto.randomUUID(), documents:[], appliances:[], services:[], ...d}; db.properties.push(property); writeDb(db); send(res,201,property); });
  const propertyRoute = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
  if (propertyRoute && req.method === 'PUT') return body(req, res, d => { const db=readDb(), property=db.properties.find(x=>x.id===propertyRoute[1]); if(!property) return send(res,404,{error:'Not found'}); Object.assign(property,d,{id:property.id}); writeDb(db); send(res,200,property); });
  const propertyDocuments = url.pathname.match(/^\/api\/properties\/([^/]+)\/documents$/);
  if (propertyDocuments && req.method === 'POST') return body(req, res, d => { const db=readDb(), property=db.properties.find(x=>x.id===propertyDocuments[1]); if(!property) return send(res,404,{error:'Not found'}); property.documents ||= []; const document={id:crypto.randomUUID(),uploadedAt:new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}),...storeUpload(d)}; property.documents.push(document); writeDb(db); send(res,201,document); });
  const propertyAppliances = url.pathname.match(/^\/api\/properties\/([^/]+)\/appliances$/);
  if (propertyAppliances && req.method === 'POST') return body(req, res, d => { const db=readDb(), property=db.properties.find(x=>x.id===propertyAppliances[1]); if(!property) return send(res,404,{error:'Not found'}); property.appliances ||= []; const appliance={id:crypto.randomUUID(),...d}; property.appliances.push(appliance); writeDb(db); send(res,201,appliance); });
  const propertyServices = url.pathname.match(/^\/api\/properties\/([^/]+)\/services$/);
  if (propertyServices && req.method === 'POST') return body(req,res,d=>{const db=readDb(),property=db.properties.find(x=>x.id===propertyServices[1]);if(!property)return send(res,404,{error:'Not found'});property.services ||= [];const service={id:crypto.randomUUID(),...storeUpload(d)};property.services.push(service);writeDb(db);send(res,201,service)});
  if (propertyRoute && req.method === 'DELETE') { const db=readDb(), index=db.properties.findIndex(x=>x.id===propertyRoute[1]); if(index<0) return send(res,404,{error:'Not found'}); db.properties.splice(index,1); writeDb(db); return send(res,204,{}); }
  if (url.pathname === '/api/vehicles' && req.method === 'POST') return body(req, res, d => { const db=readDb(); db.vehicles ||= []; const vehicle={id:crypto.randomUUID(),...storeVehicle(d)}; db.vehicles.push(vehicle); writeDb(db); send(res,201,vehicle); });
  const vehicleRoute = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/);
  if (vehicleRoute && req.method === 'PUT') return body(req, res, d => { const db=readDb(), vehicle=(db.vehicles||[]).find(x=>x.id===vehicleRoute[1]); if(!vehicle)return send(res,404,{error:'Not found'}); Object.assign(vehicle,storeVehicle(d),{id:vehicle.id}); writeDb(db); send(res,200,vehicle); });
  if (vehicleRoute && req.method === 'DELETE') { const db=readDb(), index=(db.vehicles||[]).findIndex(x=>x.id===vehicleRoute[1]); if(index<0)return send(res,404,{error:'Not found'}); db.vehicles.splice(index,1); writeDb(db); return send(res,204,{}); }
  const safe = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\.\.\//,'');
  const file = path.join(root, 'public', safe);
  if (!file.startsWith(path.join(root,'public'))) return send(res,403,{error:'Forbidden'});
  fs.readFile(file, (err,data) => { if(err) {res.writeHead(404); return res.end('Not found');} res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'text/plain'}); res.end(data); });
}).listen(process.env.PORT || 3000, '127.0.0.1', () => console.log('Household Vault running at http://127.0.0.1:3000'));
const workbookNode='/Users/prativadora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
const workbookScript=path.join(root,'scripts','finance-workbook.mjs');
const financeImportTypes=['Banking accounts','Credit cards','Debit cards','Forex Cards','UPI','Fixed Deposits','PPF Account','EPF Account','NPS Account','Demat Account','Postoffice Savings','Insurance policies'];
function sendFinanceTemplate(res){const output=path.join(os.tmpdir(),`hearth-finance-${crypto.randomUUID()}.xlsx`),snapshot=path.join(os.tmpdir(),`hearth-records-${crypto.randomUUID()}.json`);try{fs.writeFileSync(snapshot,JSON.stringify(readDb()));execFileSync(workbookNode,[workbookScript,'build',snapshot,output],{timeout:30000});const file=fs.readFileSync(output);res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="hearth-finance-template.xlsx"','Cache-Control':'no-store'});res.end(file)}finally{for(const file of [output,snapshot])if(fs.existsSync(file))fs.unlinkSync(file)}}
function importFinanceWorkbook(payload){const fileData=payload.fileData||'',match=fileData.match(/^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64,(.+)$/);if(!match)throw new Error('Please upload an .xlsx Finance Import workbook.');const input=path.join(os.tmpdir(),`hearth-finance-${crypto.randomUUID()}.xlsx`),output=input+'.json';try{fs.writeFileSync(input,Buffer.from(match[1],'base64'));execFileSync(workbookNode,[workbookScript,'read',input,output],{timeout:30000});const rows=JSON.parse(fs.readFileSync(output,'utf8')),db=readDb(),imported=[],skipped=[];for(const [index,row] of rows.entries()){const member=db.members.find(item=>item.name===String(row['Family Member']||'').trim()),type=String(row['Finance Subsection']||'').trim(),values=Object.entries(row).filter(([key])=>!['Family Member','Finance Subsection','Account Type'].includes(key)).map(([,value])=>value).filter(value=>String(value||'').trim());if(!values.length)continue;if(!member){skipped.push({row:index+6,reason:'Family member not found'});continue}if(!financeImportTypes.includes(type)){skipped.push({row:index+6,reason:'Choose a Finance subsection from the template'});continue}member.finance ||= [];member.finance.push({id:crypto.randomUUID(),type,bankName:row['Bank Name']||'',accountNumber:row['Account Number / ID']||'',accountType:row['Account Type']||'',uan:row['UAN Number']||'',policyId:row['Policy ID']||'',policyName:row['Policy Name']||'',maturityDate:excelDate(row['Maturity Date']),cardNumber:row['Card Number']||'',cardNetwork:row['Card Network / Currency']||'',expiryDate:excelDate(row['Expiry Date']),upiId:row['UPI ID']||'',provider:row['Provider']||'',lender:row['Lender / Bank']||'',loanNumber:row['Loan Account Number']||'',loanType:row['Loan Type']||'',emiAmount:row['EMI Amount']||'',emiDueDate:excelDate(row['EMI Due Date']),outstandingAmount:row['Outstanding Amount']||'',depositAmount:row['FD Deposit Amount']||''});imported.push({row:index+6,member:member.name,type})}writeDb(db);return {imported:imported.length,skipped,records:imported}}finally{for(const file of [input,output])if(fs.existsSync(file))fs.unlinkSync(file)}}
function excelDate(value){if(value instanceof Date)return value.toISOString().slice(0,10);return value||'';}
function body(req, res, done) { let b=''; req.on('data', c=>b+=c); req.on('end',()=>{try{Promise.resolve(done(JSON.parse(b||'{}'))).catch(error=>send(res,503,{error:error.message||'The local service is unavailable'}))}catch{send(res,400,{error:'Invalid JSON'})}}); }
function centralRecord(owner,ownerKind,document){const {fileUrl,ocrText,...metadata}=document;return {id:document.id,owner:{kind:ownerKind,id:owner.id,name:owner.name||owner.title},...metadata,hasFile:!!fileUrl,contentUrl:fileUrl?`/api/v1/documents/${document.id}/content`:null};}
function centralRecords(db){return [...db.members.flatMap(member=>(member.documents||[]).map(document=>({...centralRecord(member,'member',document),_fileUrl:document.fileUrl}))),...db.properties.flatMap(property=>(property.documents||[]).map(document=>({...centralRecord(property,'property',document),_fileUrl:document.fileUrl})))];}
function listCentralDocuments(db,url){const ownerKind=url.searchParams.get('ownerKind'),ownerId=url.searchParams.get('ownerId'),type=url.searchParams.get('type'),q=(url.searchParams.get('q')||'').toLowerCase();return {documents:centralRecords(db).filter(document=>(!ownerKind||document.owner.kind===ownerKind)&&(!ownerId||document.owner.id===ownerId)&&(!type||document.type===type)&&(!q||JSON.stringify(document).toLowerCase().includes(q))).map(({_fileUrl,...document})=>document)};}
function findCentralDocument(db,id){const document=centralRecords(db).find(item=>item.id===id);if(!document)return null;const {_fileUrl,...metadata}=document;return {...metadata,_fileUrl};}
function documentStorageKey(document={}){if(document.storageKey)return document.storageKey;const match=String(document.fileUrl||'').match(/^\/api\/files\/([^/]+)$/);return match?decodeURIComponent(match[1]):document.fileName||''}
function sendCentralContent(res,document){const storageKey=documentStorageKey(document);if(!storageKey)return send(res,404,{error:'No scan attached'});return sendStoredFile(res,storageKey);}
function sendStoredFile(res,name){if(path.basename(name)!==name||!secureStore.hasDocument(name))return send(res,404,{error:'Stored scan not found'});try{const file=secureStore.readDocument(name);res.writeHead(200,{'Content-Type':mime[path.extname(name)]||'application/octet-stream','Content-Disposition':`inline; filename="${name.replace(/"/g,'')}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(file)}catch{send(res,500,{error:'Could not decrypt stored scan'})}}
function uploadCentralDocument(db,payload){const owner=payload.owner||{},document=payload.document||{},file=payload.file||{},collection=owner.kind==='member'?db.members:owner.kind==='property'?db.properties:null,target=collection?.find(item=>item.id===owner.id);if(!target)return {status:404,error:'Document owner not found'};if(!document.type)return {error:'document.type is required'};const uploadData={...document,fileName:file.name,fileData:file.dataUrl||payload.fileData};const saved={id:crypto.randomUUID(),status:'Review needed',uploadedAt:new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}),...storeUpload(uploadData)};target.documents ||= [];target.documents.push(saved);return centralRecord(target,owner.kind,saved);}
function storeUpload(data) { const { fileData, fileName, ...record } = data; if (!fileData) return record; const match=fileData.match(/^data:([^;]+);base64,(.+)$/); if(!match) return record; const ext=path.extname(fileName||'') || ({'application/pdf':'.pdf','image/jpeg':'.jpg','image/png':'.png'}[match[1]]||'.bin'); const name=crypto.randomUUID()+ext, raw=Buffer.from(match[2],'base64'), temporary=path.join(os.tmpdir(),`hearth-ocr-${crypto.randomUUID()}${ext}`); let ocrText=''; try{fs.writeFileSync(temporary,raw);ocrText=runOcr(temporary)}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary)} secureStore.writeDocument(name,raw); const documentType=normaliseDocumentType(record.type),extracted=parseMetadata(ocrText,documentType),safeRecord={...record,type:documentType},dateIsVisible=dateIsVisibleInOcr(record.documentDate,ocrText); if(documentType==='Aadhaar'&&!extracted.documentDate&&!dateIsVisible) delete safeRecord.documentDate; const missingOnly=Object.fromEntries(Object.entries(extracted).filter(([key,value])=>value&&!safeRecord[key])),scanEvidence=documentType==='Aadhaar'?Object.fromEntries(['documentName','documentDate','birthYear','number','address'].filter(key=>extracted[key]).map(key=>[key,extracted[key]])):{}; return {...safeRecord,...missingOnly,...scanEvidence,fileName:fileName||name,storageKey:name,fileUrl:'/api/files/'+encodeURIComponent(name),ocrText,ocrStatus:ocrText?'Read locally — review details':'Could not read this scan'}; }
function dateIsVisibleInOcr(value,text){const iso=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!iso)return false;const expected=`${iso[3]}${iso[2]}${iso[1]}`,digits=String(text||'').replace(/\D/g,'');return digits.includes(expected)}
async function inspectDocumentIntake(payload){const match=String(payload.fileData||'').match(/^data:([^;]+);base64,(.+)$/);if(!match)throw new Error('Choose a PDF or image scan first.');const ext=path.extname(payload.fileName||'')||({ 'application/pdf':'.pdf','image/jpeg':'.jpg','image/png':'.png'}[match[1]]||'.bin'),temporary=path.join(os.tmpdir(),`hearth-intake-${crypto.randomUUID()}${ext}`);let ocrText='';try{fs.writeFileSync(temporary,Buffer.from(match[2],'base64'));ocrText=runOcr(temporary)}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary)}if(!ocrText)return {ocrStatus:'Could not read this scan',confidence:0,documentType:'Other',memberId:'',metadata:{},missingFields:['Readable scan'],reviewNote:'Use a clearer, straight scan and enter details manually.'};const db=readDb();try{const intake=await localAi.intakeDocument({fileName:payload.fileName||'scan',ocrText,members:db.members||[]});intake.documentType=normaliseDocumentType(intake.documentType);const evidence=parseMetadata(ocrText,intake.documentType);intake.metadata={...(intake.metadata||{})};if(!isPersonName(intake.metadata.documentName))intake.metadata.documentName='';for(const key of ['number','documentName','documentDate','birthYear','address'])if(evidence[key])intake.metadata[key]=evidence[key];const matchingMember=findMatchingMember(db.members,intake.metadata.documentName),extracted=formatIntakeEvidence(intake.metadata);if(matchingMember){intake.memberId=matchingMember.id;intake.confidence=Math.max(Number(intake.confidence)||0,.98);intake.reviewNote=`${extracted} Matched to ${matchingMember.name}; review before saving.`}else{intake.memberId='';intake.reviewNote=`${extracted} No exact family-member match; select the member manually.`}return {...intake,ocrStatus:'Read locally — review details',ocrText}}catch(error){const documentType=guessDocumentType(ocrText,payload.fileName),metadata=parseMetadata(ocrText,documentType),matchingMember=findMatchingMember(db.members,metadata.documentName),extracted=formatIntakeEvidence(metadata);return {documentType,memberId:matchingMember?.id||'',confidence:matchingMember ? .98 : .35,metadata,missingFields:['Review agent suggestions'],reviewNote:matchingMember?`${extracted} Matched to ${matchingMember.name}; review before saving.`:`${extracted} Local LLM unavailable; select the member manually.`,ocrStatus:'Read locally — review details',ocrText}}}
function normaliseDocumentType(type=''){return /aadh?a+r/i.test(String(type))?'Aadhaar':String(type||'Other')}
function isPersonName(value=''){const name=String(value).trim(),words=name.split(/\s+/),wordLengths=words.map(word=>word.replace(/[^A-Za-z]/g,'').length);return /^[A-Za-z][A-Za-z .'-]{1,80}$/.test(name)&&words.length>=2&&wordLengths.every(length=>length>0&&length<=24)&&!/(aadhaar|aadhar|government|authority|identification|india|address|date|birth|male|female|enrolment)/i.test(name)}
function formatIntakeEvidence(metadata={}){const fields=[['Name',metadata.documentName],['DOB',metadata.documentDate||metadata.birthYear],['Address',metadata.address],['Number',metadata.number]].filter(([,value])=>value);return fields.length?`Read from scan: ${fields.map(([label,value])=>`${label}: ${value}`).join(' · ')}.`:'No reliable identity details were read from this scan.'}
function findMatchingMember(members=[],documentName=''){const normalise=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,''),tokens=value=>String(value||'').toLowerCase().replace(/\b(dr|mr|mrs|ms)\.?\b/g,'').match(/[a-z0-9]+/g)?.sort().join(' ')||'',wanted=normalise(documentName),wantedTokens=tokens(documentName);if(!wanted)return null;return members.find(member=>normalise(member.name)===wanted)||members.find(member=>wantedTokens&&tokens(member.name)===wantedTokens)||null}
function guessDocumentType(text,fileName=''){const content=`${fileName} ${text}`.toLowerCase();if(/aadhaar|aadhar|unique identification/.test(content))return 'Aadhaar';if(/passport/.test(content))return 'Passport';if(/voter|election commission/.test(content))return 'Voter ID';if(/permanent account number|income tax/.test(content))return 'PAN Card';if(/driving licence|driving license/.test(content))return 'Driving Licence';if(/birth certificate/.test(content))return 'Birth Certificate';if(/marriage certificate/.test(content))return 'Marriage Certificate';return 'Other'}
function storeVehicle(data) { const { insuranceFileData, insuranceFileName, pucFileData, pucFileName, challanFileData, challanFileName, maintenanceFileData, maintenanceFileName, ...vehicleData } = data, vehicle=storeUpload(vehicleData), storeExtra=(data,name,type)=>data?storeUpload({fileData:data,fileName:name,type}):null, insurance=storeExtra(insuranceFileData,insuranceFileName,'Vehicle Insurance'), puc=storeExtra(pucFileData,pucFileName,'Pollution Under Check'), challan=storeExtra(challanFileData,challanFileName,'Challan'), maintenance=storeExtra(maintenanceFileData,maintenanceFileName,'Maintenance Service'); return {...vehicle,...(insurance?{insuranceFileName:insurance.fileName,insuranceFileUrl:insurance.fileUrl,insuranceOcrText:insurance.ocrText,insuranceOcrStatus:insurance.ocrStatus}:{}),...(puc?{pucFileName:puc.fileName,pucFileUrl:puc.fileUrl}:{}),...(challan?{challanFileName:challan.fileName,challanFileUrl:challan.fileUrl}:{}),...(maintenance?{maintenanceFileName:maintenance.fileName,maintenanceFileUrl:maintenance.fileUrl}:{})}; }
function runOcr(filePath) { try { return execFileSync('/usr/bin/swift',[path.join(root,'scripts','ocr.swift'),filePath],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,CLANG_MODULE_CACHE_PATH:swiftCacheDir}}).trim(); } catch { return ''; } }
function parseMetadata(text,type) {
  if(!text) return {};
  const dateValue=value=>{
    const cleaned=String(value||'').replace(/[०-९]/g,digit=>String('०१२३४५६७८९'.indexOf(digit))).replace(/[Oo]/g,'0').replace(/[Il]/g,'1').replace(/S/g,'5').replace(/Z/g,'2').replace(/B/g,'8');
    const match=cleaned.match(/(\d{1,2})\s*(?:[\/\.\-]|\s)\s*(\d{1,2})\s*(?:[\/\.\-]|\s)\s*((?:19|20)\d{2})/)||cleaned.match(/\b(\d{2})(\d{2})((?:19|20)\d{2})\b/);
    if(!match) return undefined;
    const day=Number(match[1]),month=Number(match[2]);
    return day>=1&&day<=31&&month>=1&&month<=12?`${match[3]}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`:undefined;
  };
  const rawLines=text.split('\n').map(x=>x.trim()).filter(Boolean),cleaned=rawLines.join(' '),addressStart=rawLines.findIndex(x=>/\baddress\b/i.test(x));
  const address=addressStart>=0?rawLines.slice(addressStart,addressStart+5).join(', ').replace(/^.*?address\s*[:\-]?\s*/i,''):undefined;
  if(type==='Aadhaar'){
    const number=(cleaned.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/)||[])[0];
    const govtIndex=rawLines.findIndex(x=>/government\s+of\s+india/i.test(x)),personLine=value=>isPersonName(value)&&!/(unique|d\.?o\.?b|issue|year)/i.test(value);
    const labelledName=(cleaned.match(/\bname\s*[:\-]\s*([A-Za-z][A-Za-z .]{2,})/i)||[])[1]?.trim();
    // OCR commonly reads DOB as D0B, D.O.8, or splits the label and date
    // across two lines. Only accept a date when it is close to that label,
    // so an issue/enrolment date cannot become the date of birth.
    const dobLabel=/\b(?:d\s*\.?\s*[o0]\s*\.?\s*[b8]|date\s*(?:of|0f)\s*birth|y\s*\.?\s*[o0]\s*\.?\s*[b8]|year\s*(?:of|0f)\s*birth)\b|जन्म\s*(?:तिथि|दिनांक|वर्ष)/i;
    const dobIndex=rawLines.findIndex(x=>dobLabel.test(x));
    const nearbyName=dobIndex>=0?rawLines.slice(Math.max(0,dobIndex-3),dobIndex).filter(personLine).pop():undefined;
    const nameCandidates=(govtIndex>=0?rawLines.slice(govtIndex+1):rawLines).filter(personLine).sort((a,b)=>b.replace(/[^A-Za-z]/g,'').length-a.replace(/[^A-Za-z]/g,'').length);
    const name=(personLine(labelledName)?labelledName:undefined)||nearbyName||nameCandidates[0]||rawLines.filter(personLine).sort((a,b)=>b.length-a.length)[0];
    const dobContexts=dobIndex>=0?[rawLines.slice(Math.max(0,dobIndex-1),dobIndex+4).join(' ')]:[];
    for(let index=0;index<rawLines.length;index+=1) if(dobLabel.test(rawLines[index])) dobContexts.push(rawLines.slice(Math.max(0,index-1),index+4).join(' '));
    const dobContext=dobContexts.find(context=>dateValue(context))||'';
    // Aadhaar scans can contain issue dates and unrelated numbers. A date is
    // trusted as DOB only when it appears with a recognisable DOB label.
    const documentDate=dateValue(dobContext);
    const yearMatch=(dobContext||'').match(/(?:year\s*(?:of|0f)\s*birth|y\s*\.?\s*[o0]\s*\.?\s*[b8])\s*[:\-]?\s*((?:19|20)\d{2})/i);
    return {number,documentName:name,documentDate,birthYear:yearMatch?.[1],address};
  }
  const dates=[...cleaned.matchAll(/\b(\d{1,2}\s*[\/\.\-]\s*\d{1,2}\s*[\/\.\-]\s*(?:19|20)\d{2})\b/g)].map(x=>x[1]);
  const lines=rawLines.filter(x=>/^[A-Za-z][A-Za-z .]{2,}$/.test(x)&&!/(government|india|d\.?o\.?b|year|male|female|address)/i.test(x));
  return {documentDate:dateValue(dates[0]),documentName:lines[0],address};
}
