// lib/database.js — PostgreSQL Database Layer for Hearth Vault
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'hearth_vault',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
});

// Schema creation - auto-runs on first connection
async function initializeSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        relation VARCHAR(100),
        gender VARCHAR(20),
        dob DATE,
        phone VARCHAR(20),
        email VARCHAR(255),
        vault_role VARCHAR(50) DEFAULT 'child',
        location JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        member_id UUID REFERENCES members(id) ON DELETE CASCADE,
        property_id UUID,
        vehicle_id UUID,
        type VARCHAR(100) NOT NULL,
        subtype VARCHAR(100),
        document_name VARCHAR(255),
        document_date VARCHAR(50),
        birth_year VARCHAR(10),
        number VARCHAR(100),
        address TEXT,
        expiry VARCHAR(50),
        issuer VARCHAR(255),
        file_name VARCHAR(255),
        storage_key VARCHAR(255),
        file_url VARCHAR(500),
        file_data BYTEA,
        pdf_data BYTEA,
        ocr_text TEXT,
        ocr_status VARCHAR(255),
        status VARCHAR(50) DEFAULT 'Review needed',
        confidence REAL DEFAULT 0,
        keywords TEXT[] DEFAULT '{}',
        keywords_tsv TSVECTOR,
        metadata JSONB DEFAULT '{}',
        uploaded_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS properties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255),
        address TEXT,
        type VARCHAR(100),
        area VARCHAR(100),
        estimated_value VARCHAR(100),
        purchase_date DATE,
        owner_name VARCHAR(255),
        occupancy_right VARCHAR(100),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vehicles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        model VARCHAR(255),
        vehicle_number VARCHAR(50),
        registration_date VARCHAR(50),
        registration_authority VARCHAR(255),
        estimated_value VARCHAR(100),
        file_name VARCHAR(255),
        storage_key VARCHAR(255),
        file_url VARCHAR(500),
        insurance_file_name VARCHAR(255),
        insurance_file_url VARCHAR(500),
        insurance_ocr_text TEXT,
        insurance_ocr_status VARCHAR(255),
        puc_file_name VARCHAR(255),
        puc_file_url VARCHAR(500),
        challan_file_name VARCHAR(255),
        challan_file_url VARCHAR(500),
        maintenance_file_name VARCHAR(255),
        maintenance_file_url VARCHAR(500),
        ocr_text TEXT,
        ocr_status VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS finance_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        member_id UUID REFERENCES members(id) ON DELETE CASCADE,
        type VARCHAR(100) NOT NULL,
        bank_name VARCHAR(255),
        account_number VARCHAR(100),
        account_type VARCHAR(50),
        uan VARCHAR(100),
        policy_id VARCHAR(100),
        policy_name VARCHAR(255),
        maturity_date VARCHAR(50),
        card_number VARCHAR(50),
        card_network VARCHAR(100),
        expiry_date VARCHAR(50),
        upi_id VARCHAR(100),
        provider VARCHAR(255),
        lender VARCHAR(255),
        loan_number VARCHAR(100),
        loan_type VARCHAR(100),
        emi_amount VARCHAR(100),
        emi_due_date VARCHAR(50),
        outstanding_amount VARCHAR(100),
        deposit_amount VARCHAR(100),
        expense_date VARCHAR(50),
        category VARCHAR(100),
        amount VARCHAR(100),
        merchant VARCHAR(255),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appliances (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
        name VARCHAR(255),
        brand VARCHAR(255),
        purchase_date DATE,
        warranty_end DATE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
        type VARCHAR(100),
        provider VARCHAR(255),
        file_name VARCHAR(255),
        storage_key VARCHAR(255),
        file_url VARCHAR(500),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Full-text search index on documents
      CREATE INDEX IF NOT EXISTS idx_documents_keywords_tsv ON documents USING GIN(keywords_tsv);
      CREATE INDEX IF NOT EXISTS idx_documents_member_id ON documents(member_id);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
      CREATE INDEX IF NOT EXISTS idx_finance_member_id ON finance_records(member_id);

      -- Trigger to auto-update keywords_tsv
      CREATE OR REPLACE FUNCTION update_document_tsv() RETURNS trigger AS $$
      BEGIN
        NEW.keywords_tsv := to_tsvector('english',
          coalesce(NEW.ocr_text, '') || ' ' ||
          coalesce(NEW.document_name, '') || ' ' ||
          coalesce(NEW.type, '') || ' ' ||
          coalesce(NEW.number, '') || ' ' ||
          coalesce(NEW.address, '') || ' ' ||
          coalesce(array_to_string(NEW.keywords, ' '), '')
        );
        NEW.updated_at := NOW();
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_document_tsv ON documents;
      CREATE TRIGGER trg_document_tsv
        BEFORE INSERT OR UPDATE ON documents
        FOR EACH ROW EXECUTE FUNCTION update_document_tsv();
    `);
    console.log('✅ PostgreSQL schema initialized');
  } finally {
    client.release();
  }
}

// ─── UTILITY: case conversion ───
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
function rowToCamel(row) {
  if (!row) return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value;
  }
  return result;
}
function memberToCamel(row) {
  if (!row) return row;
  const m = rowToCamel(row);
  if (typeof m.location === 'string') try { m.location = JSON.parse(m.location); } catch { m.location = {}; }
  if (!m.documents) m.documents = [];
  if (!m.finance) m.finance = [];
  return m;
}
function docToCamel(row) {
  if (!row) return row;
  const d = rowToCamel(row);
  if (d.fileData) d.fileData = undefined;
  if (d.pdfData) d.pdfData = undefined;
  if (typeof d.metadata === 'string') try { d.metadata = JSON.parse(d.metadata); } catch { d.metadata = {}; }
  if (d.uploadedAt instanceof Date) {
    d.uploadedAt = d.uploadedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return d;
}
function financeToCamel(row) {
  if (!row) return row;
  const f = rowToCamel(row);
  for (const key of ['maturityDate','expiryDate','emiDueDate','expenseDate']) {
    if (f[key] instanceof Date) f[key] = f[key].toISOString().slice(0, 10);
  }
  return f;
}
function propertyToCamel(row) {
  if (!row) return row;
  const p = rowToCamel(row);
  if (!p.documents) p.documents = [];
  if (!p.appliances) p.appliances = [];
  if (!p.services) p.services = [];
  return p;
}
function vehicleToCamel(row) {
  return row ? rowToCamel(row) : row;
}

// ─── KEYWORD EXTRACTION ───
function extractKeywords(data) {
  const keywords = new Set();
  if (data.type) data.type.split(/\s+/).forEach(w => keywords.add(w.toLowerCase()));
  if (data.documentName) data.documentName.split(/\s+/).forEach(w => keywords.add(w.toLowerCase()));
  if (data.number) keywords.add(data.number.replace(/\s/g, '').toLowerCase());
  if (data.address) data.address.split(/[,\s]+/).filter(w => w.length > 2).forEach(w => keywords.add(w.toLowerCase()));
  if (data.ocrText) {
    const stopWords = new Set(['the','and','for','that','this','with','from','are','was','were','been','have','has','had','not','but','what','all','can','her','his','one','our','out','you','your','they','them']);
    data.ocrText.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
      .slice(0, 200)
      .forEach(w => keywords.add(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
  }
  return [...keywords].filter(Boolean);
}

// ─── MEMBER OPERATIONS ───
async function getMembers() {
  const { rows } = await pool.query('SELECT * FROM members ORDER BY created_at');
  for (const member of rows) {
    member.documents = (await pool.query('SELECT * FROM documents WHERE member_id = $1 ORDER BY uploaded_at', [member.id])).rows.map(docToCamel);
    member.finance = (await pool.query('SELECT * FROM finance_records WHERE member_id = $1 ORDER BY created_at', [member.id])).rows.map(financeToCamel);
  }
  return rows.map(memberToCamel);
}

async function createMember(data) {
  const { rows } = await pool.query(
    `INSERT INTO members (name, relation, gender, dob, phone, email, vault_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [data.name, data.relation, data.gender, data.dob || null, data.phone, data.email, data.vaultRole || 'child']
  );
  const member = memberToCamel(rows[0]);
  member.documents = [];
  member.finance = [];
  return member;
}

