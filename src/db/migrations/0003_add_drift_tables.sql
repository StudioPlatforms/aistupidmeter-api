-- Migration: Add model_drift_signatures and failure_classifications tables
-- Created: 2025-12-21
-- Phase: Phase 2 - Drift Infrastructure (Completing missing tables)

-- ============================================================================
-- TABLE: model_drift_signatures
-- Purpose: Store computed drift signatures for quick retrieval
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_drift_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  ts TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  
  -- Current state
  baseline_score REAL NOT NULL,
  current_score REAL NOT NULL,
  ci_lower REAL NOT NULL,
  ci_upper REAL NOT NULL,
  
  -- Stability metrics
  regime TEXT NOT NULL CHECK(regime IN ('STABLE', 'VOLATILE', 'DEGRADED', 'RECOVERING')),
  variance_24h REAL NOT NULL,
  drift_status TEXT NOT NULL CHECK(drift_status IN ('NORMAL', 'WARNING', 'ALERT')),
  page_hinkley_cusum REAL NOT NULL,
  
  -- Temporal context
  last_change_timestamp TEXT,
  hours_since_change REAL,
  
  -- Dimensional breakdown (JSON for flexibility)
  axes_breakdown TEXT NOT NULL,
  
  -- Actionability
  primary_issue TEXT,
  recommendation TEXT,
  
  -- Full signature as JSON for extensibility
  signature_json TEXT NOT NULL,
  
  FOREIGN KEY (model_id) REFERENCES models(id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_drift_sig_model_ts ON model_drift_signatures(model_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_drift_sig_status ON model_drift_signatures(drift_status);
CREATE INDEX IF NOT EXISTS idx_drift_sig_regime ON model_drift_signatures(regime);

-- ============================================================================
-- TABLE: failure_classifications
-- Purpose: Categorize individual test failures by type
-- ============================================================================

CREATE TABLE IF NOT EXISTS failure_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  ts TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  
  -- Primary classification
  failure_mode TEXT NOT NULL,
  failure_subtype TEXT,
  
  -- Details
  task_slug TEXT NOT NULL,
  expected_behavior TEXT,
  actual_behavior TEXT,
  error_excerpt TEXT,
  
  -- Severity
  severity TEXT NOT NULL CHECK(severity IN ('minor', 'major', 'critical')),
  
  -- Analysis
  is_regression INTEGER DEFAULT 0,
  first_seen TEXT,
  
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (model_id) REFERENCES models(id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_fail_class_model_mode ON failure_classifications(model_id, failure_mode);
CREATE INDEX IF NOT EXISTS idx_fail_class_task_model ON failure_classifications(task_slug, model_id);
CREATE INDEX IF NOT EXISTS idx_fail_class_severity ON failure_classifications(severity);
CREATE INDEX IF NOT EXISTS idx_fail_class_ts ON failure_classifications(ts DESC);
