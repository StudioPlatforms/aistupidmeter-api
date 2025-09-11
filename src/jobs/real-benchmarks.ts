import dotenv from 'dotenv';
// Load environment variables for standalone execution
dotenv.config({ path: '/root/.env' });

import {
  OpenAIAdapter,
  XAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  Provider,
  ChatRequest,
  LLMAdapter
} from '../llm/adapters';
import { db } from '../db/index';
import { models, scores, runs, metrics, tasks as tasksTable } from '../db/schema';
import { desc, eq, and, gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import * as crypto from 'crypto';

// Import streaming function for detailed user logs
let emitBenchmarkProgress: ((sessionId: string, data: any) => void) | null = null;
try {
  const streamModule = require('../routes/test-adapters-stream');
  emitBenchmarkProgress = streamModule.emitBenchmarkProgress;
} catch {
  // Streaming not available - will be null for regular benchmarks
}

// ---------- Config ----------
const TRIALS = 3;                    // Reduced trials for efficiency
const SLEEP_MS_RANGE = [200, 400];   // jitter between trials
const EFF_REF_MS = 1000;             // efficiency reference latency (tightened)
const MIN_HISTORY_FOR_BASELINE = 10; // Minimum historical scores needed for baseline
const STD_EPS = 1e-6;                // avoid div-by-zero

const AXIS_WEIGHTS = {
  correctness: 0.35,
  complexity: 0.20,    // Changed from spec to complexity
  codeQuality: 0.15,
  efficiency: 0.10,
  stability: 0.10,
  edgeCases: 0.05,     // Changed from refusal
  debugging: 0.05      // Changed from recovery
} as const;

type AxisKey = keyof typeof AXIS_WEIGHTS;

// ---------- Helpers ----------
function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function stdev(nums: number[]): number {
  if (!nums.length) return 0;
  const m = nums.reduce((s, n) => s + n, 0) / nums.length;
  const v = nums.reduce((s, n) => s + (n - m) ** 2, 0) / nums.length;
  return Math.sqrt(v);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

// --- Robust extraction of Python code from LLM output ---
function extractPython(raw: string, expectedSymbol: string): string {
  if (!raw) return "";

  // Normalizări rapide
  let s = raw.replace(/\r\n/g, "\n").trim();

  // 1) Preferă cel mai lung bloc ```python ... ```
  const codeBlockRegex = /```(?:python|py)?\s*([\s\S]*?)```/gi;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = codeBlockRegex.exec(s)) !== null) {
    const body = m[1].trim();
    if (!best || body.length > best.length) best = body;
  }
  if (best) s = best;

  // 2) Dacă încă mai e text, taie tot ce e înainte de primul def/class
  if (!/^(\s*def |\s*class )/m.test(s)) {
    const idx = s.search(/^\s*(def|class)\s+/m);
    if (idx > -1) s = s.slice(idx);
  }

  // 3) Elimină eventuale rânduri cu backticks rămase
  s = s.replace(/^\s*```.*$/gm, "").trim();

  // 4) Înlătură prefixe tip „Here is the function:" pe linii singulare
  s = s
    .split("\n")
    .filter(line => !/^(here is|solution|function|code)\b/i.test(line.trim()))
    .join("\n")
    .trim();

  // 5) Dacă există mai multe definiții, păstrăm tot (poate conține helper-e),
  // dar verificăm că include simbolul așteptat (nu-l forțăm să îl redenumească).
  if (!new RegExp(`\\b(def|class)\\s+${expectedSymbol}\\b`).test(s)) {
    // Lăsăm totuși codul — runner-ul va raporta clar lipsa simbolului
  }

  return s;
}

// Hash function for code deduplication
function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim()).digest('hex').slice(0, 16);
}

async function withBackoff<T>(fn: () => Promise<T>, maxTries = 3): Promise<T | null> {
  let t = 0;
  while (true) {
    try { return await fn(); }
    catch (e: any) {
      const status = e?.status || e?.response?.status;
      if (t >= maxTries) {
        console.log(`⚠️ API call failed after ${maxTries} attempts: ${e?.message}`);
        return null; // Return null instead of throwing
      }
      if (status === 429 || (status >= 500 && status < 600)) {
        await sleep(Math.min(8000, 500 * 2 ** t) + jitter(0, 200));
        t++;
      } else {
        console.log(`⚠️ API error (non-retryable): ${e?.message}`);
        return null;
      }
    }
  }
}

// ---------- Enhanced Benchmark Tasks ----------
export const BENCHMARK_TASKS = [
  // Easy tasks (baseline capability check)
  {
    id: 'is_palindrome',
    slug: 'py/is_palindrome',
    difficulty: 'easy',
    prompt: 'Write a Python function named is_palindrome that checks if a string is a palindrome (ignoring spaces and case).',
    expectedCode: 'is_palindrome',
    maxTokens: 300,
    testCases: [
      { input: '"racecar"', expected: 'True' },
      { input: '"A man a plan a canal Panama"', expected: 'True' },
      { input: '"hello"', expected: 'False' },
      { input: '""', expected: 'True' }
    ]
  },
  {
    id: 'prime_check',
    slug: 'py/prime_check',
    difficulty: 'easy',
    prompt: 'Write a Python function named is_prime that efficiently checks if a number is prime.',
    expectedCode: 'is_prime',
    maxTokens: 400,
    testCases: [
      { input: '2', expected: 'True' },
      { input: '17', expected: 'True' },
      { input: '100', expected: 'False' },
      { input: '97', expected: 'True' },
      { input: '1', expected: 'False' }
    ]
  },

  // Medium tasks (algorithmic thinking)
  {
    id: 'binary_search',
    slug: 'py/binary_search',
    difficulty: 'medium',
    prompt: 'Write a Python function named binary_search that performs binary search on a sorted list. Return the index if found, -1 otherwise. The function should take two parameters: arr (sorted list) and target.',
    expectedCode: 'binary_search',
    maxTokens: 500,
    testCases: [
      { input: '[1,3,5,7,9,11], 7', expected: '3' },
      { input: '[1,2,3,4,5], 6', expected: '-1' },
      { input: '[10,20,30,40,50], 10', expected: '0' },
      { input: '[], 5', expected: '-1' }
    ]
  },
  {
    id: 'merge_intervals',
    slug: 'py/merge_intervals',
    difficulty: 'medium',
    prompt: 'Write a Python function named merge_intervals that takes a list of intervals (as [start, end] pairs) and merges overlapping intervals. Return the merged intervals sorted by start time.',
    expectedCode: 'merge_intervals',
    maxTokens: 600,
    testCases: [
      { input: '[[1,3],[2,6],[8,10],[15,18]]', expected: '[[1,6],[8,10],[15,18]]' },
      { input: '[[1,4],[4,5]]', expected: '[[1,5]]' },
      { input: '[[1,4],[2,3]]', expected: '[[1,4]]' },
      { input: '[]', expected: '[]' }
    ]
  },
  {
    id: 'lru_cache',
    slug: 'py/lru_cache',
    difficulty: 'medium',
    prompt: 'Write a Python class named LRUCache that implements a Least Recently Used cache with get(key) and put(key, value) methods. Initialize with capacity parameter.',
    expectedCode: 'LRUCache',
    maxTokens: 800,
    testCases: [
      { 
        input: 'cache = LRUCache(2); cache.put(1, 1); cache.put(2, 2); cache.get(1)',
        expected: '1'
      },
      {
        input: 'cache = LRUCache(2); cache.put(1, 1); cache.put(2, 2); cache.put(3, 3); cache.get(1)',
        expected: '-1'
      }
    ]
  },

  // Hard tasks (complex algorithms)
  {
    id: 'dijkstra',
    slug: 'py/dijkstra',
    difficulty: 'hard',
    prompt: 'Write a Python function named dijkstra that implements Dijkstra\'s shortest path algorithm. Takes a graph (adjacency dict), start node, and end node. Return shortest distance or -1 if no path exists.',
    expectedCode: 'dijkstra',
    maxTokens: 1000,
    testCases: [
      {
        input: '{"A": {"B": 1, "C": 4}, "B": {"C": 2, "D": 5}, "C": {"D": 1}, "D": {}}, "A", "D"',
        expected: '4'
      },
      {
        input: '{"A": {"B": 1}, "B": {}, "C": {}}, "A", "C"',
        expected: '-1'
      }
    ]
  },
  {
    id: 'word_break',
    slug: 'py/word_break',
    difficulty: 'hard',
    prompt: 'Write a Python function named word_break that determines if a string can be segmented into words from a given dictionary. Use dynamic programming. Return True/False.',
    expectedCode: 'word_break',
    maxTokens: 700,
    testCases: [
      { input: '"leetcode", ["leet", "code"]', expected: 'True' },
      { input: '"applepenapple", ["apple", "pen"]', expected: 'True' },
      { input: '"catsandog", ["cats", "dog", "sand", "and", "cat"]', expected: 'False' }
    ]
  },
  {
    id: 'regex_match',
    slug: 'py/regex_match',
    difficulty: 'hard',
    prompt: 'Write a Python function named regex_match that implements regular expression matching with support for "." (any char) and "*" (zero or more of preceding). Return True/False.',
    expectedCode: 'regex_match',
    maxTokens: 800,
    testCases: [
      { input: '"aa", "a"', expected: 'False' },
      { input: '"aa", "a*"', expected: 'True' },
      { input: '"ab", ".*"', expected: 'True' },
      { input: '"mississippi", "mis*is*p*."', expected: 'False' }
    ]
  },

  // Debugging tasks (fix broken code)
  {
    id: 'debug_sort',
    slug: 'py/debug_sort',
    difficulty: 'medium',
    prompt: 'Debug and fix this broken quicksort implementation:\n```python\ndef quicksort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[0]\n    left = [x for x in arr if x < pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + [pivot] + quicksort(right)\n```\nThe bug: it loses duplicate elements. Fix it.',
    expectedCode: 'quicksort',
    maxTokens: 500,
    testCases: [
      { input: '[3,1,4,1,5,9,2,6,5]', expected: '[1,1,2,3,4,5,5,6,9]' },
      { input: '[5,5,5,5]', expected: '[5,5,5,5]' },
      { input: '[]', expected: '[]' }
    ]
  },

  // Code optimization tasks
  {
    id: 'optimize_fibonacci',
    slug: 'py/optimize_fibonacci',
    difficulty: 'medium',
    prompt: 'Write an optimized Python function named fibonacci that returns the nth Fibonacci number. Must handle n up to 10000 efficiently (no recursion, use memoization or iteration).',
    expectedCode: 'fibonacci',
    maxTokens: 400,
    testCases: [
      { input: '0', expected: '0' },
      { input: '10', expected: '55' },
      { input: '50', expected: '12586269025' },
      { input: '100', expected: '354224848179261915075' }
    ]
  }
];

// ---------- Provider adapter ----------
function getAdapter(provider: Provider): LLMAdapter | null {
  const apiKeys = {
    openai: process.env.OPENAI_API_KEY,
    xai: process.env.XAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  };
  const key = apiKeys[provider as keyof typeof apiKeys];
  if (!key || key.startsWith('your_')) return null;
  switch (provider) {
    case 'openai': return new OpenAIAdapter(key);
    case 'xai': return new XAIAdapter(key);
    case 'anthropic': return new AnthropicAdapter(key);
    case 'google': return new GoogleAdapter(key);
    default: return null;
  }
}

// ---------- Enhanced code evaluation ----------
async function evaluateCode(code: string, task: typeof BENCHMARK_TASKS[0]): Promise<{
  correctness: number; complexity: number; codeQuality: number; edgeCases: number; debugging: number;
}> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const fs = require('fs').promises;
  const path = require('path');
  const os = require('os');
  const execAsync = promisify(exec);

  // 0) Curățare robustă
  let clean = extractPython(code, task.expectedCode);

  // 1) Complexitate (verificăm că simbolul există și codul e parsabil)
  let complexity = 0;
  try {
    const checkScript = `
import ast, sys, json
p = sys.argv[1]
src = open(p).read()
ok = {"found":0,"syntax":0}
try:
    tree = ast.parse(src)
    ok["syntax"] = 1
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "${task.expectedCode}":
            ok["found"] = 1
            break
        elif isinstance(node, ast.ClassDef) and node.name == "${task.expectedCode}":
            ok["found"] = 1
            break
except Exception:
    pass
print(json.dumps(ok))
`.trim();

    const tmpDir = os.tmpdir();
    const solPath = path.join(tmpDir, `sol_${Date.now()}.py`);
    const checkPath = path.join(tmpDir, `chk_${Date.now()}.py`);
    await fs.writeFile(solPath, clean || "# empty");
    await fs.writeFile(checkPath, checkScript);
    const { stdout } = await execAsync(`python3 -I ${checkPath} ${solPath}`, { timeout: 2000 });
    const ok = JSON.parse(stdout.trim());
    if (ok.syntax && ok.found) {
      const complexityScores = { easy: 0.3, medium: 0.6, hard: 0.9 } as const;
      complexity = complexityScores[task.difficulty as keyof typeof complexityScores] ?? 0.5;
    }
    await fs.unlink(checkPath).catch(()=>{});
    await fs.unlink(solPath).catch(()=>{});
  } catch {
    // lăsăm complexity=0
  }

  // 2) Stricter codeQuality
  let codeQuality = 0;

  // basic sanity (parsable length)
  if (clean.length >= 20 && clean.length <= 2000) codeQuality += 0.20;

  // no obviously dangerous/banned calls
  if (!/exec|eval|__import__|os\.|subprocess\.|socket\.|urllib\.|requests\.|ftplib|smtplib/.test(clean)) codeQuality += 0.20;

  // idiomatic structure (defs/conditionals/loops present)
  if (/(^|\n)\s*(def|class)\s+/.test(clean)) codeQuality += 0.10;
  if (/\b(if|for|while)\b/.test(clean)) codeQuality += 0.10;

  // light style signals
  if (/^""".+?"""|^'''.+?'''/ms.test(clean)) codeQuality += 0.10;  // docstring
  if (/->\s*[A-Za-z_][A-Za-z0-9_\[\], ]*/.test(clean)) codeQuality += 0.05; // return type hint
  if (/\w+\s*:\s*[A-Za-z_][A-Za-z0-9_\[\], ]*/.test(clean)) codeQuality += 0.05; // arg hints
  if (/#[^\n]{5,}/.test(clean)) codeQuality += 0.05; // at least one non-trivial comment
  if (/return\s+/.test(clean)) codeQuality += 0.05;

  // small penalties
  if (/(global\s|lambda\s)/.test(clean)) codeQuality -= 0.05;
  if (clean.length > 2500) codeQuality -= 0.05;

  codeQuality = Math.max(0, Math.min(0.75, codeQuality));

  // 3) Runner izolat și tolerant la erori din soluție
  const runnerPath = path.join(os.tmpdir(), `run_${Date.now()}.py`);
  // ⚠️ mărim RAM la 512MB și nu mai blocăm 'sys'
  const runnerScript = `
import resource, signal, sys, builtins, ast
resource.setrlimit(resource.RLIMIT_CPU, (2,2))
resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024,512*1024*1024))
def timeout_handler(sig,frame): sys.exit(124)
signal.signal(signal.SIGALRM, timeout_handler); signal.alarm(5)

orig_import = builtins.__import__
def safe_import(name, *args, **kwargs):
    banned = {'os','subprocess','socket','urllib','requests','http','ftplib','smtplib','shutil','pathlib'}
    if name in banned:
        raise ImportError(f"Import '{name}' blocked")
    return orig_import(name, *args, **kwargs)
builtins.__import__ = safe_import

orig_open = builtins.open
def safe_open(file, mode='r', *args, **kwargs):
    # interzice scrierea și căi absolute (dar permite /tmp pentru runner)
    if 'w' in mode or 'a' in mode or '+' in mode: 
        raise PermissionError("File write blocked")
    if isinstance(file, str) and file.startswith(('/', '\\\\')):
        # Allow reading from /tmp/ for our test files
        if not (file.startswith('/tmp/') and 'r' in mode):
            raise PermissionError("Absolute paths blocked")
    return orig_open(file, mode, *args, **kwargs)
builtins.open = safe_open

sol_path = sys.argv[1]
src = open(sol_path).read().replace('\\r\\n','\\n')

ns = {}
ok_compile = 1
try:
    codeobj = compile(src, '<solution>', 'exec')
    exec(codeobj, ns, ns)
except Exception as e:
    ok_compile = 0

passed_count = 0
total_tests = 0

def call_fn(fn_name, args):
    fn = ns.get(fn_name)
    if not callable(fn):
        raise NameError('missing ' + fn_name)
    return fn(*args)

# === TESTS WILL BE INJECTED HERE ===
`.trim();

  // 4) Construim testele în runner
  let tests = "\n";
  if (task.id === 'lru_cache') {
    tests += `
total_tests += 2
try:
    C = ns.get("LRUCache")
    if C is None: raise NameError("missing LRUCache")
    cache = C(2)
    cache.put(1, 1)
    cache.put(2, 2)
    r1 = cache.get(1)
    if r1 == 1: passed_count += 1
    cache.put(3, 3)
    r2 = cache.get(2)
    if r2 == -1: passed_count += 1
except Exception:
    pass
`;
  } else {
    for (const tc of task.testCases) {
      // args: folosim literal_eval pe un tuple "(<tc.input>,)"
      tests += `
total_tests += 1
try:
    args = ast.literal_eval("(" + ${JSON.stringify(tc.input)} + ",)")
    result = call_fn(${JSON.stringify(task.expectedCode)}, args)
    expected = ast.literal_eval(${JSON.stringify(tc.expected)})
    if result == expected:
        passed_count += 1
except Exception:
    pass
`;
    }
  }
  tests += `\nprint(f"{passed_count}/{total_tests}")\n`;

  await fs.writeFile(runnerPath, runnerScript + tests);

  // 5) Rulează și măsoară
  let correctness = 0;
  let edgeCases = 0;
  try {
    const solPath = path.join(os.tmpdir(), `sol_${Date.now()}.py`);
    await fs.writeFile(solPath, clean || "# empty");
    const { stdout } = await execAsync(`python3 -I ${runnerPath} ${solPath}`, { timeout: 6000 });
    const [p, t] = (stdout?.trim().split('/') ?? ["0","1"]).map(Number);
    correctness = Math.max(0, Math.min(1, (p || 0) / (t || 1)));
    edgeCases = correctness > 0.7 ? correctness : correctness * 0.5;
    await fs.unlink(solPath).catch(()=>{});
  } catch (e) {
    console.log(`[EVAL] ${task.id}: compilation/run failed. Error: ${e}`);
    console.log(`[EVAL] ${task.id}: First 120 chars:`, (clean || '').slice(0,120));
    correctness = 0;
    edgeCases = 0;
  } finally {
    await fs.unlink(runnerPath).catch(()=>{});
  }

  // Stricter edgeCases calculation
  edgeCases = Math.max(0, Math.min(1,
    0.8 * correctness + 0.2 * (correctness > 0.95 ? 1 : correctness * 0.5)
  ));

  const debugging = task.id.includes('debug') ? correctness : Math.min(correctness + 0.05, 1);
  return { correctness, complexity, codeQuality, edgeCases, debugging };
}

// ---------- Anti-caching utilities ----------
function generateNonce(): string {
  return Math.random().toString(36).substring(2, 12);
}

function addAntiCachingNonce(prompt: string, nonce: string): string {
  // Add a no-op comment that doesn't affect task semantics
  return `${prompt}\n\n# Session: ${nonce} (ignore this comment)`;
}

