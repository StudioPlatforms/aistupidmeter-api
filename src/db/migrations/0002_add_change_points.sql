-- Migration: Add change_points table for drift detection
-- Created: 2025-12-21
-- Phase: Phase 2 - Drift Infrastructure

CREATE TABLE IF NOT EXISTS change_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  detected_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  
  -- Change details
  from_score REAL NOT NULL,
  to_score REAL NOT NULL,
  delta REAL NOT NULL,
  significance REAL NOT NULL,
  
  -- Classification
  change_type TEXT NOT NULL,
  affected_axes TEXT,
  suspected_cause TEXT,
  
  -- Attribution
  incident_id INTEGER,
  confirmed INTEGER DEFAULT 0,
  false_alarm INTEGER DEFAULT 0,
  
  -- Context
  notes TEXT,
  
  FOREIGN KEY (model_id) REFERENCES models(id),
  FOREIGN KEY (incident_id) REFERENCES incidents(id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_change_points_model_detected ON change_points(model_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_points_significance ON change_points(significance DESC);
CREATE INDEX IF NOT EXISTS idx_change_points_type ON change_points(change_type);