async function updateMember(id, data) {
  const fields = []; const values = []; let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (['name','relation','gender','dob','phone','email'].includes(key)) {
      fields.push(`${camelToSnake(key)} = $${i}`); values.push(value); i++;
    }
    if (key === 'vaultRole') { fields.push(`vault_role = $${i}`); values.push(value); i++; }
    if (key === 'location') { fields.push(`location = $${i}`); values.push(JSON.stringify(value)); i++; }
  }
  if (fields.length === 0) return getMemberById(id);
  values.push(id);
  const { rows } = await pool.query(`UPDATE members SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return rows[0] ? memberToCamel(rows[0]) : null;
}

async function deleteMember(id) {
  await pool.query('DELETE FROM members WHERE id = $1', [id]);
}

async function getMemberById(id) {
  const { rows } = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const member = memberToCamel(rows[0]);
  member.documents = (await pool.query('SELECT * FROM documents WHERE member_id = $1 ORDER BY uploaded_at', [id])).rows.map(docToCamel);
  member.finance = (await pool.query('SELECT * FROM finance_records WHERE member_id = $1 ORDER BY created_at', [id])).rows.map(financeToCamel);
  return member;
}

// ─── DOCUMENT OPERATIONS ───
async function createDocument(data) {
  const keywords = extractKeywords(data);
  const { rows } = await pool.query(
    `INSERT INTO documents (member_id, property_id, vehicle_id, type, subtype, document_name, document_date, birth_year, number, address, expiry, issuer, file_name, storage_key, file_url, file_data, pdf_data, ocr_text, ocr_status, status, confidence, keywords, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
    [data.memberId||null, data.propertyId||null, data.vehicleId||null, data.type, data.subtype||null,
     data.documentName||null, data.documentDate||null, data.birthYear||null, data.number||null,
     data.address||null, data.expiry||null, data.issuer||null, data.fileName||null,
     data.storageKey||null, data.fileUrl||null, data.fileData||null, data.pdfData||null,
     data.ocrText||null, data.ocrStatus||null, data.status||'Review needed',
     data.confidence||0, keywords, JSON.stringify(data.metadata||{})]
  );
  return docToCamel(rows[0]);
}