function getSaltedSystemMessage(baseMessage: string, model: { name: string; vendor: Provider }): string {
  // Add salt for Gemini 2.5 to avoid request-level caching
  if (model.vendor === 'google' && model.name.includes('2.5')) {
    const salt = generateNonce();
    return `${baseMessage} [Context: ${salt}]`;
  }
  return baseMessage;
}

function getVariedSystemMessage(): string {
  const variations = [
    'You are an expert Python programmer. Provide clean, efficient, and correct Python code. Include only the requested function or class definition. No markdown formatting.',
    'You are a skilled Python developer. Write clean, working Python code. Return only the function or class requested, without markdown.',
    'You are a professional Python coder. Generate efficient, correct Python code. Provide only the requested function or class definition.',
    'You are an experienced Python programmer. Write clean, functional Python code. Include only the requested function or class, no markdown formatting.',
    'You are a Python programming expert. Create efficient, correct code. Return only the function or class definition requested.'
  ];
  return variations[Math.floor(Math.random() * variations.length)];
}

// ---------- Single trial with streaming ----------
async function runSingleBenchmarkStreaming(
  adapter: LLMAdapter,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0],
  streamingSessionId?: string,
  trialNumber?: number,
  retryAttempt: number = 0
): Promise<{
  success: boolean; latencyMs: number; code: string;
  tokensIn?: number; tokensOut?: number;
  metrics: Record<AxisKey, number>;
} | null> {
  // Helper function to emit streaming progress if sessionId is provided
  const streamLog = (type: string, message: string, data?: any) => {
    if (streamingSessionId && emitBenchmarkProgress) {
      emitBenchmarkProgress(streamingSessionId, { type, message, data });
    }
  };

  const maxRetries = 2; // Allow up to 2 retries per trial

  try {
    // Enhanced token limits and parameters for different model types
    let maxTokens = task.maxTokens;
    let temperature = 0.1;
    let reasoning_effort: string | undefined = undefined;
    
    // Smart retry strategy: modify parameters based on retry attempt
    if (retryAttempt > 0) {
      // Retry 1: Increase token limit significantly
      if (retryAttempt === 1) {
        maxTokens = Math.max(task.maxTokens * 3, 1500);
        streamLog('info', `      🔧 Retry ${retryAttempt}: Increasing maxTokens to ${maxTokens}`);
      }
      // Retry 2: Increase token limit even more and adjust temperature
      else if (retryAttempt === 2) {
        maxTokens = Math.max(task.maxTokens * 4, 2000);
        temperature = 0.2; // Slightly higher temperature for more variety
        streamLog('info', `      🔧 Retry ${retryAttempt}: Increasing maxTokens to ${maxTokens}, temperature to ${temperature}`);
      }
    }
    
    if (model.vendor === 'openai') {
      if (/^gpt-5/.test(model.name)) {
        // GPT-5 needs much higher token limits due to reasoning consumption
        maxTokens = Math.max(8000, maxTokens * 6);
        reasoning_effort = 'low'; // Use low reasoning effort for faster, more reliable results
      } else if (/^o\d|^o-mini|^o-/.test(model.name)) {
        // o-series models also need higher limits but not as much as GPT-5
        maxTokens = Math.max(2000, maxTokens * 3);
        reasoning_effort = 'medium';
      }
    }

    // ANTI-CACHING: Generate unique identifiers for this request
    const sessionNonce = generateNonce();
    const trialId = `T${trialNumber || 1}_R${retryAttempt}_${Date.now().toString(36)}`;
    
    // ANTI-CACHING: Create varied system message with salt for Gemini 2.5
    // Use different system message variations on retries
    let baseSystemMessage = getVariedSystemMessage();
    if (retryAttempt > 0) {
      const retrySystemMessages = [
        'You are a helpful Python programming assistant. Write clean, working code. Return only the requested function or class.',
        'Write Python code only. Provide the complete, working function or class as requested. No explanations needed.',
        'Generate correct Python code. Return the function or class definition requested. Keep it simple and functional.',
        'Create Python code that works. Write only the requested function or class. Make it concise but complete.'
      ];
      baseSystemMessage = retrySystemMessages[retryAttempt % retrySystemMessages.length];
      streamLog('info', `      🔧 Retry ${retryAttempt}: Using alternative system message approach`);
    }
    const systemMessage = getSaltedSystemMessage(baseSystemMessage, model);
    
    // ANTI-CACHING: Add no-op nonce to user prompt to ensure unique payload
    const enhancedPrompt = addAntiCachingNonce(task.prompt, `${sessionNonce}_${trialId}`);

    const chatRequest: ChatRequest = {
      model: model.name,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: enhancedPrompt }
      ],
      temperature,
      maxTokens
    };
    
    // Add reasoning effort for reasoning models
    if (reasoning_effort) {
      (chatRequest as any).reasoning_effort = reasoning_effort;
      streamLog('info', `      🧠 Using reasoning_effort: ${reasoning_effort}`);
    }

    // Log the exact request being sent
    streamLog('info', `      📝 Sending prompt to ${model.vendor}/${model.name}:`);
    streamLog('info', `      🎯 System: ${chatRequest.messages[0].content}`);
    streamLog('info', `      👤 User: ${chatRequest.messages[1].content}`);
    streamLog('info', `      ⚙️ Config: temp=${chatRequest.temperature}, maxTokens=${maxTokens}`);

    const t0 = Date.now();
    streamLog('info', `      ⏳ Calling API at ${new Date().toISOString()}...`);
    
    const res = await withBackoff(() => adapter.chat(chatRequest));
    const latencyMs = Date.now() - t0;
    
    streamLog('info', `      ⏱️ Response received in ${latencyMs}ms`);
    
    if (!res) {
      if (retryAttempt < maxRetries) {
        streamLog('warning', `      ⚠️ Empty response from ${model.vendor}/${model.name} - retrying in a moment...`);
        await sleep(1000 + retryAttempt * 500); // Progressive backoff
        return runSingleBenchmarkStreaming(adapter, model, task, streamingSessionId, trialNumber, retryAttempt + 1);
      }
      streamLog('error', `      ❌ Empty response from ${model.vendor}/${model.name} after ${maxRetries + 1} attempts`);
      return null;
    }
    
    if (!('text' in res) || !res.text) {
      if (retryAttempt < maxRetries) {
        streamLog('warning', `      ⚠️ No text in response from ${model.vendor}/${model.name} - trying again...`);
        await sleep(1000 + retryAttempt * 500);
        return runSingleBenchmarkStreaming(adapter, model, task, streamingSessionId, trialNumber, retryAttempt + 1);
      }
      streamLog('error', `      ❌ No text in response after ${maxRetries + 1} attempts. Keys: ${Object.keys(res).join(', ')}`);
      streamLog('error', `      📄 Response sample: ${JSON.stringify(res).slice(0, 180)}`);
      return null;
    }
    
    const code = res.text || '';
    
    // Log raw response details
    streamLog('info', `      📄 Raw response (${code.length} chars):`);
    streamLog('info', `      💬 First 300 chars: ${code.slice(0, 300)}${code.length > 300 ? '...' : ''}`);
    
    // Enhanced token usage with comprehensive fallbacks for all providers
    const tokensIn = res.tokensIn ?? 
      (res as any)?.usage?.prompt_tokens ?? 
      (res as any)?.usage?.input_tokens ?? 
      (res as any)?.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = res.tokensOut ?? 
      (res as any)?.usage?.completion_tokens ?? 
      (res as any)?.usage?.output_tokens ?? 
      (res as any)?.usageMetadata?.candidatesTokenCount ?? 0;
    
    streamLog('info', `      🔢 Token usage: ${tokensIn} in, ${tokensOut} out`);
    
    // Harden output: try to keep only Python
    streamLog('info', `      🔧 Extracting Python code for function '${task.expectedCode}'...`);
    const sanitized = extractPython(code, task.expectedCode);
    
    if (!sanitized || sanitized.length < 10) {
      if (retryAttempt < maxRetries && code.length > 0) {
        streamLog('warning', `      ⚠️ Code extraction failed, but got ${code.length} chars - retrying with different approach...`);
        await sleep(800 + retryAttempt * 400);
        return runSingleBenchmarkStreaming(adapter, model, task, streamingSessionId, trialNumber, retryAttempt + 1);
      }
      streamLog('error', `      ❌ Code extraction failed after ${retryAttempt + 1} attempts. Sanitized: ${sanitized?.length ?? 0} chars, raw: ${code.length} chars`);
      streamLog('error', `      📝 Extracted code: ${sanitized || '(empty)'}`);
      return null;
    }

    streamLog('info', `      ✅ Extracted ${sanitized.length} chars of Python code`);
    streamLog('info', `      💻 Extracted code: ${sanitized.slice(0, 200)}${sanitized.length > 200 ? '...' : ''}`);
    
    // Log code evaluation process
    streamLog('info', `      🧪 Evaluating code against ${task.testCases?.length || 0} test cases...`);
    
    const evalRes = await evaluateCode(sanitized, task);
    
    streamLog('info', `      📊 Code evaluation results:`);
    streamLog('info', `      ✓ Correctness: ${(evalRes.correctness * 100).toFixed(1)}%`);
    streamLog('info', `      🧠 Complexity: ${(evalRes.complexity * 100).toFixed(1)}%`);
    streamLog('info', `      💎 Code Quality: ${(evalRes.codeQuality * 100).toFixed(1)}%`);
    streamLog('info', `      🎯 Edge Cases: ${(evalRes.edgeCases * 100).toFixed(1)}%`);
    streamLog('info', `      🔧 Debugging: ${(evalRes.debugging * 100).toFixed(1)}%`);
    
    // Harsher efficiency calculation
    const effRaw = Math.min(1, EFF_REF_MS / Math.max(1, latencyMs));
    // concave and capped to avoid easy 1.0s
    const efficiency = Math.max(0, Math.min(0.92, Math.pow(effRaw, 0.85)));
    
    streamLog('info', `      ⚡ Efficiency: ${(efficiency * 100).toFixed(1)}% (${latencyMs}ms vs ${EFF_REF_MS}ms ref)`);
    
    // Map evaluation results to axis metrics
    const m = {
      correctness: evalRes.correctness,
      complexity: evalRes.complexity,
      codeQuality: evalRes.codeQuality,
      efficiency,
      stability: 0, // Will be calculated after trials
      edgeCases: evalRes.edgeCases,
      debugging: evalRes.debugging
    } as Record<AxisKey, number>;

    return { success: true, latencyMs, code: sanitized, tokensIn, tokensOut, metrics: m };
  } catch (e: any) {
    // Enhanced error logging with more context and smart retry logic
    const errorMsg = String(e?.message || e).slice(0, 200);
    const isRetryableError = 
      e?.status === 429 || // Rate limit
      e?.status === 503 || // Service unavailable  
      e?.status === 502 || // Bad gateway
      e?.status >= 500 ||  // Server errors
      errorMsg.toLowerCase().includes('timeout') ||
      errorMsg.toLowerCase().includes('network') ||
      errorMsg.toLowerCase().includes('connection');

    if (isRetryableError && retryAttempt < maxRetries) {
      const waitTime = Math.min(3000, 1000 + retryAttempt * 1000);
      streamLog('warning', `      ⚠️ ${errorMsg} - retrying in ${waitTime/1000}s... (attempt ${retryAttempt + 2}/${maxRetries + 1})`);
      
      // Log additional context for debugging
      if (e?.status) {
        streamLog('info', `      📡 HTTP Status: ${e.status}`);
      }
      if (e?.code) {
        streamLog('info', `      🔧 Error Code: ${e.code}`);
      }
      
      await sleep(waitTime);
      return runSingleBenchmarkStreaming(adapter, model, task, streamingSessionId, trialNumber, retryAttempt + 1);
    }
    
    // Final failure after retries
    streamLog('error', `      ❌ Trial failed after ${retryAttempt + 1} attempts: ${errorMsg}`);
    
    // Log additional context for debugging
    if (e?.status) {
      streamLog('error', `      📡 HTTP Status: ${e.status}`);
      // Specific guidance for common errors
      if (e.status === 401 || e.status === 403) {
        streamLog('error', `      🔑 This looks like an API key issue - please check your ${model.vendor.toUpperCase()} API key`);
      } else if (e.status === 429) {
        streamLog('error', `      ⏱️ Rate limit exceeded - the API is temporarily blocking requests`);
      }
    }
    if (e?.code) {
      streamLog('error', `      🔧 Error Code: ${e.code}`);
    }
    
    // Always return null for failed trials - don't let exceptions propagate
    return null;
  }
}

