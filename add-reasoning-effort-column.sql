-- Add reasoning effort tracking to models table
-- This identifies models that use extended thinking/reasoning (slower but more accurate)

ALTER TABLE models ADD COLUMN uses_reasoning_effort INTEGER DEFAULT 0;

-- Update known reasoning models across ALL providers

-- OpenAI reasoning models (use reasoning_effort parameter)
UPDATE models SET uses_reasoning_effort = 1 WHERE name LIKE 'gpt-5%';
UPDATE models SET uses_reasoning_effort = 1 WHERE name LIKE 'o3%';
UPDATE models SET uses_reasoning_effort = 1 WHERE name = 'o3';
UPDATE models SET uses_reasoning_effort = 1 WHERE name = 'o3-mini';
UPDATE models SET uses_reasoning_effort = 1 WHERE name = 'o3-pro';

-- Google Gemini reasoning models (use thinkingConfig)
UPDATE models SET uses_reasoning_effort = 1 WHERE name LIKE 'gemini-2.5-pro%';
-- Note: gemini-2.5-flash has thinking but disabled for speed, so we don't mark it

-- DeepSeek reasoning models (use reasoning_content)
UPDATE models SET uses_reasoning_effort = 1 WHERE name = 'deepseek-reasoner';

-- Kimi reasoning models (use reasoning_content)
UPDATE models SET uses_reasoning_effort = 1 WHERE name = 'kimi-thinking-preview';

-- GLM reasoning models (use thinking mode)
UPDATE models SET uses_reasoning_effort = 1 WHERE name = 'glm-4.6';

-- Verify the changes
SELECT id, name, vendor, uses_reasoning_effort 
FROM models 
WHERE uses_reasoning_effort = 1
ORDER BY vendor, name;
