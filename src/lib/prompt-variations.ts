/**
 * Prompt Variations Library
 * 
 * Zero-cost enhancement: Tests model robustness to prompt phrasing variations
 * without additional API calls - just uses different phrasings across trials.
 * 
 * Strategy: Instead of running 5 trials with identical prompts, vary the phrasing
 * to test if models truly understand intent vs. memorizing patterns.
 */

export interface PromptVariation {
  id: string;
  type: 'paraphrase' | 'restructure' | 'style_change';
  transformer: (originalPrompt: string, functionName: string) => string;
  description: string;
}

/**
 * Prompt variation transformers that test robustness to phrasing
 * Each transformer creates a semantically equivalent but syntactically different prompt
 */
export const PROMPT_VARIATIONS: PromptVariation[] = [
  // ========== PARAPHRASING VARIATIONS ==========
  {
    id: 'paraphrase_concise',
    type: 'paraphrase',
    transformer: (prompt, funcName) => {
      // Make more concise while preserving meaning
      return prompt
        .replace(/Write a Python function named/i, `Implement`)
        .replace(/that checks if/i, 'checking if')
        .replace(/that takes/i, 'taking')
        .replace(/that returns/i, 'returning')
        .replace(/that implements/i, 'implementing')
        .replace(/that performs/i, 'performing')
        .replace(/that determines/i, 'determining')
        .replace(/that computes/i, 'computing');
    },
    description: 'Concise phrasing'
  },
  {
    id: 'paraphrase_verbose',
    type: 'paraphrase',
    transformer: (prompt, funcName) => {
      // Make more verbose while preserving meaning
      return prompt
        .replace(/Write a Python function/i, 'Create a Python function definition')
        .replace(/named (\w+)/i, 'with the name $1')
        .replace(/that checks/i, 'which will check')
        .replace(/that takes/i, 'which accepts')
        .replace(/that returns/i, 'and returns')
        .replace(/Return/i, 'The function should return');
    },
    description: 'Verbose phrasing'
  },
  {
    id: 'paraphrase_alternative_wording',
    type: 'paraphrase',
    transformer: (prompt, funcName) => {
      // Use alternative words with same meaning
      return prompt
        .replace(/Write/i, 'Create')
        .replace(/function/i, 'method')
        .replace(/checks if/i, 'verifies whether')
        .replace(/returns/i, 'gives back')
        .replace(/takes/i, 'accepts')
        .replace(/implements/i, 'realizes')
        .replace(/efficiently/i, 'optimally')
        .replace(/determines/i, 'establishes')
        .replace(/computes/i, 'calculates');
    },
    description: 'Alternative vocabulary'
  },
  
  // ========== RESTRUCTURING VARIATIONS ==========
  {
    id: 'restructure_objective_first',
    type: 'restructure',
    transformer: (prompt, funcName) => {
      // Put the objective before the implementation details
      const match = prompt.match(/Write a Python function named (\w+) that (.+)/i);
      if (match) {
        const [, name, objective] = match;
        return `Goal: ${objective}\nImplementation: Write a Python function named ${name} to accomplish this.`;
      }
      return prompt;
    },
    description: 'Objective-first structure'
  },
  {
    id: 'restructure_question_format',
    type: 'restructure',
    transformer: (prompt, funcName) => {
      // Convert statement to question format
      return prompt
        .replace(/Write a Python function named (\w+) that (.+)/i, 
                 'How would you implement a Python function named $1 that $2?');
    },
    description: 'Question format'
  },
  {
    id: 'restructure_imperative',
    type: 'restructure',
    transformer: (prompt, funcName) => {
      // Use imperative mood (direct command)
      return prompt
        .replace(/Write a Python function/i, 'Define a Python function')
        .replace(/named (\w+) that/i, '$1 that should')
        .replace(/Return/i, 'Make it return')
        .replace(/The function should/i, 'It must');
    },
    description: 'Imperative mood'
  },
  
  // ========== STYLE VARIATIONS ==========
  {
    id: 'style_specification',
    type: 'style_change',
    transformer: (prompt, funcName) => {
      // Technical specification style
      return `Function Specification:\n` +
             `Name: ${funcName}\n` +
             `Task: ${prompt.replace(/Write a Python function named \w+ that /i, '')}\n` +
             `Language: Python`;
    },
    description: 'Specification style'
  },
  {
    id: 'style_conversational',
    type: 'style_change',
    transformer: (prompt, funcName) => {
      // More conversational style
      return prompt
        .replace(/Write a Python function/i, 'Can you write a Python function')
        .replace(/named (\w+) that/i, 'called $1 that')
        .replace(/\. The function/i, ', and the function')
        .replace(/Return/i, 'It should return')
        + '\n\nThanks!';
    },
    description: 'Conversational style'
  },
  {
    id: 'style_formal',
    type: 'style_change',
    transformer: (prompt, funcName) => {
      // Formal/academic style
      return prompt
        .replace(/Write a Python function/i, 'Develop a Python function')
        .replace(/that checks/i, 'which ascertains')
        .replace(/that implements/i, 'which realizes')
        .replace(/efficiently/i, 'in an optimal manner')
        .replace(/Return/i, 'The return value should be');
    },
    description: 'Formal style'
  },
  
  // ========== ORDERING VARIATIONS ==========
  {
    id: 'order_requirements_first',
    type: 'restructure',
    transformer: (prompt, funcName) => {
      // Put requirements/constraints before the main task
      const parts = prompt.split('. ');
      if (parts.length > 1) {
        // Move last sentence (usually a requirement) to the front
        const mainTask = parts.slice(0, -1).join('. ');
        const requirement = parts[parts.length - 1];
        return `${requirement}\n\n${mainTask}.`;
      }
      return prompt;
    },
    description: 'Requirements first'
  },
  {
    id: 'order_example_driven',
    type: 'restructure',
    transformer: (prompt, funcName) => {
      // Add "For example" connector to make it more example-driven
      return prompt.replace(/The function should/i, 'For example, the function should');
    },
    description: 'Example-driven'
  }
];

