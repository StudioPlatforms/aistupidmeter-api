/**
 * Prompt Analysis System for Smart Model Routing
 * 
 * Analyzes user prompts to detect:
 * - Programming language
 * - Task type (UI, algorithm, backend, etc.)
 * - Framework hints
 * - Complexity level
 * 
 * Uses fast pattern matching (no AI needed) for sub-50ms analysis
 */

export interface PromptAnalysis {
  language: 'python' | 'javascript' | 'typescript' | 'rust' | 'go' | 'unknown';
  taskType: 'ui' | 'algorithm' | 'backend' | 'debug' | 'refactor' | 'general';
  framework?: 'react' | 'vue' | 'angular' | 'express' | 'fastapi' | 'django' | 'nextjs' | 'flask';
  complexity: 'simple' | 'medium' | 'complex';
  keywords: string[];
  confidence: number;
  detectionReasons: string[];
}

/**
 * Main entry point: Analyze a user prompt
 */
export function analyzePrompt(prompt: string): PromptAnalysis {
  const text = prompt.toLowerCase();
  const detectionReasons: string[] = [];
  
  // Language detection with file extension hints
  const language = detectLanguage(text, detectionReasons);
  
  // Task type detection with comprehensive keywords
  const taskType = detectTaskType(text, detectionReasons);
  
  // Framework detection
  const framework = detectFramework(text, detectionReasons);
  
  // Complexity estimation
  const complexity = estimateComplexity(text, detectionReasons);
  
  // Extract meaningful keywords
  const keywords = extractKeywords(text);
  
  // Calculate confidence score
  const confidence = calculateConfidence(text, language, taskType, detectionReasons);
  
  return {
    language,
    taskType,
    framework,
    complexity,
    keywords,
    confidence,
    detectionReasons
  };
}

/**
 * Detect programming language from prompt
 */