async function updateDocument(id, data) {
  const keywords = extractKeywords(data);
  const fields = []; const values = []; let i = 1;
  const allowed = ['type','subtype','documentName','documentDate','birthYear','number','address',
                    'expiry','issuer','fileName','storageKey','fileUrl','fileData','pdfData',
                    'ocrText','ocrStatus','status','confidence','metadata'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${camelToSnake(key)} = $${i}`);
      values.push(key === 'metadata' ? JSON.stringify(data[key]) : data[key]);
      i++;
    }
  }
  if (keywords.length) { fields.push(`keywords = $${i}`); values.push(keywords); i++; }
  if (fields.length === 0) return getDocumentById(id);
  values.push(id);
  const { rows } = await pool.query(`UPDATE documents SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return rows[0] ? docToCamel(rows[0]) : null;
}

async function deleteDocument(id) {
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
}

async function getDocumentById(id) {
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
  return rows[0] ? docToCamel(rows[0]) : null;
}

async function getDocumentsByMember(memberId) {
  const { rows } = await pool.query('SELECT * FROM documents WHERE member_id = $1 ORDER BY uploaded_at', [memberId]);
  return rows.map(docToCamel);
}

// ─── FULL-TEXT SEARCH ───
async function searchDocuments(query) {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(t => t.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean);
  if (terms.length === 0) return [];
  const tsqueryAnd = terms.map(t => `${t}:*`).join(' & ');
  let { rows } = await pool.query(`
    SELECT d.*, m.name as member_name,
           ts_rank(d.keywords_tsv, to_tsquery('english', $1)) as rank
    FROM documents d
    LEFT JOIN members m ON d.member_id = m.id
    WHERE d.keywords_tsv @@ to_tsquery('english', $1)
    ORDER BY rank DESC LIMIT 20
  `, [tsqueryAnd]).catch(() => ({ rows: [] }));

  if (rows.length === 0 && terms.length > 1) {
    const tsqueryOr = terms.map(t => `${t}:*`).join(' | ');
    const resOr = await pool.query(`
      SELECT d.*, m.name as member_name,
             ts_rank(d.keywords_tsv, to_tsquery('english', $1)) as rank
      FROM documents d
      LEFT JOIN members m ON d.member_id = m.id
      WHERE d.keywords_tsv @@ to_tsquery('english', $1)
      ORDER BY rank DESC LIMIT 20
    `, [tsqueryOr]).catch(() => ({ rows: [] }));
    rows = resOr.rows;
  }
  return rows.map(row => ({ ...docToCamel(row), memberName: row.member_name, searchRank: row.rank }));
}

async function searchDocumentsFallback(query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const patterns = terms.map(t => `%${t}%`);
  const whereClause = patterns.map((_, i) => `(d.ocr_text ILIKE $${i+1} OR d.document_name ILIKE $${i+1} OR d.type ILIKE $${i+1} OR d.number ILIKE $${i+1} OR m.name ILIKE $${i+1})`).join(' OR ');
  const { rows } = await pool.query(`
    SELECT d.*, m.name as member_name
    FROM documents d
    LEFT JOIN members m ON d.member_id = m.id
    WHERE ${whereClause}
    ORDER BY d.uploaded_at DESC LIMIT 20
  `, patterns).catch(() => ({ rows: [] }));
  return rows.map(row => ({ ...docToCamel(row), memberName: row.member_name }));
}

// ─── PROPERTY OPERATIONS ───
async function getProperties() {
  const { rows } = await pool.query('SELECT * FROM properties ORDER BY created_at');
  for (const prop of rows) {
    prop.documents = (await pool.query('SELECT * FROM documents WHERE property_id = $1', [prop.id])).rows.map(docToCamel);
    prop.appliances = (await pool.query('SELECT * FROM appliances WHERE property_id = $1', [prop.id])).rows;
    prop.services = (await pool.query('SELECT * FROM services WHERE property_id = $1', [prop.id])).rows;
  }
  return rows.map(propertyToCamel);
}
async function createProperty(data) {
  const { rows } = await pool.query(
    `INSERT INTO properties (title, address, type, area, estimated_value, purchase_date, owner_name, occupancy_right)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.title, data.address, data.type, data.area, data.estimatedValue, data.purchaseDate||null, data.ownerName, data.occupancyRight]
  );
  const prop = propertyToCamel(rows[0]);
  prop.documents = []; prop.appliances = []; prop.services = [];
  return prop;
}
async function updateProperty(id, data) {
  const fields = []; const values = []; let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (['title','address','type','area','estimatedValue','purchaseDate','ownerName','occupancyRight'].includes(key)) {
      fields.push(`${camelToSnake(key)} = $${i}`); values.push(value); i++;
    }
  }
  if (fields.length === 0) return null;
  values.push(id);
  const { rows } = await pool.query(`UPDATE properties SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return rows[0] ? propertyToCamel(rows[0]) : null;
}
async function deleteProperty(id) { await pool.query('DELETE FROM properties WHERE id = $1', [id]); }

// ─── VEHICLE OPERATIONS ───
async function getVehicles() {
  const { rows } = await pool.query('SELECT * FROM vehicles ORDER BY created_at');
  return rows.map(vehicleToCamel);
}
async function createVehicle(data) {
  const { rows } = await pool.query(
    `INSERT INTO vehicles (model, vehicle_number, registration_date, registration_authority, estimated_value)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.model, data.vehicleNumber, data.registrationDate||null, data.registrationAuthority, data.estimatedValue]
  );
  return vehicleToCamel(rows[0]);
}
async function updateVehicle(id, data) {
  const fields = []; const values = []; let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (['model','vehicleNumber','registrationDate','registrationAuthority','estimatedValue',
         'fileName','storageKey','fileUrl','insuranceFileName','insuranceFileUrl','insuranceOcrText','insuranceOcrStatus',
         'pucFileName','pucFileUrl','challanFileName','challanFileUrl','maintenanceFileName','maintenanceFileUrl',
         'ocrText','ocrStatus'].includes(key)) {
      fields.push(`${camelToSnake(key)} = $${i}`); values.push(value); i++;
    }
  }
  if (fields.length === 0) return null;
  values.push(id);
  const { rows } = await pool.query(`UPDATE vehicles SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return rows[0] ? vehicleToCamel(rows[0]) : null;
}
async function deleteVehicle(id) { await pool.query('DELETE FROM vehicles WHERE id = $1', [id]); }

// ─── FINANCE OPERATIONS ───
async function createFinanceRecord(memberId, data) {
  const { rows } = await pool.query(
    `INSERT INTO finance_records (member_id, type, bank_name, account_number, account_type, uan, policy_id, policy_name, maturity_date, card_number, card_network, expiry_date, upi_id, provider, lender, loan_number, loan_type, emi_amount, emi_due_date, outstanding_amount, deposit_amount, expense_date, category, amount, merchant)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
    [memberId, data.type, data.bankName, data.accountNumber, data.accountType, data.uan,
     data.policyId, data.policyName, data.maturityDate||null, data.cardNumber, data.cardNetwork,
     data.expiryDate||null, data.upiId, data.provider, data.lender, data.loanNumber,
     data.loanType, data.emiAmount, data.emiDueDate||null, data.outstandingAmount,
     data.depositAmount, data.expenseDate||null, data.category, data.amount, data.merchant]
  );
  return financeToCamel(rows[0]);
}
async function updateFinanceRecord(id, data) {
  const fields = []; const values = []; let i = 1;
  const allowed = ['type','bankName','accountNumber','accountType','uan','policyId','policyName',
                    'maturityDate','cardNumber','cardNetwork','expiryDate','upiId','provider',
                    'lender','loanNumber','loanType','emiAmount','emiDueDate','outstandingAmount',
                    'depositAmount','expenseDate','category','amount','merchant'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${camelToSnake(key)} = $${i}`); values.push(data[key] || null); i++;
    }
  }
  if (fields.length === 0) return null;
  values.push(id);
  const { rows } = await pool.query(`UPDATE finance_records SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return rows[0] ? financeToCamel(rows[0]) : null;
}
async function deleteFinanceRecord(id) { await pool.query('DELETE FROM finance_records WHERE id = $1', [id]); }

// ─── APPLIANCE & SERVICE ───
async function createAppliance(propertyId, data) {
  const { rows } = await pool.query(
    `INSERT INTO appliances (property_id, name, brand, purchase_date, warranty_end) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [propertyId, data.name, data.brand, data.purchaseDate||null, data.warrantyEnd||null]
  );
  return rows[0];
}
async function createService(propertyId, data) {
  const { rows } = await pool.query(
    `INSERT INTO services (property_id, type, provider, file_name, storage_key, file_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [propertyId, data.type, data.provider, data.fileName, data.storageKey, data.fileUrl]
  );
  return rows[0];
}

// ─── RESET ALL ───
async function resetAll() {
  await pool.query('DELETE FROM documents');
  await pool.query('DELETE FROM finance_records');
  await pool.query('DELETE FROM appliances');
  await pool.query('DELETE FROM services');
  await pool.query('DELETE FROM vehicles');
  await pool.query('DELETE FROM properties');
  await pool.query('DELETE FROM members');
}

// ─── COMPATIBILITY LAYER (old readDb format) ───
async function readDbCompat() {
  const members = await getMembers();
  const properties = await getProperties();
  const vehicles = await getVehicles();
  return { members, properties, vehicles };
}

module.exports = {
  pool, initializeSchema,
  getMembers, createMember, updateMember, deleteMember, getMemberById,
  createDocument, updateDocument, deleteDocument, getDocumentById, getDocumentsByMember,
  searchDocuments, searchDocumentsFallback,
  getProperties, createProperty, updateProperty, deleteProperty,
  getVehicles, createVehicle, updateVehicle, deleteVehicle,
  createFinanceRecord, updateFinanceRecord, deleteFinanceRecord,
  createAppliance, createService,
  resetAll, readDbCompat, extractKeywords,
};