// ---------- Single trial ----------
async function runSingleBenchmark(
  adapter: LLMAdapter,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0]
): Promise<{
  success: boolean; latencyMs: number; code: string;
  tokensIn?: number; tokensOut?: number;
  metrics: Record<AxisKey, number>;
} | null> {
  try {
    // Enhanced token limits and parameters for different model types
    let maxTokens = task.maxTokens;
    let reasoning_effort: string | undefined = undefined;
    
    if (model.vendor === 'openai') {
      if (/^gpt-5/.test(model.name)) {
        // GPT-5 needs much higher token limits due to reasoning consumption
        maxTokens = Math.max(8000, task.maxTokens * 6);
        reasoning_effort = 'low'; // Use low reasoning effort for faster, more reliable results
      } else if (/^o\d|^o-mini|^o-/.test(model.name)) {
        // o-series models also need higher limits but not as much as GPT-5
        maxTokens = Math.max(2000, task.maxTokens * 3);
        reasoning_effort = 'medium';
      }
    }

    // ANTI-CACHING: Generate unique identifiers for this request
    const sessionNonce = generateNonce();
    const trialId = `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
    
    // ANTI-CACHING: Create varied system message with salt for Gemini 2.5
    const baseSystemMessage = getVariedSystemMessage();
    const systemMessage = getSaltedSystemMessage(baseSystemMessage, model);
    
    // ANTI-CACHING: Add no-op nonce to user prompt to ensure unique payload
    const enhancedPrompt = addAntiCachingNonce(task.prompt, `${sessionNonce}_${trialId}`);

    const chatRequest: ChatRequest = {
      model: model.name,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: enhancedPrompt }
      ],
      temperature: 0.1,  // Lower temperature for more consistent results
      maxTokens
    };
    
    // Add reasoning effort for reasoning models
    if (reasoning_effort) {
      (chatRequest as any).reasoning_effort = reasoning_effort;
    }

    const t0 = Date.now();
    const res = await withBackoff(() => adapter.chat(chatRequest));
    if (!res) {
      console.warn(`[CHAT-EMPTY] provider=${model.vendor} model=${model.name}`);
      return null;
    }
    
    if (!('text' in res) || !res.text) {
      console.warn(`[NO-TEXT] provider=${model.vendor} model=${model.name} keys=${Object.keys(res)} sample=${JSON.stringify(res).slice(0,180)}`);
      return null;
    }
    
    const latencyMs = Date.now() - t0;
    const code = res.text || '';
    
    // Harden output: try to keep only Python
    const sanitized = extractPython(code, task.expectedCode);
    if (!sanitized || sanitized.length < 10) {
      console.warn(`[SANITIZE-EMPTY] provider=${model.vendor} model=${model.name} len=${sanitized?.length ?? 0} raw_len=${code.length}`);
      return null;
    }

    const evalRes = await evaluateCode(sanitized, task);
    // Harsher efficiency calculation
    const effRaw = Math.min(1, EFF_REF_MS / Math.max(1, latencyMs));
    // concave and capped to avoid easy 1.0s
    const efficiency = Math.max(0, Math.min(0.92, Math.pow(effRaw, 0.85)));
    
    // Map evaluation results to axis metrics
    const m = {
      correctness: evalRes.correctness,
      complexity: evalRes.complexity,
      codeQuality: evalRes.codeQuality,
      efficiency,
      stability: 0, // Will be calculated after trials
      edgeCases: evalRes.edgeCases,
      debugging: evalRes.debugging
    } as Record<AxisKey, number>;

    // Enhanced token usage with comprehensive fallbacks for all providers
    const tokensIn = res.tokensIn ?? 
      (res as any)?.usage?.prompt_tokens ?? 
      (res as any)?.usage?.input_tokens ?? 
      (res as any)?.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = res.tokensOut ?? 
      (res as any)?.usage?.completion_tokens ?? 
      (res as any)?.usage?.output_tokens ?? 
      (res as any)?.usageMetadata?.candidatesTokenCount ?? 0;
    
    return { success: true, latencyMs, code: sanitized, tokensIn, tokensOut, metrics: m };
  } catch (e) {
    console.log(`⚠️ Benchmark trial failed: ${e}`);
    return null;
  }
}

// ---------- Trials per task ----------
async function runTaskWithTrials(
  adapter: LLMAdapter,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0],
  N = TRIALS
) {
  const trials: any[] = [];
  for (let i = 0; i < N; i++) {
    const result = await runSingleBenchmark(adapter, model, task);
    if (result) trials.push(result);
    await sleep(jitter(SLEEP_MS_RANGE[0], SLEEP_MS_RANGE[1]));
  }

  if (trials.length === 0) return null; // All trials failed

  const ok = trials.filter(t => t.success);
  if (ok.length === 0) return null;

  const axes: AxisKey[] = ['correctness','complexity','codeQuality','efficiency','edgeCases','debugging'];
  const med: Record<AxisKey, number> = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0, 
    stability:0, edgeCases:0, debugging:0 
  };
  
  for (const k of axes) {
    med[k] = median(ok.map(t => t.metrics[k]));
  }

  // Stability from variance across trials
  const corrSeries = trials.map(t => t.metrics.correctness ?? 0);
  const sd = stdev(corrSeries);
  med.stability = Math.max(0, Math.min(1, 1 - sd / 0.3));

  const latencyMed = median(ok.map(t => t.latencyMs));
  const tokensInMed = median(ok.map(t => t.tokensIn ?? 0));
  const tokensOutMed = median(ok.map(t => t.tokensOut ?? 0));
  const codeSample = ok[0]?.code ?? '';

  return {
    collapsed: { 
      latencyMs: latencyMed, 
      tokensIn: tokensInMed, 
      tokensOut: tokensOutMed, 
      metrics: med, 
      code: codeSample 
    },
    trials
  };
}

// ---------- Streaming version of trials per task ----------
async function runTaskWithTrialsStreaming(
  adapter: LLMAdapter,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0],
  N = TRIALS,
  streamingSessionId?: string
) {
  // Helper function to emit streaming progress if sessionId is provided
  const streamLog = (type: string, message: string, data?: any) => {
    if (streamingSessionId && emitBenchmarkProgress) {
      emitBenchmarkProgress(streamingSessionId, { type, message, data });
    }
  };

  streamLog('info', `  🔄 Running ${N} trials for ${task.id}...`);

  const trials: any[] = [];
  let consecutiveFailures = 0;
  
  for (let i = 0; i < N; i++) {
    streamLog('info', `    🎯 Trial ${i + 1}/${N}: Sending prompt to ${model.vendor}/${model.name}...`);
    
    try {
      const result = await runSingleBenchmarkStreaming(adapter, model, task, streamingSessionId, i + 1);
      if (result) {
        trials.push(result);
        consecutiveFailures = 0; // Reset failure counter on success
        streamLog('success', `    ✅ Trial ${i + 1}: ${(result.metrics.correctness * 100).toFixed(1)}% correct, ${result.latencyMs}ms`);
        streamLog('info', `    💬 Trial ${i + 1}: ${result.tokensIn} tokens in, ${result.tokensOut} tokens out`);
      } else {
        consecutiveFailures++;
        streamLog('error', `    ❌ Trial ${i + 1}: Failed (${consecutiveFailures} consecutive failures)`);
        
        // Smart backoff strategy
        if (consecutiveFailures >= 2) {
          const backoffTime = Math.min(3000, 750 * consecutiveFailures);
          streamLog('info', `    ⏸️ Multiple failures detected - backing off ${backoffTime}ms to give the API time to recover...`);
          await sleep(backoffTime);
        }
      }
    } catch (e: any) {
      // Catch any unexpected errors at the trial level
      consecutiveFailures++;
      const errorMsg = String(e?.message || e).slice(0, 100);
      streamLog('error', `    ❌ Trial ${i + 1}: Unexpected error - ${errorMsg}`);
    }
    
    if (i < N - 1) {
      const sleepTime = jitter(SLEEP_MS_RANGE[0], SLEEP_MS_RANGE[1]);
      streamLog('info', `    ⏳ Waiting ${sleepTime}ms between trials...`);
      await sleep(sleepTime);
    }
  }

  if (trials.length === 0) {
    streamLog('error', `  ❌ All ${N} trials failed for ${task.id}`);
    streamLog('info', `  🔄 Don't worry - continuing with remaining tasks. This might be a temporary issue.`);
    return null;
  }

  const ok = trials.filter(t => t.success);
  if (ok.length === 0) {
    streamLog('error', `  ❌ No successful trials for ${task.id}`);
    streamLog('info', `  🔄 Continuing with next task - some tasks are more challenging than others.`);
    return null;
  }

  // Celebrate partial success
  if (ok.length < trials.length) {
    streamLog('info', `  🎯 Got ${ok.length}/${trials.length} successful trials - that's enough to calculate reliable metrics!`);
  }

  streamLog('info', `  📊 Analyzing ${ok.length}/${trials.length} successful trials...`);

  const axes: AxisKey[] = ['correctness','complexity','codeQuality','efficiency','edgeCases','debugging'];
  const med: Record<AxisKey, number> = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0, 
    stability:0, edgeCases:0, debugging:0 
  };
  
  for (const k of axes) {
    med[k] = median(ok.map(t => t.metrics[k]));
  }

  // Stability from variance across trials - handle edge case with single trial
  const corrSeries = ok.map(t => t.metrics.correctness ?? 0);
  const sd = corrSeries.length > 1 ? stdev(corrSeries) : 0;
  med.stability = Math.max(0, Math.min(1, 1 - sd / 0.3));

  const latencyMed = median(ok.map(t => t.latencyMs));
  const tokensInMed = median(ok.map(t => t.tokensIn ?? 0));
  const tokensOutMed = median(ok.map(t => t.tokensOut ?? 0));
  const codeSample = ok[0]?.code ?? '';

  streamLog('info', `  📈 Stability calculated from variance: ${(med.stability * 100).toFixed(1)}%`);
  streamLog('info', `  ⏱️ Median latency: ${latencyMed}ms`);

  return {
    collapsed: { 
      latencyMs: latencyMed, 
      tokensIn: tokensInMed, 
      tokensOut: tokensOutMed, 
      metrics: med, 
      code: codeSample 
    },
    trials
  };
}

