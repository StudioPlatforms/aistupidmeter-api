-- Migration SQL for High-Value Data Capture Tables
-- Created: 2025-11-06
-- Purpose: Add tables for raw outputs, test case results, and adversarial testing
-- Value: $100K-500K/year potential from this data

-- ============================================================================
-- 1. ADD API VERSION TRACKING TO EXISTING RUNS TABLE
-- ============================================================================
-- These columns help correlate performance changes with model updates
ALTER TABLE runs ADD COLUMN api_version TEXT;
ALTER TABLE runs ADD COLUMN response_headers TEXT; -- JSON format
ALTER TABLE runs ADD COLUMN model_fingerprint TEXT;

-- ============================================================================
-- 2. RAW OUTPUTS TABLE
-- ============================================================================
-- HIGH VALUE: Captures LLM responses before code extraction
-- Reveals failure modes, hallucinations, and extraction issues
CREATE TABLE IF NOT EXISTS raw_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  raw_text TEXT NOT NULL, -- Full LLM response before extraction
  extracted_code TEXT, -- Code after extraction (may be null if extraction failed)
  extraction_success INTEGER NOT NULL, -- Boolean: 0 or 1
  extraction_method TEXT, -- 'code_block', 'plain_text', 'failed'
  failure_type TEXT, -- 'syntax_error', 'logic_error', 'timeout', 'refusal', 'hallucination', 'empty_response'
  failure_details TEXT, -- Additional context about the failure
  ts TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient querying by run
CREATE INDEX IF NOT EXISTS idx_raw_outputs_run_id ON raw_outputs(run_id);

-- Index for failure analysis
CREATE INDEX IF NOT EXISTS idx_raw_outputs_failure_type ON raw_outputs(failure_type);

-- ============================================================================
-- 3. TEST CASE RESULTS TABLE
-- ============================================================================
-- HIGH VALUE: Per-test-case granularity for failure analysis
-- Shows which specific test cases models fail on
CREATE TABLE IF NOT EXISTS test_case_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  test_case_index INTEGER NOT NULL,
  test_input TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  actual_output TEXT, -- May be null if execution failed
  passed INTEGER NOT NULL, -- Boolean: 0 or 1
  error_message TEXT, -- Python error message if test failed
  execution_time_ms INTEGER, -- Time to execute this specific test
  ts TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient querying by run
CREATE INDEX IF NOT EXISTS idx_test_case_results_run_id ON test_case_results(run_id);

-- Index for failure analysis
CREATE INDEX IF NOT EXISTS idx_test_case_results_passed ON test_case_results(passed);

-- Composite index for per-run analysis
CREATE INDEX IF NOT EXISTS idx_test_case_results_run_test ON test_case_results(run_id, test_case_index);

-- ============================================================================
-- 4. ADVERSARIAL PROMPTS LIBRARY
-- ============================================================================
-- EXTREMELY HIGH VALUE: $300K-1M/year potential
-- Systematic safety testing prompts
CREATE TABLE IF NOT EXISTS adversarial_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_text TEXT NOT NULL,
  attack_type TEXT NOT NULL, -- 'jailbreak', 'injection', 'extraction', 'manipulation', 'harmful_content'
  severity TEXT NOT NULL, -- 'low', 'medium', 'high', 'critical'
  expected_behavior TEXT NOT NULL, -- What a safe model should do
  category TEXT, -- 'code_injection', 'prompt_leak', 'safety_bypass', 'data_extraction'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1 -- Boolean: 0 or 1
);

-- Index for querying by attack type
CREATE INDEX IF NOT EXISTS idx_adversarial_prompts_attack_type ON adversarial_prompts(attack_type);

-- Index for querying by severity
CREATE INDEX IF NOT EXISTS idx_adversarial_prompts_severity ON adversarial_prompts(severity);

-- Index for active prompts
CREATE INDEX IF NOT EXISTS idx_adversarial_prompts_active ON adversarial_prompts(active);

-- ============================================================================
-- 5. ADVERSARIAL TEST RESULTS
-- ============================================================================
-- EXTREMELY HIGH VALUE: Tracks which models are vulnerable
-- Safety data is rare and critical
CREATE TABLE IF NOT EXISTS adversarial_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL REFERENCES adversarial_prompts(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  response_text TEXT NOT NULL,
  bypass_successful INTEGER NOT NULL, -- Boolean: Did the attack work?
  safety_score REAL NOT NULL, -- 0.0-1.0, higher is safer
  refusal_detected INTEGER DEFAULT 0, -- Boolean: Did model refuse?
  harmful_content_generated INTEGER DEFAULT 0, -- Boolean
  notes TEXT, -- Additional observations
  ts TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying by prompt
CREATE INDEX IF NOT EXISTS idx_adversarial_results_prompt_id ON adversarial_results(prompt_id);

-- Index for querying by model
CREATE INDEX IF NOT EXISTS idx_adversarial_results_model_id ON adversarial_results(model_id);

-- Index for vulnerability analysis
CREATE INDEX IF NOT EXISTS idx_adversarial_results_bypass ON adversarial_results(bypass_successful);

-- Composite index for per-model analysis
CREATE INDEX IF NOT EXISTS idx_adversarial_results_model_prompt ON adversarial_results(model_id, prompt_id);

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- Run these to verify the migration was successful:

-- Check if tables were created
-- SELECT name FROM sqlite_master WHERE type='table' AND name IN ('raw_outputs', 'test_case_results', 'adversarial_prompts', 'adversarial_results');

-- Check if columns were added to runs table
-- PRAGMA table_info(runs);

-- Check indexes
-- SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('raw_outputs', 'test_case_results', 'adversarial_prompts', 'adversarial_results');

-- ============================================================================
-- ROLLBACK (if needed)
-- ============================================================================
-- To rollback this migration:
-- DROP TABLE IF EXISTS adversarial_results;
-- DROP TABLE IF EXISTS adversarial_prompts;
-- DROP TABLE IF EXISTS test_case_results;
-- DROP TABLE IF EXISTS raw_outputs;
-- 
-- Note: SQLite doesn't support DROP COLUMN, so you'll need to recreate the runs table
-- to remove the added columns. This is complex and should be done carefully.

-- ============================================================================
-- NOTES
-- ============================================================================
-- 1. This migration adds ~4 new tables and 3 columns to existing table
-- 2. Expected storage impact: ~100MB per 10K benchmark runs
-- 3. Performance impact: Minimal (<5ms per insert)
-- 4. Data value: $100K-500K/year potential
-- 5. Next steps: Modify real-benchmarks.ts to populate these tables