/**
 * Get a prompt variation by index (for deterministic trial variation)
 */
export function getPromptVariation(index: number): PromptVariation {
  return PROMPT_VARIATIONS[index % PROMPT_VARIATIONS.length];
}

/**
 * Get a random prompt variation
 */
export function getRandomPromptVariation(rand: () => number = Math.random): PromptVariation {
  return PROMPT_VARIATIONS[Math.floor(rand() * PROMPT_VARIATIONS.length)];
}

/**
 * Get all variations of a specific type
 */
export function getPromptVariationsByType(type: 'paraphrase' | 'restructure' | 'style_change'): PromptVariation[] {
  return PROMPT_VARIATIONS.filter(v => v.type === type);
}

/**
 * Apply a variation to a prompt
 */
export function applyPromptVariation(
  originalPrompt: string,
  functionName: string,
  variationOrIndex: PromptVariation | number
): {
  prompt: string;
  variationId: string;
  variationType: string;
} {
  const variation = typeof variationOrIndex === 'number' 
    ? getPromptVariation(variationOrIndex)
    : variationOrIndex;
  
  return {
    prompt: variation.transformer(originalPrompt, functionName),
    variationId: variation.id,
    variationType: variation.type
  };
}

/**
 * Calculate robustness score based on consistency across variations
 */
export function calculateRobustnessScore(results: Array<{
  variationId: string;
  passed: boolean;
  score: number;
}>): {
  robustnessScore: number;
  consistencyRate: number;
  averageScore: number;
  notes: string;
} {
  if (results.length === 0) {
    return {
      robustnessScore: 0,
      consistencyRate: 0,
      averageScore: 0,
      notes: 'No results to analyze'
    };
  }
  
  const passCount = results.filter(r => r.passed).length;
  const consistencyRate = passCount / results.length;
  const averageScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  
  // Calculate variance in scores
  const variance = results.reduce((sum, r) => sum + Math.pow(r.score - averageScore, 2), 0) / results.length;
  const stdDev = Math.sqrt(variance);
  
  // Robustness score combines consistency and low variance
  // High consistency + low variance = high robustness
  const variancePenalty = Math.min(stdDev / 10, 0.3); // Cap penalty at 0.3
  const robustnessScore = Math.max(0, consistencyRate - variancePenalty);
  
  let notes = '';
  if (consistencyRate === 1.0) {
    notes = 'Perfect consistency across all prompt variations';
  } else if (consistencyRate >= 0.8) {
    notes = 'High consistency with minor variations';
  } else if (consistencyRate >= 0.6) {
    notes = 'Moderate consistency - some prompt sensitivity detected';
  } else if (consistencyRate >= 0.4) {
    notes = 'Low consistency - significant prompt brittleness';
  } else {
    notes = 'Very low consistency - highly sensitive to prompt phrasing';
  }
  
  if (stdDev > 5) {
    notes += '; High score variance indicates unstable performance';
  }
  
  return {
    robustnessScore,
    consistencyRate,
    averageScore,
    notes
  };
}