// ---------- New baseline system with N/A support ----------
type Axes = Record<AxisKey, number>;

async function getHistoricalBaseline(modelId: number): Promise<{ 
  hasBaseline: boolean; 
  means: Axes; 
  stds: Axes;
  sampleCount: number;
}> {
  // Get historical scores for this model
  const rows = await db.select().from(scores)
    .where(eq(scores.modelId, modelId))
    .orderBy(desc(scores.ts))
    .limit(50); // Get last 50 scores

  const validRows = rows.filter(r => 
    (r as any).axes && 
    (r as any).stupidScore !== null &&
    (r as any).stupidScore >= 0  // Exclude sentinel values (-999, -888)
  );
  
  if (validRows.length < MIN_HISTORY_FOR_BASELINE) {
    // Not enough history - return no baseline
    return { 
      hasBaseline: false,
      means: {} as Axes,
      stds: {} as Axes,
      sampleCount: validRows.length
    };
  }

  const collect: Record<AxisKey, number[]> = {
    correctness:[], complexity:[], codeQuality:[], efficiency:[], 
    stability:[], edgeCases:[], debugging:[]
  };

  for (const r of validRows as any[]) {
    const a = r.axes as any; // Type as any to handle old/new schema
    if (!a) continue;
    (Object.keys(collect) as AxisKey[]).forEach(k => {
      // Map old axis names to new ones if needed
      let value = a[k];
      if (value === undefined) {
        // Handle renamed axes from old schema
        if (k === 'complexity' && a.spec !== undefined) value = a.spec;
        if (k === 'edgeCases' && a.refusal !== undefined) value = a.refusal;
        if (k === 'debugging' && a.recovery !== undefined) value = a.recovery;
      }
      if (typeof value === 'number') collect[k].push(value);
    });
  }
  
  const means = {} as Axes;
  const stds = {} as Axes;
  
  (Object.keys(collect) as AxisKey[]).forEach(k => {
    const arr = collect[k];
    if (arr.length >= MIN_HISTORY_FOR_BASELINE) {
      means[k] = arr.reduce((s,n)=>s+n,0)/arr.length;
      stds[k] = Math.max(stdev(arr), STD_EPS);
    } else {
      // Use neutral baselines when specific axis lacks data
      means[k] = 0.5;
      stds[k] = 0.15;
    }
  });

  return { hasBaseline: true, means, stds, sampleCount: validRows.length };
}

