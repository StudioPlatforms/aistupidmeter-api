-- Performance Optimization: Database Indexes
-- This migration adds composite indexes for common query patterns
-- Expected impact: 10-50x faster query performance

-- ============================================================================
-- SCORES TABLE INDEXES
-- ============================================================================

-- Primary composite index for model history queries
-- Covers: WHERE model_id=? AND suite=? ORDER BY ts DESC
CREATE INDEX IF NOT EXISTS idx_scores_model_suite_ts 
  ON scores(model_id, suite, ts DESC);

-- Time-based index for period filtering
-- Covers: WHERE ts >= ? ORDER BY ts DESC
CREATE INDEX IF NOT EXISTS idx_scores_ts 
  ON scores(ts DESC);

-- Model-based index for all suites
-- Covers: WHERE model_id=? ORDER BY ts DESC
CREATE INDEX IF NOT EXISTS idx_scores_model_ts 
  ON scores(model_id, ts DESC);

-- Suite-specific index for performance mode queries
-- Covers: WHERE suite=? AND model_id IN (...) ORDER BY ts DESC
CREATE INDEX IF NOT EXISTS idx_scores_suite_model_ts 
  ON scores(suite, model_id, ts DESC);

-- ============================================================================
-- MODELS TABLE INDEXES
-- ============================================================================

-- Show in rankings filter (most common query)
-- Covers: WHERE show_in_rankings = 1
CREATE INDEX IF NOT EXISTS idx_models_show_in_rankings 
  ON models(show_in_rankings) 
  WHERE show_in_rankings = 1;

-- Vendor-based queries
-- Covers: WHERE vendor = ?
CREATE INDEX IF NOT EXISTS idx_models_vendor 
  ON models(vendor);

-- ============================================================================
-- RUNS TABLE INDEXES (for benchmark history)
-- ============================================================================

-- Model-based run queries
-- Covers: WHERE model_id=? ORDER BY ts DESC
CREATE INDEX IF NOT EXISTS idx_runs_model_ts 
  ON runs(model_id, ts DESC);

-- Task-based queries
-- Covers: WHERE task_id=? AND model_id=?
CREATE INDEX IF NOT EXISTS idx_runs_task_model 
  ON runs(task_id, model_id);

-- ============================================================================
-- DEEP_SESSIONS TABLE INDEXES
-- ============================================================================

-- Model performance queries
-- Covers: WHERE model_id=? ORDER BY ts DESC
CREATE INDEX IF NOT EXISTS idx_deep_sessions_model_ts 
  ON deep_sessions(model_id, ts DESC);

-- ============================================================================
-- INCIDENTS TABLE INDEXES (if exists)
-- ============================================================================

-- Model incident queries
-- Covers: WHERE model_id=? AND detected_at >= ? ORDER BY detected_at DESC
CREATE INDEX IF NOT EXISTS idx_incidents_model_detected 
  ON incidents(model_id, detected_at DESC);

-- Incident type queries
-- Covers: WHERE incident_type=? ORDER BY detected_at DESC
CREATE INDEX IF NOT EXISTS idx_incidents_type_detected 
  ON incidents(incident_type, detected_at DESC);

-- ============================================================================
-- VISITORS TABLE INDEXES (for analytics)
-- ============================================================================

-- Time-based visitor queries
-- Covers: WHERE timestamp >= ? ORDER BY timestamp DESC
CREATE INDEX IF NOT EXISTS idx_visitors_timestamp 
  ON visitors(timestamp DESC);

-- Path-based analytics
-- Covers: WHERE path=? AND timestamp >= ?
CREATE INDEX IF NOT EXISTS idx_visitors_path_timestamp 
  ON visitors(path, timestamp DESC);

-- ============================================================================
-- ANALYZE TABLES
-- ============================================================================

-- Update statistics for query planner optimization
ANALYZE scores;
ANALYZE models;
ANALYZE runs;
ANALYZE deep_sessions;
ANALYZE visitors;

-- ============================================================================
-- PERFORMANCE VERIFICATION
-- ============================================================================

-- After running this migration, verify index usage with:
-- EXPLAIN QUERY PLAN SELECT * FROM scores WHERE model_id=1 AND suite='hourly' ORDER BY ts DESC LIMIT 24;
-- Expected: "SEARCH TABLE scores USING INDEX idx_scores_model_suite_ts"

-- Monitor index hit rate:
-- SELECT * FROM sqlite_stat1 WHERE tbl='scores';
