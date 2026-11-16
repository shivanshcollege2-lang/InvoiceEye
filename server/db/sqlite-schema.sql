CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'vendor' CHECK(role IN ('finance','reviewer','admin','vendor')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendors (
  vendor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  category TEXT,
  tax_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id),
  po_date TEXT,
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK(status IN ('DRAFT','APPROVED','CLOSED','CANCELLED')),
  currency TEXT NOT NULL DEFAULT 'INR',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders(po_date);

CREATE TABLE IF NOT EXISTS po_items (
  po_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id TEXT NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  sku TEXT,
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poi_po ON po_items(po_id);

CREATE TABLE IF NOT EXISTS invoices (
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
CREATE INDEX IF NOT EXISTS idx_invoice_number ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoice_vendor ON invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_invoice_po ON invoices(po_id);
CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(invoice_date);

CREATE TABLE IF NOT EXISTS invoice_items (
  invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  sku TEXT,
  description TEXT NOT NULL,
  quantity NUMERIC,
  unit_price NUMERIC,
  declared_line_total NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_invi_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS verification_results (
  result_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  decision_reason TEXT,
  checks_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_verification_invoice ON verification_results(invoice_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  status TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_logs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS review_actions (
  review_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','REQUEST_REVIEW')),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_review_invoice ON review_actions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_review_reviewer ON review_actions(reviewer_id);

CREATE TABLE IF NOT EXISTS invoice_status_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('AUTOMATIC','HUMAN','PROCESSING')),
  old_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  vendor_message TEXT,
  internal_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_status_history_invoice ON invoice_status_history(invoice_id,history_id);

CREATE TABLE IF NOT EXISTS invoice_batches (
  batch_id TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PROCESSING','COMPLETED','COMPLETED WITH FAILURES')),
  total_files INTEGER NOT NULL CHECK(total_files BETWEEN 1 AND 15),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoice_batches_owner ON invoice_batches(created_by,created_at);

CREATE TABLE IF NOT EXISTS invoice_batch_items (
  batch_id TEXT NOT NULL REFERENCES invoice_batches(batch_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size > 0),
  latest_attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(batch_id,item_id)
);

CREATE TABLE IF NOT EXISTS invoice_batch_attempts (
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','UPLOADING','OCR PROCESSING','VERIFYING','ACCEPTED','NEEDS REVIEW','REJECTED','PROCESSING FAILED','FAILED')),
  upload_progress INTEGER NOT NULL DEFAULT 0 CHECK(upload_progress BETWEEN 0 AND 100),
  ocr_status TEXT NOT NULL DEFAULT 'QUEUED',
  verification_status TEXT NOT NULL DEFAULT 'QUEUED',
  invoice_id TEXT REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(batch_id,item_id,attempt_number),
  FOREIGN KEY(batch_id,item_id) REFERENCES invoice_batch_items(batch_id,item_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_batch_attempt_status ON invoice_batch_attempts(batch_id,status);
CREATE INDEX IF NOT EXISTS idx_batch_attempt_invoice ON invoice_batch_attempts(invoice_id);

CREATE TABLE IF NOT EXISTS vendor_notification_contacts (
  vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','sms')),
  recipient TEXT NOT NULL,
  is_verified INTEGER NOT NULL DEFAULT 0 CHECK(is_verified IN (0,1)),
  has_consent INTEGER NOT NULL DEFAULT 0 CHECK(has_consent IN (0,1)),
  verification_method TEXT,
  consent_evidence TEXT,
  verified_at TEXT,
  consent_at TEXT,
  updated_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(vendor_id,channel)
);

CREATE TABLE IF NOT EXISTS notification_history (
  notification_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','sms')),
  recipient TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  message_subject TEXT,
  message_body TEXT NOT NULL,
  initiated_by INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SENDING','ACCEPTED','FAILED','UNKNOWN')),
  provider_status TEXT,
  provider_message_id TEXT,
  provider_response TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(dedupe_key,attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_notification_invoice ON notification_history(invoice_id,created_at);
CREATE INDEX IF NOT EXISTS idx_notification_vendor ON notification_history(vendor_id,created_at);
CREATE INDEX IF NOT EXISTS idx_notification_dedupe ON notification_history(dedupe_key,attempt_number);
