const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const algorithm = 'aes-256-gcm';

function loadMasterKey(dataDir) {
  const supplied = process.env.HEARTH_MASTER_KEY;
  if (supplied) {
    const key = Buffer.from(supplied, 'base64');
    if (key.length !== 32) throw new Error('HEARTH_MASTER_KEY must be a base64-encoded 32-byte key.');
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('HEARTH_MASTER_KEY is required in production.');
  }
  const keyPath = path.join(dataDir, '.hearth-dev-key');
  if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  return key;
}

function seal(value, key, context) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('HRT1'), iv, tag, ciphertext]);
}

function open(value, key, context) {
  if (!value.subarray(0, 4).equals(Buffer.from('HRT1'))) throw new Error('Encrypted Hearth data has an invalid header.');
  const iv = value.subarray(4, 16), tag = value.subarray(16, 32), ciphertext = value.subarray(32);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function createSecureStore({ dataDir, legacyDataFile, encryptedDataFile, documentsDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(documentsDir, { recursive: true });
  const key = loadMasterKey(dataDir);
  const dbContext = 'hearth:records:v1';
  const readDb = () => {
    if (fs.existsSync(encryptedDataFile)) return JSON.parse(open(fs.readFileSync(encryptedDataFile), key, dbContext).toString('utf8'));
    if (fs.existsSync(legacyDataFile)) return JSON.parse(fs.readFileSync(legacyDataFile, 'utf8'));
    return { members: [], properties: [], vehicles: [] };
  };
  const writeDb = db => {
    const staged = encryptedDataFile + '.next';
    fs.writeFileSync(staged, seal(Buffer.from(JSON.stringify(db, null, 2)), key, dbContext), { mode: 0o600 });
    fs.renameSync(staged, encryptedDataFile);
    if (fs.existsSync(legacyDataFile)) fs.unlinkSync(legacyDataFile);
  };
  const writeDocument = (name, content) => {
    const filePath = path.join(documentsDir, name);
    fs.writeFileSync(filePath, seal(content, key, `hearth:document:${name}`), { mode: 0o600 });
    return filePath;
  };
  const readDocument = name => open(fs.readFileSync(path.join(documentsDir, name)), key, `hearth:document:${name}`);
  const hasDocument = name => fs.existsSync(path.join(documentsDir, name));
  const deleteAllDocuments = () => {
    for (const entry of fs.readdirSync(documentsDir, { withFileTypes: true })) if (entry.isFile()) fs.unlinkSync(path.join(documentsDir, entry.name));
  };
  return { readDb, writeDb, writeDocument, readDocument, hasDocument, deleteAllDocuments, documentsDir };
}

module.exports = { createSecureStore };