function naiveScore(axesNow: Axes): number {
  let num = 0, den = 0;
  (Object.keys(AXIS_WEIGHTS) as AxisKey[]).forEach(k => {
    num += (axesNow[k] || 0) * AXIS_WEIGHTS[k] * 100;
    den += AXIS_WEIGHTS[k];
  });
  return Math.round(num / (den || 1));
}

function calculateScore(axesNow: Axes, baseline: {means: Axes; stds: Axes}, hasBaseline: boolean = true): number {
  // HARSH PROFESSOR MODE: Much stricter scoring that reflects reality
  let weightedSum = 0;
  let totalWeight = 0;
  
  (Object.keys(AXIS_WEIGHTS) as AxisKey[]).forEach(k => {
    let performance = axesNow[k] || 0;
    const weight = AXIS_WEIGHTS[k];
    
    // HARSH: Apply exponential decay for imperfections
    // Even small imperfections get heavily penalized
    if (performance < 1.0) {
      // Exponential penalty: 0.9 -> 0.81, 0.8 -> 0.64, etc.
      performance = Math.pow(performance, 1.8);
    }
    
    // HARSH: Additional axis-specific penalties
    if (k === 'correctness' && performance < 0.95) {
      performance *= 0.7; // Correctness is critical - big penalty
    }
    if (k === 'codeQuality' && performance < 0.8) {
      performance *= 0.6; // Poor code quality is unacceptable
    }
    
    weightedSum += performance * weight * 100;
    totalWeight += weight;
  });
  
  if (totalWeight === 0) return 0;
  
  let baseScore = weightedSum / totalWeight;
  
  // HARSH: Make base scoring much more demanding
  // Apply additional "professor curve" - shift scores down significantly
  baseScore = Math.pow(baseScore / 100, 1.4) * 100; // Power curve makes high scores much harder
  
  // HARSH: Stricter variance penalties
  let varianceAdjustment = 0;
  if (hasBaseline && baseline.means.correctness !== undefined) {
    (Object.keys(AXIS_WEIGHTS) as AxisKey[]).forEach(k => {
      const deviation = (axesNow[k] || 0) - (baseline.means[k] || 0.5);
      const normalizedDev = deviation / (baseline.stds[k] || 0.15);
      varianceAdjustment += normalizedDev * AXIS_WEIGHTS[k] * 2; // Reduced impact
    });
    
    // HARSH: Larger penalty range
    varianceAdjustment = Math.max(-8, Math.min(3, varianceAdjustment)); // Easier to lose points than gain
  }
  
  let finalScore = baseScore + varianceAdjustment;
  
  // HARSH: Bigger calibration penalty for unproven models
  if (!hasBaseline) {
    finalScore -= 8; // Much bigger penalty
  }
  
  // HARSH: Comprehensive quality gates - multiple checkpoints
  const correctness = axesNow.correctness || 0;
  const codeQuality = axesNow.codeQuality || 0;
  const complexity = axesNow.complexity || 0;
  
  // Quality Gate 1: Correctness requirements
  if (correctness < 0.9) finalScore -= 15; // Major penalty for <90% correct
  if (correctness < 0.7) finalScore -= 20; // Massive penalty for <70% correct
  if (correctness < 0.5) finalScore -= 30; // Nearly failing for <50% correct
  
  // Quality Gate 2: Code quality requirements  
  if (codeQuality < 0.6) finalScore -= 10; // Penalty for poor code
  if (codeQuality < 0.4) finalScore -= 20; // Major penalty for terrible code
  
  // Quality Gate 3: Task completion requirements
  if (complexity < 0.3) finalScore -= 12; // Didn't understand the task
  
  // HARSH: "A" grade is extremely rare - 85+ should be exceptional
  if (finalScore >= 85) {
    // Must excel in ALL major categories to get 85+
    const majorAxesExcellent = correctness >= 0.95 && codeQuality >= 0.8 && complexity >= 0.7;
    if (!majorAxesExcellent) {
      finalScore = Math.min(finalScore, 82); // Cap at B+ level
    }
  }
  
  // HARSH: "A+" (90+) is nearly impossible - only for near-perfection
  if (finalScore >= 90) {
    const nearPerfect = (Object.keys(AXIS_WEIGHTS) as AxisKey[]).every(k => 
      (axesNow[k] || 0) >= 0.92
    );
    if (!nearPerfect) {
      finalScore = Math.min(finalScore, 87); // Cap well below 90
    }
  }
  
  // HARSH: Perfect scores (95+) require actual perfection
  if (finalScore >= 95) {
    const actualPerfection = (Object.keys(AXIS_WEIGHTS) as AxisKey[]).every(k => 
      (axesNow[k] || 0) >= 0.98
    );
    if (!actualPerfection) {
      finalScore = Math.min(finalScore, 89); // No perfect scores without perfection
    }
  }
  
  return Math.round(Math.max(0, Math.min(100, finalScore)));
}

