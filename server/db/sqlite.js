import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = new URL('./sqlite-schema.sql', import.meta.url);

export async function initSQLite() {
  const { DatabaseSync } = await import('node:sqlite');
  const databasePath = path.resolve(__dirname, '..', '..', process.env.SQLITE_PATH || 'server/db/invoiceeye.sqlite');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(await fs.readFile(schemaPath, 'utf8'));
  const invoiceColumns = database.prepare('PRAGMA table_info(invoices)').all();
  if (!invoiceColumns.some(column => column.name === 'is_demo')) {
    database.exec('ALTER TABLE invoices ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
  }
  if (!invoiceColumns.some(column => column.name === 'discount')) {
    database.exec('ALTER TABLE invoices ADD COLUMN discount NUMERIC');
  }
  const invoiceDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'").get()?.sql || '';
  if (invoiceColumns.some(column => column.name === 'tax' && column.notnull) || !invoiceDefinition.includes('PROCESSING FAILED')) {
    database.exec(`PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN;
      ALTER TABLE invoices RENAME TO invoices_legacy;
      CREATE TABLE invoices (
        invoice_id TEXT PRIMARY KEY,
        invoice_number TEXT NOT NULL,
        vendor_id TEXT REFERENCES vendors(vendor_id),
        po_id TEXT REFERENCES purchase_orders(po_id),
        invoice_date TEXT,
        currency TEXT NOT NULL DEFAULT 'INR',
        subtotal NUMERIC,
        tax NUMERIC,
        discount NUMERIC,
        total NUMERIC,
        status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('PROCESSING','PROCESSING FAILED','ACCEPTED','NEEDS REVIEW','REJECTED')),
        risk_score INTEGER NOT NULL DEFAULT 0,
        duplicate_flag INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'TEXT' CHECK(source_type IN ('TEXT','PDF','IMAGE')),
        source_file TEXT,
        raw_text TEXT,
        extracted_json TEXT,
        created_by INTEGER REFERENCES users(user_id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO invoices(invoice_id,invoice_number,vendor_id,po_id,invoice_date,currency,subtotal,tax,discount,total,status,risk_score,duplicate_flag,is_demo,source_type,source_file,raw_text,extracted_json,created_by,created_at,updated_at)
        SELECT invoice_id,invoice_number,vendor_id,po_id,invoice_date,currency,subtotal,tax,discount,total,status,risk_score,duplicate_flag,is_demo,source_type,source_file,raw_text,extracted_json,created_by,created_at,updated_at FROM invoices_legacy;
      DROP TABLE invoices_legacy;
      CREATE INDEX IF NOT EXISTS idx_invoice_number ON invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoice_vendor ON invoices(vendor_id);
      CREATE INDEX IF NOT EXISTS idx_invoice_po ON invoices(po_id);
      CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(invoice_date);
      COMMIT;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;`);
  }
  const invoiceItemColumns = database.prepare('PRAGMA table_info(invoice_items)').all();
  const invoiceItemColumnsByName = new Map(invoiceItemColumns.map(column => [column.name, column]));
  if (invoiceItemColumnsByName.get('quantity')?.notnull || invoiceItemColumnsByName.get('unit_price')?.notnull) {
    database.exec(`PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE invoice_items RENAME TO invoice_items_legacy;
      CREATE TABLE invoice_items (
        invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
        sku TEXT,
        description TEXT NOT NULL,
        quantity NUMERIC,
        unit_price NUMERIC,
        declared_line_total NUMERIC
      );
      INSERT INTO invoice_items(invoice_item_id,invoice_id,sku,description,quantity,unit_price)
        SELECT invoice_item_id,invoice_id,sku,description,quantity,unit_price FROM invoice_items_legacy;
      DROP TABLE invoice_items_legacy;
      CREATE INDEX IF NOT EXISTS idx_invi_invoice ON invoice_items(invoice_id);
      COMMIT;
      PRAGMA foreign_keys = ON;`);
  } else if (!invoiceItemColumnsByName.has('declared_line_total')) {
    database.exec('ALTER TABLE invoice_items ADD COLUMN declared_line_total NUMERIC');
  }
  database.exec(`UPDATE invoices SET is_demo=1
    WHERE invoice_id IN ('INV-9001','INV-9002','INV-9003') AND raw_text='sample seed'`);

  return createPoolAdapter(database);
}

function createPoolAdapter(database) {
  let transactionOwner = null;
  let transactionUnlocked;
  let transactionWait = Promise.resolve();

  async function waitForTransaction(owner) {
    while (transactionOwner && transactionOwner !== owner) {
      await transactionWait;
    }
  }

  async function query(sql, params = [], owner = null) {
    await waitForTransaction(owner);
    const statement = sql
      .replace(/\s+FOR UPDATE\s*$/i, '')
      .replace(/DATE_FORMAT\(\s*invoice_date\s*,\s*'%Y-%m'\s*\)/gi, "strftime('%Y-%m', invoice_date)");
    const bindings = params.map(value => typeof value === 'boolean' ? Number(value) : value);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement)) {
      return [database.prepare(statement).all(...bindings), undefined];
    }
    const result = database.prepare(statement).run(...bindings);
    return [{ affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }, undefined];
  }

  return {
    query: (sql, params) => query(sql, params),
    async getConnection() {
      const owner = {};
      return {
        async beginTransaction() {
          await waitForTransaction(owner);
          transactionOwner = owner;
          transactionWait = new Promise(resolve => { transactionUnlocked = resolve; });
          database.exec('BEGIN');
        },
        query: (sql, params) => query(sql, params, owner),
        async commit() {
          database.exec('COMMIT');
          transactionOwner = null;
          transactionUnlocked();
        },
        async rollback() {
          if (transactionOwner !== owner) return;
          database.exec('ROLLBACK');
          transactionOwner = null;
          transactionUnlocked();
        },
        release() {}
      };
    },
    async end() {
      database.close();
    }
  };
}