function detectLanguage(
  text: string, 
  reasons: string[]
): PromptAnalysis['language'] {
  const patterns = {
    javascript: {
      pattern: /\b(javascript|js|node\.?js|npm|yarn|jsx|es6|es2015|commonjs|module\.exports|require\()\b/,
      weight: 1.0,
      reason: 'JavaScript keywords detected'
    },
    typescript: {
      pattern: /\b(typescript|ts|interface\s+\w+|type\s+\w+\s*=|generic|\.tsx?|tsc|@types)\b/,
      weight: 1.2, // Higher weight as TS is more specific
      reason: 'TypeScript keywords detected'
    },
    python: {
      pattern: /\b(python|py|django|flask|fastapi|pandas|numpy|pip|def\s+\w+|import\s+\w+|\.py\b)\b/,
      weight: 1.0,
      reason: 'Python keywords detected'
    },
    rust: {
      pattern: /\b(rust|cargo|ownership|borrow|lifetime|rustc|\.rs\b|impl\s+|trait\s+)\b/,
      weight: 1.1,
      reason: 'Rust keywords detected'
    },
    go: {
      pattern: /\b(golang|go\s+|goroutine|channel|defer|\.go\b|go\.mod|package\s+main)\b/,
      weight: 1.1,
      reason: 'Go keywords detected'
    }
  };
  
  // Check for file extensions (strong signal)
  const fileExtensions = {
    javascript: /\.(js|mjs|cjs)\b/,
    typescript: /\.(ts|tsx)\b/,
    python: /\.py\b/,
    rust: /\.rs\b/,
    go: /\.go\b/
  };
  
  let maxScore = 0;
  let detectedLang: PromptAnalysis['language'] = 'unknown';
  
  // Check file extensions first (strongest signal)
  for (const [lang, pattern] of Object.entries(fileExtensions)) {
    if (pattern.test(text)) {
      reasons.push(`File extension detected: ${lang}`);
      return lang as PromptAnalysis['language'];
    }
  }
  
  // Check keyword patterns with weights
  for (const [lang, config] of Object.entries(patterns)) {
    const matches = (text.match(config.pattern) || []).length;
    const score = matches * config.weight;
    
    if (score > maxScore) {
      maxScore = score;
      detectedLang = lang as PromptAnalysis['language'];
      if (matches > 0) {
        reasons.push(config.reason);
      }
    }
  }
  
  // Default to Python if unclear (most common in coding tasks)
  if (detectedLang === 'unknown') {
    reasons.push('Defaulting to Python (most common)');
    return 'python';
  }
  
  return detectedLang;
}

/**
 * Detect task type from prompt
 */
function detectTaskType(
  text: string,
  reasons: string[]
): PromptAnalysis['taskType'] {
  const patterns = {
    ui: {
      pattern: /\b(component|render|ui|frontend|button|form|css|style|html|dom|view|page|layout|modal|dropdown|navbar|sidebar|responsive|mobile|desktop)\b/,
      weight: 1.0,
      reason: 'UI/Frontend keywords detected'
    },
    backend: {
      pattern: /\b(api|endpoint|server|database|sql|query|route|handler|crud|rest|graphql|middleware|auth|jwt|session|cookie|http|request|response)\b/,
      weight: 1.0,
      reason: 'Backend/API keywords detected'
    },
    algorithm: {
      pattern: /\b(sort|search|tree|graph|algorithm|optimize|complexity|data\s*structure|hash|dynamic\s*programming|recursion|iteration|binary|linked\s*list|queue|stack)\b/,
      weight: 1.0,
      reason: 'Algorithm keywords detected'
    },
    debug: {
      pattern: /\b(debug|fix|error|bug|issue|problem|broken|fails?|crash|exception|trace|stack\s*trace)\b/,
      weight: 1.1, // Higher weight as debugging is specific
      reason: 'Debugging keywords detected'
    },
    refactor: {
      pattern: /\b(refactor|clean|improve|restructure|optimize|rewrite|simplify|modularize)\b/,
      weight: 1.0,
      reason: 'Refactoring keywords detected'
    }
  };
  
  let maxScore = 0;
  let detectedType: PromptAnalysis['taskType'] = 'general';
  
  for (const [type, config] of Object.entries(patterns)) {
    const matches = (text.match(config.pattern) || []).length;
    const score = matches * config.weight;
    
    if (score > maxScore) {
      maxScore = score;
      detectedType = type as PromptAnalysis['taskType'];
      if (matches > 0) {
        reasons.push(config.reason);
      }
    }
  }
  
  return detectedType;
}

/**
 * Detect framework from prompt
 */
function detectFramework(
  text: string,
  reasons: string[]
): PromptAnalysis['framework'] | undefined {
  const frameworks = {
    react: /\b(react|jsx|tsx|usestate|useeffect|component|props)\b/,
    vue: /\b(vue|vuex|nuxt|v-if|v-for|v-model)\b/,
    angular: /\b(angular|ng-|@angular|component|directive|service)\b/,
    nextjs: /\b(next\.?js|getserversideprops|getstaticprops)\b/,
    express: /\b(express|app\.get|app\.post|middleware)\b/,
    fastapi: /\b(fastapi|@app\.get|@app\.post|pydantic)\b/,
    django: /\b(django|models\.model|views\.view|urls\.py)\b/,
    flask: /\b(flask|@app\.route|render_template)\b/
  };
  
  for (const [framework, pattern] of Object.entries(frameworks)) {
    if (pattern.test(text)) {
      reasons.push(`Framework detected: ${framework}`);
      return framework as PromptAnalysis['framework'];
    }
  }
  
  return undefined;
}

/**
 * Estimate complexity level
 */
function estimateComplexity(
  text: string,
  reasons: string[]
): PromptAnalysis['complexity'] {
  const complexIndicators = [
    { pattern: /\b(concurrent|parallel|distributed|async|multi-?thread|race\s*condition)\b/, reason: 'Concurrency complexity' },
    { pattern: /\b(optimize|performance|efficiency|scale|throughput|latency)\b/, reason: 'Performance optimization' },
    { pattern: /\b(architecture|design\s*pattern|microservice|monolith|distributed\s*system)\b/, reason: 'Architectural complexity' },
    { pattern: /\b(secure|encrypt|auth|permission|oauth|jwt|security)\b/, reason: 'Security requirements' },
    { pattern: /\b(test|unit\s*test|integration\s*test|e2e|coverage)\b/, reason: 'Testing requirements' },
    { pattern: /\b(deploy|ci\/cd|docker|kubernetes|container)\b/, reason: 'Deployment complexity' }
  ];
  
  let complexMatches = 0;
  const wordCount = text.split(/\s+/).length;
  
  for (const indicator of complexIndicators) {
    if (indicator.pattern.test(text)) {
      complexMatches++;
      reasons.push(indicator.reason);
    }
  }
  
  // Complexity scoring
  if (complexMatches >= 3 || wordCount > 150) {
    return 'complex';
  }
  if (complexMatches >= 1 || wordCount > 50) {
    return 'medium';
  }
  return 'simple';
}

/**
 * Extract meaningful keywords from prompt
 */
function extractKeywords(text: string): string[] {
  // Remove common words
  const commonWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'write',
    'create', 'make', 'build', 'implement', 'function', 'code', 'program'
  ]);
  
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => 
      word.length > 3 && 
      !commonWords.has(word) &&
      !/^\d+$/.test(word)
    );
  
  // Get unique words, sorted by frequency
  const wordFreq = new Map<string, number>();
  words.forEach(word => {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  });
  
  return Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * Calculate confidence score (0-1)
 */
