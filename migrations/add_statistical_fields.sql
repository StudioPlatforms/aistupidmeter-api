-- Migration: Add statistical confidence interval fields to scores table
-- Date: 2025-01-06
-- Purpose: Enable proper statistical analysis and confidence interval tracking

-- Add confidence interval and statistical metadata columns
ALTER TABLE scores ADD COLUMN confidence_lower REAL;
ALTER TABLE scores ADD COLUMN confidence_upper REAL;
ALTER TABLE scores ADD COLUMN standard_error REAL;
ALTER TABLE scores ADD COLUMN sample_size INTEGER DEFAULT 5;
ALTER TABLE scores ADD COLUMN model_variance REAL;

-- Create index for efficient queries on confidence intervals
CREATE INDEX IF NOT EXISTS idx_scores_confidence ON scores(model_id, confidence_lower, confidence_upper);

-- Add comment explaining the fields
-- confidence_lower: Lower bound of 95% confidence interval
-- confidence_upper: Upper bound of 95% confidence interval
-- standard_error: Standard error of the mean across trials
-- sample_size: Number of trials used to calculate the score (typically 5)
-- model_variance: Historical variance for this model (used for drift detection calibration)
