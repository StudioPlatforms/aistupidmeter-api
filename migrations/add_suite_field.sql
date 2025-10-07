-- Add suite field to scores table for canary/hourly/deep/tooling differentiation
ALTER TABLE scores ADD COLUMN suite TEXT DEFAULT 'hourly';

-- Add index for efficient suite-based queries
CREATE INDEX IF NOT EXISTS idx_scores_suite ON scores(suite);
CREATE INDEX IF NOT EXISTS idx_scores_model_suite ON scores(model_id, suite);