function calculateConfidence(
  text: string,
  language: PromptAnalysis['language'],
  taskType: PromptAnalysis['taskType'],
  reasons: string[]
): number {
  let confidence = 0.5; // Base confidence
  
  // Boost confidence based on detection signals
  if (language !== 'unknown') confidence += 0.2;
  if (taskType !== 'general') confidence += 0.15;
  if (reasons.length >= 3) confidence += 0.1;
  if (reasons.length >= 5) confidence += 0.05;
  
  // Boost for file extensions (very strong signal)
  if (reasons.some(r => r.includes('File extension'))) {
    confidence += 0.2;
  }
  
  // Boost for framework detection
  if (reasons.some(r => r.includes('Framework detected'))) {
    confidence += 0.1;
  }
  
  // Penalize very short prompts
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 10) {
    confidence -= 0.15;
  }
  
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Utility: Check if prompt is asking for a specific language
 */
export function hasExplicitLanguageRequest(prompt: string): {
  hasRequest: boolean;
  language?: string;
} {
  const text = prompt.toLowerCase();
  
  const explicitPatterns = [
    { lang: 'python', pattern: /\b(in python|using python|python code|write python)\b/ },
    { lang: 'javascript', pattern: /\b(in javascript|using javascript|javascript code|write javascript|in js)\b/ },
    { lang: 'typescript', pattern: /\b(in typescript|using typescript|typescript code|write typescript|in ts)\b/ },
    { lang: 'rust', pattern: /\b(in rust|using rust|rust code|write rust)\b/ },
    { lang: 'go', pattern: /\b(in go|using go|go code|write go|in golang)\b/ }
  ];
  
  for (const { lang, pattern } of explicitPatterns) {
    if (pattern.test(text)) {
      return { hasRequest: true, language: lang };
    }
  }
  
  return { hasRequest: false };
}

/**
 * Utility: Get human-readable summary of analysis
 */
export function getAnalysisSummary(analysis: PromptAnalysis): string {
  const parts = [
    `Language: ${analysis.language}`,
    `Task: ${analysis.taskType}`,
    analysis.framework ? `Framework: ${analysis.framework}` : null,
    `Complexity: ${analysis.complexity}`,
    `Confidence: ${Math.round(analysis.confidence * 100)}%`
  ].filter(Boolean);
  
  return parts.join(' | ');
}