// ---------- Persist results ----------
async function persistCollapsedRun(params: {
  modelId: number; taskSlug: string;
  latencyMs: number; tokensIn: number; tokensOut: number;
  axes: Axes; code?: string;
}) {
  try {
    let taskId: number | null = null;
    try {
      const t = await db.select().from(tasksTable).where(eq(tasksTable.slug, params.taskSlug)).limit(1);
      taskId = t[0]?.id ?? null;
    } catch {/* table optional */}

    const runInsert = await db.insert(runs).values({
      modelId: params.modelId,
      taskId: taskId, // Let it be null if task not found in database
      ts: new Date().toISOString(),
      temp: 0.1,
      seed: 0,
      tokensIn: Math.round(params.tokensIn ?? 0),
      tokensOut: Math.round(params.tokensOut ?? 0),
      latencyMs: Math.round(params.latencyMs),
      attempts: 1,
      passed: params.axes.correctness >= 0.5,
      artifacts: params.code ? { codeHash: hashCode(params.code) } : null
    }).returning({ id: runs.id });

    const runId = runInsert[0].id;
    
    // Store metrics with new axis names
    await db.insert(metrics).values({
      runId,
      correctness: params.axes.correctness,
      spec: params.axes.complexity,  // Map to old column name
      codeQuality: params.axes.codeQuality,
      efficiency: params.axes.efficiency,
      stability: params.axes.stability,
      refusal: params.axes.edgeCases,  // Map to old column name
      recovery: params.axes.debugging   // Map to old column name
    });

    return runId;
  } catch (e) {
    console.warn(`[PERSIST-ERROR] ${params.taskSlug}: ${String(e).slice(0,200)}`);
    return null; // Don't let persistence errors stop the batch
  }
}

