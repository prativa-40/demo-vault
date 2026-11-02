// setup-db.js — Run once to create the PostgreSQL database and tables
const { Pool } = require('pg');

const config = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};

async function setup() {
  console.log('🔧 Setting up Hearth Vault database...\n');

  const adminPool = new Pool({ ...config, database: 'postgres' });

  try {
    const dbName = process.env.PG_DATABASE || 'hearth_vault';
    const { rows } = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);

    if (rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      console.log(`✅ Database "${dbName}" created`);
    } else {
      console.log(`ℹ️  Database "${dbName}" already exists`);
    }
  } catch (error) {
    console.error('❌ Could not create database:', error.message);
    console.log('\nMake sure PostgreSQL is running and the credentials are correct.');
    console.log('Environment variables:');
    console.log('  PG_HOST     (default: localhost)');
    console.log('  PG_PORT     (default: 5432)');
    console.log('  PG_USER     (default: postgres)');
    console.log('  PG_PASSWORD (default: postgres)');
    console.log('  PG_DATABASE (default: hearth_vault)');
    process.exit(1);
  } finally {
    await adminPool.end();
  }

  const { initializeSchema, pool } = require('./lib/database');
  try {
    await initializeSchema();
    console.log('✅ Database schema initialized');
    console.log('\n🎉 Setup complete! Run "npm start" to launch the server.');
  } catch (error) {
    console.error('❌ Schema initialization failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

setup();
