CREATE DATABASE IF NOT EXISTS invoiceeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE invoiceeye;

CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('finance','reviewer','admin') NOT NULL DEFAULT 'finance',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendors (
  vendor_id VARCHAR(30) PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  email VARCHAR(180),
  category VARCHAR(100),
  tax_id VARCHAR(80),
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id VARCHAR(40) PRIMARY KEY,
  vendor_id VARCHAR(30) NOT NULL,
  po_date DATE,
  status ENUM('DRAFT','APPROVED','CLOSED','CANCELLED') NOT NULL DEFAULT 'APPROVED',
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  notes VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
  INDEX idx_po_vendor (vendor_id),
  INDEX idx_po_date (po_date)
);

CREATE TABLE IF NOT EXISTS po_items (
  po_item_id INT AUTO_INCREMENT PRIMARY KEY,
  po_id VARCHAR(40) NOT NULL,
  sku VARCHAR(80),
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(14,2),
  unit_price DECIMAL(14,2),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  INDEX idx_poi_po (po_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id VARCHAR(40) PRIMARY KEY,
  invoice_number VARCHAR(120) NOT NULL,
  vendor_id VARCHAR(30),
  po_id VARCHAR(40),
  invoice_date DATE,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  subtotal DECIMAL(14,2),
  tax DECIMAL(14,2) DEFAULT NULL,
  discount DECIMAL(14,2),
  total DECIMAL(14,2),
  status VARCHAR(30) NOT NULL DEFAULT 'PROCESSING',
  risk_score INT NOT NULL DEFAULT 0,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  source_type ENUM('TEXT','PDF','IMAGE') NOT NULL DEFAULT 'TEXT',
  source_file VARCHAR(255),
  raw_text LONGTEXT,
  extracted_json JSON,
  created_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id),
  FOREIGN KEY (created_by) REFERENCES users(user_id),
  INDEX idx_invoice_number (invoice_number),
  INDEX idx_invoice_vendor (vendor_id),
  INDEX idx_invoice_po (po_id),
  INDEX idx_invoice_status (status),
  INDEX idx_invoice_date (invoice_date)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  invoice_item_id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  sku VARCHAR(80),
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(14,2) NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL,
  declared_line_total DECIMAL(14,2),
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  INDEX idx_invi_invoice (invoice_id)
);

CREATE TABLE IF NOT EXISTS verification_results (
  result_id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL,
  risk_score INT NOT NULL DEFAULT 0,
  decision_reason TEXT,
  checks_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  INDEX idx_verification_invoice (invoice_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40),
  user_id INT,
  action VARCHAR(120) NOT NULL,
  status VARCHAR(40),
  details TEXT,
  ip_address VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  INDEX idx_audit_invoice (invoice_id),
  INDEX idx_audit_created (created_at)
);

CREATE TABLE IF NOT EXISTS review_actions (
  review_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  reviewer_id INT NOT NULL,
  action ENUM('APPROVE','REJECT','REQUEST_REVIEW') NOT NULL,
  comment VARCHAR(1000),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES users(user_id) ON DELETE RESTRICT,
  INDEX idx_review_invoice (invoice_id),
  INDEX idx_review_reviewer (reviewer_id)
);

CREATE TABLE IF NOT EXISTS invoice_status_history (
  history_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  actor_id INT,
  event_type ENUM('AUTOMATIC','HUMAN','PROCESSING') NOT NULL,
  old_status VARCHAR(30),
  new_status VARCHAR(30) NOT NULL,
  reason TEXT,
  vendor_message VARCHAR(1000),
  internal_note VARCHAR(1000),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(user_id) ON DELETE SET NULL,
  INDEX idx_status_history_invoice (invoice_id,history_id)
);

CREATE TABLE IF NOT EXISTS invoice_batches (
  batch_id VARCHAR(64) PRIMARY KEY,
  created_by INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  total_files TINYINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE RESTRICT,
  INDEX idx_invoice_batches_owner (created_by,created_at)
);

CREATE TABLE IF NOT EXISTS invoice_batch_items (
  batch_id VARCHAR(64) NOT NULL,
  item_id VARCHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  latest_attempt SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(batch_id,item_id),
  FOREIGN KEY (batch_id) REFERENCES invoice_batches(batch_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoice_batch_attempts (
  batch_id VARCHAR(64) NOT NULL,
  item_id VARCHAR(64) NOT NULL,
  attempt_number SMALLINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  upload_progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ocr_status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  verification_status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  invoice_id VARCHAR(40) NULL,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(batch_id,item_id,attempt_number),
  FOREIGN KEY (batch_id,item_id) REFERENCES invoice_batch_items(batch_id,item_id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  INDEX idx_batch_attempt_status (batch_id,status),
  INDEX idx_batch_attempt_invoice (invoice_id)
);

CREATE TABLE IF NOT EXISTS vendor_notification_contacts (
  vendor_id VARCHAR(30) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  has_consent BOOLEAN NOT NULL DEFAULT FALSE,
  verification_method VARCHAR(120),
  consent_evidence VARCHAR(1000),
  verified_at TIMESTAMP NULL,
  consent_at TIMESTAMP NULL,
  updated_by INT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(vendor_id,channel),
  FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notification_history (
  notification_id VARCHAR(64) PRIMARY KEY,
  dedupe_key VARCHAR(64) NOT NULL,
  attempt_number SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  invoice_id VARCHAR(40) NOT NULL,
  vendor_id VARCHAR(30) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  decision VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  message_subject VARCHAR(255),
  message_body TEXT NOT NULL,
  initiated_by INT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  provider_status VARCHAR(64),
  provider_message_id VARCHAR(255),
  provider_response TEXT,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notification_attempt (dedupe_key,attempt_number),
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id) ON DELETE RESTRICT,
  FOREIGN KEY (initiated_by) REFERENCES users(user_id) ON DELETE RESTRICT,
  INDEX idx_notification_invoice (invoice_id,created_at),
  INDEX idx_notification_vendor (vendor_id,created_at)
);