// ---------- Main benchmark function ----------
export async function benchmarkModel(
  model: { id: number; name: string; vendor: Provider }, 
  batchTimestamp?: string, 
  streamingSessionId?: string
) {
  const adapter = getAdapter(model.vendor);
  
  // Helper function to emit streaming progress if sessionId is provided
  const streamLog = (type: string, message: string, data?: any) => {
    if (streamingSessionId && emitBenchmarkProgress) {
      emitBenchmarkProgress(streamingSessionId, { type, message, data });
    }
  };
  
  if (!adapter) {
    // No API key - record N/A with sentinel values
    await db.insert(scores).values({
      modelId: model.id,
      ts: batchTimestamp || new Date().toISOString(),
      stupidScore: -999,  // Sentinel value indicates N/A
      axes: { correctness: -1, complexity: -1, codeQuality: -1, efficiency: -1, stability: -1, edgeCases: -1, debugging: -1 },
      cusum: 0.0,
      note: `N/A - ${model.vendor} API not configured`
    });
    console.log(`⚠️ ${model.name}: N/A (no ${model.vendor} API key)`);
    return;
  }

  // Enhanced canary test for quick adapter validation with model-specific prompts
  try {
    let canaryRequest: any;
    
    // GPT-5 and o-series models need explicit questions and higher token limits
    if (model.vendor === 'openai' && /^(gpt-5|o\d|o-mini|o-)/.test(model.name)) {
      canaryRequest = {
        model: model.name,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Provide only the answer requested.' },
          { role: 'user', content: 'What is 2 + 2? Answer with just the number.' }
        ],
        temperature: 0.1,
        maxTokens: /^gpt-5/.test(model.name) ? 8000 : 100, // Higher limit for GPT-5
        reasoning_effort: 'low' // Use minimal reasoning for canary
      };
    } else if (model.vendor === 'google' && model.name.includes('gemini-2.5')) {
      // Gemini 2.5 needs unique prompts to avoid deduplication
      const uniqueId = Math.random().toString(36).slice(2, 8);
      canaryRequest = {
        model: model.name,
        messages: [
          { role: 'system', content: 'Write only Python code.' },
          { role: 'user', content: `Write a Python function that returns the number 7. Task ID: ${uniqueId}` }
        ],
        temperature: 0.1,
        maxTokens: 128
      };
    } else {
      // Standard canary for other models
      canaryRequest = {
        model: model.name,
        messages: [
          { role: 'system', content: 'Return only Python code, no prose.' },
          { role: 'user', content: 'def test(): return 5' }
        ],
        temperature: 0,
        maxTokens: 64
      };
    }
    
    // Use withBackoff for canary test to handle 503 errors gracefully
    let ping = await withBackoff(() => adapter.chat(canaryRequest));
    let sanitized = (ping?.text ?? '').trim();
    
    // Additional retry for Gemini 2.5 models if still empty
    if (!sanitized && model.vendor === 'google' && model.name.includes('gemini-2.5')) {
      console.log(`[CANARY-RETRY] ${model.name}: First canary empty, retrying...`);
      const retryId = Math.random().toString(36).slice(2, 8);
      const retryRequest: any = {
        model: model.name,
        messages: [
          { role: 'user', content: `Simple task: Write "hello world" in Python. ID: ${retryId}` }
        ],
        temperature: 0.2,
        maxTokens: 64
      };
      ping = await withBackoff(() => adapter.chat(retryRequest));
      sanitized = (ping?.text ?? '').trim();
    }
    
    // Additional retry for GPT-5 models if still empty  
    if (!sanitized && model.vendor === 'openai' && /^gpt-5/.test(model.name)) {
      console.log(`[CANARY-RETRY] ${model.name}: First canary empty, retrying with simpler prompt...`);
      const retryRequest: any = {
        model: model.name,
        messages: [
          { role: 'user', content: 'Say "hello"' }
        ],
        temperature: 0.1,
        maxTokens: 8000,
        reasoning_effort: 'minimal'
      };
      ping = await withBackoff(() => adapter.chat(retryRequest));
      sanitized = (ping?.text ?? '').trim();
    }
    
    if (!ping || !sanitized) throw new Error('canary test failed after retries');
  } catch (e) {
    console.warn(`[CANARY-FAIL] ${model.vendor}/${model.name}: ${String(e).slice(0,200)}`);
    // Record N/A with adapter failure sentinel
    await db.insert(scores).values({
      modelId: model.id,
      ts: batchTimestamp || new Date().toISOString(),
      stupidScore: -777,  // Sentinel value for adapter failures
      axes: { correctness: -1, complexity: -1, codeQuality: -1, efficiency: -1, stability: -1, edgeCases: -1, debugging: -1 },
      cusum: 0.0,
      note: `N/A - Adapter validation failed: ${String(e).slice(0,100)}`
    });
    console.log(`❌ ${model.name}: N/A (adapter validation failed)`);
    return;
  }

  // Randomly select subset of tasks for variety
  const taskCount = Math.min(7, BENCHMARK_TASKS.length);
  const selectedTasks = [...BENCHMARK_TASKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, taskCount);

  // Log task selection for streaming users
  streamLog('info', `📝 Selected ${selectedTasks.length} benchmark tasks from ${BENCHMARK_TASKS.length} total`);
  streamLog('info', `🎯 Tasks: ${selectedTasks.map(t => `${t.id} (${t.difficulty})`).join(', ')}`);

  const perTaskAxes: Axes[] = [];
  let latencies: number[] = [];
  let failedTasks: typeof BENCHMARK_TASKS[0][] = []; // Track which tasks failed

  // Phase 1: Initial benchmark run
  streamLog('info', `🎯 Phase 1: Running initial benchmark on all ${selectedTasks.length} tasks`);
  
  for (let taskIndex = 0; taskIndex < selectedTasks.length; taskIndex++) {
    const task = selectedTasks[taskIndex];
    
    streamLog('info', `\n🧪 Task ${taskIndex + 1}/${selectedTasks.length}: ${task.id} (${task.difficulty})`);
    streamLog('info', `📄 Prompt: ${task.prompt.slice(0, 150)}${task.prompt.length > 150 ? '...' : ''}`);
    streamLog('info', `🎯 Expected function/class: ${task.expectedCode}`);
    
    try {
      const result = await runTaskWithTrialsStreaming(adapter, model, task, TRIALS, streamingSessionId);
      if (!result) {
        streamLog('warning', `⚠️ Task ${task.id} failed all ${TRIALS} trials - adding to retry list`);
        streamLog('info', `📊 Progress: ${perTaskAxes.length} completed, ${failedTasks.length + 1} failed so far. Moving to next task...`);
        failedTasks.push(task);
        continue;
      }
    
      // Log task completion with detailed metrics
      const metrics = result.collapsed.metrics;
      streamLog('success', `✅ Task ${task.id} completed: ${(metrics.correctness * 100).toFixed(1)}% correct, ${result.collapsed.latencyMs}ms avg`);
      streamLog('info', `  📊 Metrics: correctness=${(metrics.correctness*100).toFixed(1)}%, complexity=${(metrics.complexity*100).toFixed(1)}%, quality=${(metrics.codeQuality*100).toFixed(1)}%`);
      streamLog('info', `  💬 Tokens: ${result.collapsed.tokensIn} in, ${result.collapsed.tokensOut} out`);
      
      // Show a snippet of the generated code
      if (result.collapsed.code) {
        const codeSnippet = result.collapsed.code.slice(0, 200);
        streamLog('info', `  💻 Generated code preview: ${codeSnippet}${result.collapsed.code.length > 200 ? '...' : ''}`);
      }
      
      perTaskAxes.push(result.collapsed.metrics);
      latencies.push(result.collapsed.latencyMs);
      
      // Persist run data
      try {
        await persistCollapsedRun({
          modelId: model.id,
          taskSlug: task.slug,
          latencyMs: result.collapsed.latencyMs,
          tokensIn: result.collapsed.tokensIn,
          tokensOut: result.collapsed.tokensOut,
          axes: result.collapsed.metrics,
          code: result.collapsed.code   // Use sanitized code for dedup
        });
        
        streamLog('info', `💾 Results saved to database for task ${task.id}`);
      } catch (persistError) {
        streamLog('error', `⚠️ Failed to save results for task ${task.id}: ${String(persistError).slice(0, 100)}`);
        // Continue anyway - don't let persistence errors stop the benchmark
      }
    } catch (taskError: any) {
      // Catch any unexpected errors at the task level
      const errorMsg = String(taskError?.message || taskError).slice(0, 200);
      streamLog('error', `❌ Task ${task.id} failed with unexpected error: ${errorMsg}`);
      streamLog('info', `📊 Adding to retry list. Progress: ${perTaskAxes.length} completed, ${failedTasks.length + 1} failed so far.`);
      failedTasks.push(task);
      // Continue with next task
    }
  }

  // Phase 2: Retry failed tasks with enhanced parameters
  if (failedTasks.length > 0 && perTaskAxes.length > 0) {
    streamLog('info', `\n🔄 Phase 2: Retrying ${failedTasks.length} failed tasks with enhanced parameters`);
    streamLog('info', `💡 Using higher token limits, different temperatures, and alternative prompting strategies`);
    
    for (let retryIndex = 0; retryIndex < failedTasks.length; retryIndex++) {
      const task = failedTasks[retryIndex];
      
      streamLog('info', `\n🔄 Retry ${retryIndex + 1}/${failedTasks.length}: ${task.id} (${task.difficulty}) with enhanced parameters`);
      
      try {
        // Create enhanced version of the task with modified parameters for difficult models
        const enhancedTask = {
          ...task,
          maxTokens: Math.max(task.maxTokens * 4, 2000), // Much higher token limit
          prompt: task.prompt + "\n\nIMPORTANT: Provide a complete, working solution. Do not explain or add commentary - just the code."
        };
        
        const result = await runTaskWithTrialsStreaming(adapter, model, enhancedTask, 2, streamingSessionId); // Fewer trials but enhanced
        if (result) {
          const metrics = result.collapsed.metrics;
          streamLog('success', `✅ Retry success! Task ${task.id}: ${(metrics.correctness * 100).toFixed(1)}% correct, ${result.collapsed.latencyMs}ms avg`);
          streamLog('info', `  📊 Enhanced metrics: correctness=${(metrics.correctness*100).toFixed(1)}%, quality=${(metrics.codeQuality*100).toFixed(1)}%`);
          
          perTaskAxes.push(result.collapsed.metrics);
          latencies.push(result.collapsed.latencyMs);
          
          // Persist run data
          try {
            await persistCollapsedRun({
              modelId: model.id,
              taskSlug: task.slug,
              latencyMs: result.collapsed.latencyMs,
              tokensIn: result.collapsed.tokensIn,
              tokensOut: result.collapsed.tokensOut,
              axes: result.collapsed.metrics,
              code: result.collapsed.code
            });
            
            streamLog('info', `💾 Retry results saved to database for task ${task.id}`);
          } catch (persistError) {
            streamLog('error', `⚠️ Failed to save retry results for task ${task.id}: ${String(persistError).slice(0, 100)}`);
          }
          
          // Remove from failed list since it succeeded
          failedTasks.splice(failedTasks.indexOf(task), 1);
          retryIndex--; // Adjust index since we removed an item
        } else {
          streamLog('info', `⚠️ Task ${task.id} still failed after enhanced retry - will calculate score without it`);
        }
      } catch (retryError: any) {
        const errorMsg = String(retryError?.message || retryError).slice(0, 200);
        streamLog('info', `⚠️ Task ${task.id} retry failed: ${errorMsg} - will calculate score without it`);
      }
    }
  }

  // Provide comprehensive summary
  const totalTasks = selectedTasks.length;
  const successfulTasks = perTaskAxes.length;
  const successRate = successfulTasks / totalTasks;

  if (successfulTasks > 0) {
    streamLog('success', `\n🎉 Benchmark completed! Results summary:`);
    streamLog('success', `📊 Tasks completed: ${successfulTasks}/${totalTasks} (${Math.round(successRate * 100)}%)`);
    if (failedTasks.length > 0) {
      streamLog('info', `⚠️ ${failedTasks.length} tasks encountered issues, but we got enough data to calculate your score!`);
    }
    streamLog('info', `🔄 Calculating final score based on successful completions...`);
  }

  // If all tasks failed, record N/A with sentinel values
  if (perTaskAxes.length === 0) {
    streamLog('error', `❌ Unfortunately, all ${totalTasks} tasks failed. This might indicate an API issue.`);
    streamLog('info', `💡 Suggestions: Check your API key, try again in a moment, or try a different model.`);
    await db.insert(scores).values({
      modelId: model.id,
      ts: batchTimestamp || new Date().toISOString(),
      stupidScore: -888,  // Different sentinel value for task failures
      axes: { correctness: -1, complexity: -1, codeQuality: -1, efficiency: -1, stability: -1, edgeCases: -1, debugging: -1 },
      cusum: 0.0,
      note: `N/A - All benchmark tasks failed`
    });
    console.log(`❌ ${model.name}: N/A (all tasks failed)`);
    return;
  }

  // Aggregate metrics across successful tasks
  const agg: Axes = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0,
    stability:0, edgeCases:0, debugging:0 
  };
  
  (Object.keys(agg) as AxisKey[]).forEach(k => {
    agg[k] = perTaskAxes.length
      ? perTaskAxes.reduce((s,a) => s + (a[k] ?? 0), 0) / perTaskAxes.length
      : 0;
  });

  // Apply stability soft-ceiling to reduce perfects
  function clampAxesForScore(a: Axes): Axes {
    return {
      ...a,
      stability: Math.min(a.stability, 0.95) // tiny soft-ceiling
    };
  }

  // Get baseline and calculate score
  const baseline = await getHistoricalBaseline(model.id);
  const taskSuccessRate = perTaskAxes.length / selectedTasks.length; // 0..1
  
  let finalScore: number;
  let note: string | null = null;

  if (!baseline.hasBaseline) {
    // Use calculateScore with hasBaseline=false for calibration penalty
    finalScore = calculateScore(clampAxesForScore(agg), baseline, false);
    // Small extra penalty while calibrating
    finalScore -= 2;
    note = `Calibrating (${baseline.sampleCount}/${MIN_HISTORY_FOR_BASELINE} samples)`;
  } else {
    finalScore = calculateScore(clampAxesForScore(agg), baseline, true);
  }

  // Apply failure penalty (up to -12 for total failure, ~ -3 for 75% success)
  const failurePenalty = Math.round((1 - taskSuccessRate) * 12);
  finalScore = Math.max(0, finalScore - failurePenalty);

  if (failedTasks.length > 0) {
    const successPct = Math.round(taskSuccessRate * 100);
    note = `${successPct}% tasks completed (${failedTasks.length} failed)`;
  }

  // Save score (finalScore is always a number now)
  await db.insert(scores).values({
    modelId: model.id,
    ts: batchTimestamp || new Date().toISOString(),
    stupidScore: finalScore,
    axes: agg,
    cusum: 0.0,
    note
  });

  // Logging
  const lat = Math.round(median(latencies));
  if (finalScore !== null) {
    console.log(`✅ ${model.name}: score=${finalScore} | corr=${(agg.correctness*100).toFixed(1)}% | lat~${lat}ms${note ? ' | ' + note : ''}`);
  } else {
    console.log(`🔄 ${model.name}: ${note} | corr=${(agg.correctness*100).toFixed(1)}% | lat~${lat}ms`);
  }
}

// ---------- Entry point ----------
export async function runRealBenchmarks() {
  console.log('🚀 Starting enhanced benchmark sweep with challenging tasks...');
  try {
    const allModels = await db.select().from(models);
    
    // Create synchronized timestamp for batch
    const batchTimestamp = new Date().toISOString();
    console.log(`📅 Batch timestamp: ${batchTimestamp}`);
    console.log(`📝 Running ${BENCHMARK_TASKS.length} diverse benchmark tasks`);
    
    // Randomize the order of models for each benchmark run
    const shuffledModels = [...allModels as any[]].sort(() => Math.random() - 0.5);
    
    // Group by provider for rate limit management
    const modelsByProvider: Record<string, any[]> = {};
    for (const model of shuffledModels) {
      const provider = model.vendor;
      if (!modelsByProvider[provider]) {
        modelsByProvider[provider] = [];
      }
      modelsByProvider[provider].push({ 
        id: model.id, 
        name: model.name, 
        vendor: model.vendor as Provider 
      });
    }

    // Shuffle the provider order as well
    const providerEntries = Object.entries(modelsByProvider).sort(() => Math.random() - 0.5);

    // Track failed models for retry at the end
    const failedModels: Array<{ id: number; name: string; vendor: Provider; reason: string }> = [];

    // Phase 1: Initial benchmark run for all models
    const providerPromises = providerEntries.map(async ([provider, models]) => {
      console.log(`🔄 Benchmarking ${provider} models (${models.length} models)...`);
      
      for (const model of models) {
        try {
          await benchmarkModel(model, batchTimestamp);
          // Small delay between models from same provider
          await sleep(100);
        } catch (error: any) {
          // Track failed models for retry
          const errorMsg = String(error?.message || error).slice(0, 200);
          console.log(`⚠️ ${model.name} failed: ${errorMsg} - will retry with enhanced parameters`);
          failedModels.push({ 
            id: model.id, 
            name: model.name, 
            vendor: model.vendor as Provider, 
            reason: errorMsg 
          });
        }
      }
      
      console.log(`✅ Completed ${provider} models`);
    });

    await Promise.all(providerPromises);

    // Phase 2: Retry failed models with enhanced parameters
    if (failedModels.length > 0) {
      console.log(`\n🔄 Phase 2: Retrying ${failedModels.length} failed models with enhanced parameters...`);
      
      for (const model of failedModels) {
        try {
          console.log(`🔄 Retry: ${model.name} (failed due to: ${model.reason.slice(0, 50)}...)`);
          await benchmarkModelWithEnhancedParams(model, batchTimestamp);
          await sleep(500); // Longer delay for retries
        } catch (retryError: any) {
          console.log(`❌ ${model.name} failed again even with enhanced parameters: ${String(retryError).slice(0, 200)}`);
        }
      }
      
      console.log(`✅ Completed retry phase for failed models`);
    }

    console.log('✅ Enhanced benchmark sweep complete with realistic scoring!');
  } catch (e) {
    console.error('❌ Benchmark sweep failed:', e);
    throw e; // Re-throw so CLI doesn't claim success on failure
  }
}

// ---------- Enhanced benchmark for retry attempts ----------
async function benchmarkModelWithEnhancedParams(
  model: { id: number; name: string; vendor: Provider }, 
  batchTimestamp: string
) {
  const adapter = getAdapter(model.vendor);
  
  if (!adapter) {
    // Still no API key - record N/A
    await db.insert(scores).values({
      modelId: model.id,
      ts: batchTimestamp,
      stupidScore: -999,
      axes: { correctness: -1, complexity: -1, codeQuality: -1, efficiency: -1, stability: -1, edgeCases: -1, debugging: -1 },
      cusum: 0.0,
      note: `N/A - ${model.vendor} API not configured`
    });
    return;
  }

  // Enhanced canary test with more aggressive parameters
  try {
    let canaryRequest: any;
    
    if (model.vendor === 'openai') {
      canaryRequest = {
        model: model.name,
        messages: [{ role: 'user', content: 'Say "test"' }],
        temperature: 0.0,
        maxTokens: 10000, // Much higher limit for retry
      };
    } else if (model.vendor === 'google') {
      // Multiple retry strategies for Gemini
      const uniqueId = Math.random().toString(36).slice(2, 8);
      canaryRequest = {
        model: model.name,
        messages: [{ role: 'user', content: `Test response ${uniqueId}` }],
        temperature: 0.5, // Higher temperature
        maxTokens: 256
      };
    } else if (model.vendor === 'anthropic') {
      canaryRequest = {
        model: model.name,
        messages: [{ role: 'user', content: 'Please respond with "OK"' }],
        temperature: 0.1,
        maxTokens: 1000
      };
    } else {
      canaryRequest = {
        model: model.name,
        messages: [{ role: 'user', content: 'test' }],
        temperature: 0.1,
        maxTokens: 500
      };
    }
    
    const ping = await withBackoff(() => adapter.chat(canaryRequest), 5); // More retries
    if (!ping?.text?.trim()) {
      throw new Error('Enhanced canary test failed - no response');
    }
    
    console.log(`✅ ${model.name} enhanced canary passed - proceeding with benchmark`);
    
  } catch (e) {
    console.log(`❌ ${model.name} enhanced canary failed: ${String(e).slice(0, 200)}`);
    // Record failure but don't throw
    await db.insert(scores).values({
      modelId: model.id,
      ts: batchTimestamp,
      stupidScore: -777,
      axes: { correctness: -1, complexity: -1, codeQuality: -1, efficiency: -1, stability: -1, edgeCases: -1, debugging: -1 },
      cusum: 0.0,
      note: `Enhanced retry failed: ${String(e).slice(0, 100)}`
    });
    return;
  }

  // Run benchmark with the existing system (it already has enhanced retry logic)
  await benchmarkModel(model, batchTimestamp);
}
