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
import { desc, eq } from 'drizzle-orm';
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
const MIN_HISTORY_FOR_BASELINE = 10; // Minimum historical scores needed for baseline
const STD_EPS = 1e-6;                // avoid div-by-zero

// --- Simple global score calibration (rank-preserving) ---
const SCORE_SCALE = Number(process.env.SCORE_SCALE ?? '1');  // multiplicative
const SCORE_LIFT  = Number(process.env.SCORE_LIFT  ?? '0');  // additive
const SCORE_MIN   = Number(process.env.SCORE_MIN   ?? '0');  // optional clamp
const SCORE_MAX   = Number(process.env.SCORE_MAX   ?? '100');

function calibrateScore(s: number): number {
  // keep sentinels like -999, -888, -777 untouched
  if (s < 0) return s;
  const y = SCORE_SCALE * s + SCORE_LIFT;
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(y)));
}

const AXIS_WEIGHTS = {
  correctness: 0.30,   // Reduced slightly
  complexity: 0.18,    // Changed from spec to complexity
  codeQuality: 0.12,
  efficiency: 0.05,    // Kept low for throughput focus
  stability: 0.12,     // Adjusted for new axes
  edgeCases: 0.05,     // Changed from refusal
  debugging: 0.05,     // Changed from recovery
  format: 0.08,        // New axis for JSON/format obedience
  safety: 0.05         // New axis for refusal/jailbreak correctness
} as const;

// Cost tracking configuration
const PROVIDER_COSTS = {
  openai: { input: 0.03, output: 0.06 },     // per 1k tokens (GPT-4 pricing)
  anthropic: { input: 0.03, output: 0.15 },  // Claude pricing
  google: { input: 0.0125, output: 0.0375 }, // Gemini Pro pricing
  xai: { input: 0.002, output: 0.002 }       // Grok pricing
} as const;

// Drift detection parameters
const DRIFT_WINDOW = 12;          // Look at last 12 runs
const DRIFT_DELTA = 0.005;        // Sensitivity
const DRIFT_LAMBDA = 0.5;         // Threshold

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

  // 1) Preferă blocul care conține simbolul așteptat, altfel cel mai lung
  const codeBlockRegex = /```(?:python|py)?\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = codeBlockRegex.exec(s)) !== null) {
    blocks.push(m[1].trim());
  }
  if (blocks.length) {
    const withSymbol = blocks.find(b => new RegExp(`\\b(def|class)\\s+${expectedSymbol}\\b`).test(b));
    s = (withSymbol ?? blocks.reduce((a,b) => a.length >= b.length ? a : b)).trim();
  }

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
async function evaluateCode(rawText: string, cleanCode: string, task: typeof BENCHMARK_TASKS[0]): Promise<{
  correctness: number; complexity: number; codeQuality: number; edgeCases: number; debugging: number; format: number; safety: number;
}> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const fs = require('fs').promises;
  const path = require('path');
  const os = require('os');
  const execAsync = promisify(exec);

  // 0) Use cleanCode (already extracted) and rawText for different purposes  
  let clean = cleanCode;

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

  codeQuality = Math.max(0, Math.min(1.0, codeQuality));

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
try:
    codeobj = compile(src, '<solution>', 'exec')
    exec(codeobj, ns, ns)
except Exception as e:
    pass

passed_count = 0
total_tests = 0

def call_fn(fn_name, args):
    fn = ns.get(fn_name)
    if not callable(fn):
        raise NameError('missing ' + fn_name)
    return fn(*args)

# === TESTS WILL BE INJECTED HERE ===
`.trim();

  // 4) Construim testele în runner + hidden fuzz tests
  let tests = "\n";
  if (task.id === 'lru_cache') {
    tests += `
total_tests += 2
try:
    C = ns.get("${task.expectedCode}")
    if C is None: raise NameError("missing ${task.expectedCode}")
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
    // Fixed test cases first
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

    // Hidden fuzz tests per task (property-based lite)
    tests += `\n# Hidden fuzz tests to prevent memorization\nimport random, string\nrandom.seed(1337)\n`;
    
    if (task.id === 'is_palindrome') {
      tests += `
# Fuzz tests for palindrome
for _ in range(15):
    s = ''.join(random.choice(string.ascii_letters + "   ") for _ in range(random.randint(0,40)))
    expect = (''.join(c.lower() for c in s if not c.isspace()) ==
              ''.join(c.lower() for c in s if not c.isspace())[::-1])
    total_tests += 1
    try:
        res = call_fn("${task.expectedCode}", (s,))
        if bool(res) == bool(expect):
            passed_count += 1
    except Exception:
        pass
`;
    } else if (task.id === 'prime_check') {
      tests += `
# Fuzz tests for prime check
primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]
composites = [4, 6, 8, 9, 10, 12, 14, 15, 16, 18, 20, 21, 22, 24, 25, 26, 27, 28, 30, 32, 33, 34, 35, 36]
for _ in range(10):
    # Test known primes
    if random.random() < 0.5 and primes:
        n = random.choice(primes)
        expect = True
    else:
        n = random.choice(composites) if composites else 4
        expect = False
    total_tests += 1
    try:
        res = call_fn("${task.expectedCode}", (n,))
        if bool(res) == expect:
            passed_count += 1
    except Exception:
        pass
`;
    } else if (task.id === 'binary_search') {
      tests += `
# Fuzz tests for binary search
for _ in range(12):
    size = random.randint(1, 20)
    arr = sorted([random.randint(1, 100) for _ in range(size)])
    if random.random() < 0.7:
        # Target exists
        target = random.choice(arr)
        expect = arr.index(target)
    else:
        # Target doesn't exist
        target = random.randint(101, 200)  # Outside range
        expect = -1
    total_tests += 1
    try:
        res = call_fn("${task.expectedCode}", (arr, target))
        if res == expect:
            passed_count += 1
    except Exception:
        pass
`;
    } else if (task.id === 'merge_intervals') {
      tests += `
# Fuzz tests for merge intervals
for _ in range(8):
    num_intervals = random.randint(1, 8)
    intervals = []
    for _ in range(num_intervals):
        start = random.randint(1, 50)
        end = start + random.randint(1, 20)
        intervals.append([start, end])
    
    # Calculate expected result
    if not intervals:
        expect = []
    else:
        sorted_intervals = sorted(intervals)
        merged = [sorted_intervals[0]]
        for current in sorted_intervals[1:]:
            if current[0] <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], current[1])
            else:
                merged.append(current)
        expect = merged
    
    total_tests += 1
    try:
        res = call_fn("${task.expectedCode}", (intervals,))
        if res == expect:
            passed_count += 1
    except Exception:
        pass
`;
    } else if (task.id === 'regex_match') {
      tests += `
# Fuzz tests for regex matching  
test_cases = [
    ("", "", True), ("", ".*", True), ("a", ".", True), ("ab", "a*", False),
    ("aab", "c*a*b", True), ("mississippi", "mis*is*ip*.", True), 
    ("aaa", "a*a", True), ("aaa", "aaaa", False), ("aa", "aaa", False)
]
for s, p, expect in test_cases:
    total_tests += 1
    try:
        res = call_fn("${task.expectedCode}", (s, p))
        if bool(res) == expect:
            passed_count += 1
    except Exception:
        pass
`;
    } else if (task.id === 'optimize_fibonacci') {
      tests += `
# Fuzz tests for fibonacci
fib_values = {0:0, 1:1, 2:1, 3:2, 4:3, 5:5, 6:8, 7:13, 8:21, 9:34, 
              15:610, 20:6765, 25:75025, 30:832040}
for n, expect in fib_values.items():
    total_tests += 1
    try:
        res = call_fn("${task.expectedCode}", (n,))
        if res == expect:
            passed_count += 1
    except Exception:
        pass
`;
    } else {
      // Generic fuzz for other tasks - add some edge cases
      tests += `
# Generic edge case testing
edge_cases = [[], [1], [1,1,1,1], [1,2], [-1,0,1]]
for case in edge_cases[:3]:  # Limit to avoid too many tests
    try:
        res = call_fn("${task.expectedCode}", (case,))
        total_tests += 1
        # Just check it doesn't crash, any result is fine for edge cases
        passed_count += 1
    except TypeError:
        # Signature mismatch: don't count against the model
        pass
    except Exception:
        # Real runtime error: count as a test and a failure
        total_tests += 1
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
  
  // FIX 4: Implement real format and safety axes using raw model output
  // Format: reward plain code (no fences), tolerate single fenced block, penalize prose/mixed.
  let format = 1.0;
  const raw = rawText.trim();
  const hasFence = /```/.test(raw);
  const onlyFence = /^```(?:python|py)?\s*[\s\S]*?\s*```$/.test(raw);
  const looksLikeCode = /^(?:\s*(?:def|class)\s+|\s*from\s+\w+|\s*import\s+\w+)/m.test(raw);

  // best: plain code, no fences, no chatter
  if (!hasFence && looksLikeCode) format = 1.0;
  // acceptable: exactly one fenced block and nothing else
  else if (hasFence && onlyFence) format = 0.9;
  // mixed: fences + extra prose
  else if (hasFence && !onlyFence) format = 0.6;
  // worst: no fences and doesn't look like code (we had to guess)
  else format = 0.2;
  
  // Safety (basic for code tasks): detect dangerous calls/imports
  const unsafe = /(exec|eval|__import__|subprocess|socket|urllib|requests|ftplib|smtplib|os\.)/;
  const safety = unsafe.test(clean) ? 0.2 : 1.0;
  
  return { correctness, complexity, codeQuality, edgeCases, debugging, format, safety };
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
  // Apply consistent anti-cache salting to all vendors for fair comparison
  const salt = generateNonce();
  return `${baseMessage} [Context: ${salt}]`;
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

// ---------- Cache-busting: Real symbol renaming ----------
function applyCacheBustingToTask(task: typeof BENCHMARK_TASKS[0], nonce: string): typeof BENCHMARK_TASKS[0] {
  // Generate unique symbol name with nonce
  const alias = `${task.expectedCode}_${nonce}`;
  
  // Rewrite prompt to use the alias
  const aliasedPrompt = task.prompt.replace(
    new RegExp(`\\b${task.expectedCode}\\b`, 'g'),
    alias
  );
  
  // Create task with new symbol expectation
  return {
    ...task,
    prompt: aliasedPrompt,
    expectedCode: alias
  };
}

// Token usage estimation fallback
function estimateTokensFromText(text: string): number {
  // crude but consistent; ~4 chars/token for code
  return Math.max(1, Math.ceil(text.length / 4));
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
    
    // Balance prompting & maxTokens across providers - base limits to avoid latency skew
    maxTokens = Math.min(task.maxTokens * 3, 1200);  // base cap ~1200 for all
    temperature = 0.1;
    reasoning_effort = undefined; // remove special boosts
    
    // Smart retry strategy: apply boosts after base calculation
    if (retryAttempt > 0) {
      // Retry 1: Increase token limit significantly
      if (retryAttempt === 1) {
        maxTokens = Math.max(maxTokens, 1500);
        streamLog('info', `      🔧 Retry ${retryAttempt}: Boosting maxTokens to ${maxTokens}`);
      }
      // Retry 2: Increase token limit even more and adjust temperature
      else if (retryAttempt >= 2) {
        maxTokens = Math.max(maxTokens, 2000);
        temperature = 0.2; // Slightly higher temperature for more variety
        streamLog('info', `      🔧 Retry ${retryAttempt}: Boosting maxTokens to ${maxTokens}, temperature to ${temperature}`);
      }
      
      // Optional hard cap if needed
      maxTokens = Math.min(maxTokens, 2000);
    }
    
    // Only apply reasoning effort for models that absolutely require it, with latency budget consideration
    if (model.vendor === 'openai' && /^o\d|^o-mini|^o-/.test(model.name)) {
      reasoning_effort = 'low'; // Use minimal reasoning to avoid excessive latency penalty
    }

    // ANTI-CACHING: Generate unique identifiers for this request
    const sessionNonce = generateNonce();
    const trialId = `T${trialNumber || 1}_R${retryAttempt}_${Date.now().toString(36)}`;
    
    // CACHE-BUSTING: Apply real symbol renaming to kill provider caching
    const cacheBustingNonce = generateNonce();
    const cacheBustedTask = applyCacheBustingToTask(task, cacheBustingNonce);
    const activeTask = cacheBustedTask;  // FIX 1: Use consistent variable
    streamLog('info', `      🎯 Cache-busting: Renamed '${task.expectedCode}' to '${activeTask.expectedCode}'`);
    
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
    const enhancedPrompt = addAntiCachingNonce(activeTask.prompt, `${sessionNonce}_${trialId}`);

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
    
    // Additional fallback for total_tokens if individual counts are missing
    const totalTokens = (res as any)?.usage?.total_tokens ?? 0;
    const finalTokensIn = tokensIn || (totalTokens ? Math.ceil(totalTokens * 0.7) : 0); // Estimate 70% input
    const finalTokensOut = tokensOut || (totalTokens ? Math.floor(totalTokens * 0.3) : 0); // Estimate 30% output
    
    streamLog('info', `      🔢 Token usage: ${finalTokensIn} in, ${finalTokensOut} out`);
    
    // FIX 1: Use activeTask for extraction and evaluation
    streamLog('info', `      🔧 Extracting Python code for function '${activeTask.expectedCode}'...`);
    const sanitized = extractPython(code, activeTask.expectedCode);
    
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
    streamLog('info', `      🧪 Evaluating code against ${activeTask.testCases?.length || 0} test cases...`);
    
    const evalRes = await evaluateCode(code, sanitized, activeTask);
    
    streamLog('info', `      📊 Code evaluation results:`);
    streamLog('info', `      ✓ Correctness: ${(evalRes.correctness * 100).toFixed(1)}%`);
    streamLog('info', `      🧠 Complexity: ${(evalRes.complexity * 100).toFixed(1)}%`);
    streamLog('info', `      💎 Code Quality: ${(evalRes.codeQuality * 100).toFixed(1)}%`);
    streamLog('info', `      🎯 Edge Cases: ${(evalRes.edgeCases * 100).toFixed(1)}%`);
    streamLog('info', `      🔧 Debugging: ${(evalRes.debugging * 100).toFixed(1)}%`);
    
    // Fair efficiency calculation using relative z-score (will be calculated after all trials)
    const efficiency = 0; // Placeholder - will be calculated in aggregation phase
    
    streamLog('info', `      ⚡ Latency: ${latencyMs}ms (efficiency will be calculated relative to batch)`);
    
    // Map evaluation results to axis metrics
    const m = {
      correctness: evalRes.correctness,
      complexity: evalRes.complexity,
      codeQuality: evalRes.codeQuality,
      efficiency,
      stability: 0, // Will be calculated after trials
      edgeCases: evalRes.edgeCases,
      debugging: evalRes.debugging,
      format: evalRes.format,
      safety: evalRes.safety
    } as Record<AxisKey, number>;

    return { success: true, latencyMs, code: sanitized, tokensIn: finalTokensIn, tokensOut: finalTokensOut, metrics: m };
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

  const axes: AxisKey[] = ['correctness','complexity','codeQuality','efficiency','edgeCases','debugging','format','safety'];
  const med: Record<AxisKey, number> = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0, 
    stability:0, edgeCases:0, debugging:0, format:0, safety:0
  };
  
  for (const k of axes) {
    med[k] = median(ok.map(t => t.metrics[k]));
  }

  // Fix 3: Streaming stability inflation consistency - match non-streaming version
  const corrSeries = ok.map(t => t.metrics.correctness ?? 0);
  const sd = corrSeries.length > 1 ? stdev(corrSeries) : null;
  med.stability = sd === null ? 0.5 : Math.max(0, Math.min(1, 1 - sd / 0.3)); // default 0.5 if <2 trials

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
    stability:[], edgeCases:[], debugging:[], format:[], safety:[]
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


// Bayesian shrinkage function to regularize scores with small sample sizes
function shrink(x: number, n: number, k: number = 8): number { 
  // k ≈ how many tasks to trust
  const λ = n / (n + k);
  return λ * x + (1 - λ) * 50; // Shrink toward neutral score of 50
}

function calculateScore(axesNow: Axes, baseline: {means: Axes; stds: Axes}, hasBaseline: boolean = true, successfulTasks: number = 1): number {
  // SOFTENED PROFESSOR MODE: More balanced scoring that's still rigorous but fairer
  let weightedSum = 0;
  let totalWeight = 0;
  
  (Object.keys(AXIS_WEIGHTS) as AxisKey[]).forEach(k => {
    let performance = axesNow[k] || 0;
    const weight = AXIS_WEIGHTS[k];
    
    // SOFTENED: Apply more gentle exponential decay for imperfections
    if (performance < 1.0) {
      // Milder exponential penalty: 0.9 -> 0.85, 0.8 -> 0.70, etc.
      performance = Math.pow(performance, 1.4); // Was 1.8, now 1.4
    }
    
    // SOFTENED: Reduced axis-specific penalties
    if (k === 'correctness' && performance < 0.95) {
      performance *= 0.85; // Was 0.7, now 0.85 - less harsh
    }
    if (k === 'codeQuality' && performance < 0.6) {
      performance *= 0.95; // Was 0.9, now 0.95 - even gentler nudge
    }
    
    weightedSum += performance * weight * 100;
    totalWeight += weight;
  });
  
  if (totalWeight === 0) return 0;
  
  let baseScore = weightedSum / totalWeight;
  
  // SOFTENED: Make base scoring less demanding
  // Apply gentler "professor curve" - less harsh shift
  baseScore = Math.pow(baseScore / 100, 1.2) * 100; // Was 1.4, now 1.2 - less harsh curve
  
  // SOFTENED: Reduced variance penalties
  let varianceAdjustment = 0;
  if (hasBaseline && baseline.means.correctness !== undefined) {
    (Object.keys(AXIS_WEIGHTS) as AxisKey[]).forEach(k => {
      const deviation = (axesNow[k] || 0) - (baseline.means[k] || 0.5);
      const normalizedDev = deviation / (baseline.stds[k] || 0.15);
      varianceAdjustment += normalizedDev * AXIS_WEIGHTS[k] * 1.5; // Was 2, now 1.5 - reduced impact
    });
    
    // SOFTENED: Smaller penalty range
    varianceAdjustment = Math.max(-6, Math.min(4, varianceAdjustment)); // Was -8/+3, now -6/+4 - more balanced
  }
  
  let finalScore = baseScore + varianceAdjustment;
  
  // SOFTENED: Smaller calibration penalty for unproven models
  if (!hasBaseline) {
    finalScore -= 5; // Was 8, now 5 - less harsh penalty
  }
  
  // SOFTENED: Less harsh quality gates with smaller penalties
  const correctness = axesNow.correctness || 0;
  const codeQuality = axesNow.codeQuality || 0;
  const complexity = axesNow.complexity || 0;
  
  const gates = {
    correctness_minor: correctness < 0.90 ? -5 : 0,  // Was -8, now -5
    correctness_major: correctness < 0.70 ? -6 : 0,  // Was -8, now -6  
    correctness_fail : correctness < 0.50 ? -8 : 0,  // Was -10, now -8
    quality_minor    : codeQuality < 0.60 ? -6 : 0,  // Was -10, now -6
    quality_major    : codeQuality < 0.40 ? -12: 0,  // Was -20, now -12
    task_understood  : complexity  < 0.30 ? -8 : 0,  // Was -12, now -8
  };
  finalScore += Object.values(gates).reduce((a,b)=>a+b,0);

  // Apply Bayesian shrinkage by number of successful tasks
  finalScore = Math.round(shrink(finalScore, successfulTasks));
  
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
      attempts: TRIALS, // Reflect collapsed trials
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
        maxTokens: /^gpt-5/.test(model.name) ? 1200 : 100, // Optional: Reduced canary tokens for GPT-5
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
        reasoning_effort: 'low'
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

  // Deterministic task selection using batch timestamp as seed
  const taskCount = Math.min(7, BENCHMARK_TASKS.length);
  
  // Deterministic shuffle by batchTimestamp
  function shuffleDet<T>(arr: T[], seed: string): T[] {
    const a = [...arr];
    let h = [...Buffer.from(seed)].reduce((s,b)=> (s*33 + b) >>> 0, 5381);
    for (let i=a.length-1;i>0;i--){
      h = (h*1103515245 + 12345) >>> 0;
      const j = h % (i+1);
      [a[i],a[j]] = [a[j],a[i]];
    }
    return a;
  }
  
  const selectedTasks = shuffleDet(BENCHMARK_TASKS, batchTimestamp || new Date().toISOString()).slice(0, taskCount);

  // Log task selection for streaming users
  streamLog('info', `📝 Selected ${selectedTasks.length} benchmark tasks from ${BENCHMARK_TASKS.length} total`);
  streamLog('info', `🎯 Tasks: ${selectedTasks.map(t => `${t.id} (${t.difficulty})`).join(', ')}`);

  // Fix 1: Collect finished tasks for proper persistence timing
  type Finished = {
    task: typeof BENCHMARK_TASKS[0],
    collapsed: {
      latencyMs: number,
      tokensIn: number,
      tokensOut: number,
      metrics: Axes,
      code?: string
    }
  };
  const finished: Finished[] = [];

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
      
      // Fix 1: Collect finished tasks and persist per-task data
      finished.push({ task, collapsed: result.collapsed });
      perTaskAxes.push(result.collapsed.metrics);
      latencies.push(result.collapsed.latencyMs);
      
      // Persist individual task run for analytics
      await persistCollapsedRun({
        modelId: model.id,
        taskSlug: task.slug,
        latencyMs: result.collapsed.latencyMs,
        tokensIn: result.collapsed.tokensIn,
        tokensOut: result.collapsed.tokensOut,
        axes: result.collapsed.metrics,
        code: result.collapsed.code
      });
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
          
          // Fix 1: Collect finished tasks and persist per-task data
          finished.push({ task, collapsed: result.collapsed });
          perTaskAxes.push(result.collapsed.metrics);
          latencies.push(result.collapsed.latencyMs);
          
          // Persist individual task run for analytics
          await persistCollapsedRun({
            modelId: model.id,
            taskSlug: task.slug,
            latencyMs: result.collapsed.latencyMs,
            tokensIn: result.collapsed.tokensIn,
            tokensOut: result.collapsed.tokensOut,
            axes: result.collapsed.metrics,
            code: result.collapsed.code
          });
          
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

  // FIX 2: Improved efficiency calculation with token usage fallback
  for (let i = 0; i < perTaskAxes.length; i++) {
    const latMs = latencies[i];
    const rawTokensOut = finished[i]?.collapsed.tokensOut ?? 0;
    const codeText = finished[i]?.collapsed.code ?? "";
    
    // Use token fallback when providers don't return usage
    const tokensOut = rawTokensOut > 0 ? rawTokensOut : estimateTokensFromText(codeText);
    const throughput = tokensOut / Math.max(1, latMs);
    
    // Robust normalization via log scale against a rolling reference
    const logThroughput = Math.log10(throughput + 1e-6) + 3; // Add 3 to avoid negative logs
    const eff = Math.max(0, Math.min(1, logThroughput / 3)); // Normalize to 0-1
    
    // Add clamp symmetry for efficiency (similar to stability)
    perTaskAxes[i].efficiency = Math.max(0.1, Math.min(0.9, eff));
  }

  // Aggregate metrics across successful tasks
  const agg: Axes = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0,
    stability:0, edgeCases:0, debugging:0, format:0, safety:0
  };
  
  (Object.keys(agg) as AxisKey[]).forEach(k => {
    agg[k] = perTaskAxes.length
      ? perTaskAxes.reduce((s,a) => s + (a[k] ?? 0), 0) / perTaskAxes.length
      : 0;
  });

  // FIX 3: Cross-task stability override - stability should be cross-task, not within-task trials only
  if (perTaskAxes.length > 1) {
    const corrAcrossTasks = perTaskAxes.map(a => a.correctness ?? 0);
    const sdAcross = stdev(corrAcrossTasks);
    const crossTaskStability = Math.max(0, Math.min(1, 1 - sdAcross / 0.25));
    // Override with cross-task signal (or blend 70/30 as recommended)
    agg.stability = 0.7 * crossTaskStability + 0.3 * Math.max(0.3, Math.min(0.95, agg.stability));
  }

  // Fix stability clamping issues - clamp both min and max for fairness
  function clampAxesForScore(a: Axes): Axes {
    return {
      ...a,
      stability: Math.max(0.3, Math.min(a.stability, 0.95)) // clamp both ways for fairness
    };
  }

  // Get baseline and calculate score
  const baseline = await getHistoricalBaseline(model.id);
  const taskSuccessRate = perTaskAxes.length / selectedTasks.length; // 0..1
  
  let finalScore: number;
  let note: string | null = null;

  if (!baseline.hasBaseline) {
    // Use calculateScore with hasBaseline=false for calibration penalty
    finalScore = calculateScore(clampAxesForScore(agg), baseline, false, successfulTasks);
    // Small extra penalty while calibrating
    finalScore -= 2;
    note = `Calibrating (${baseline.sampleCount}/${MIN_HISTORY_FOR_BASELINE} samples)`;
  } else {
    finalScore = calculateScore(clampAxesForScore(agg), baseline, true, successfulTasks);
  }

  // Apply failure penalty (reduced from 12 to 6)
  const failurePenalty = Math.round((1 - taskSuccessRate) * 6);
  finalScore = Math.max(0, finalScore - failurePenalty);

  const rawScore = finalScore;
  finalScore = calibrateScore(finalScore);
  if (finalScore !== rawScore) {
    note = (note ? note + ' | ' : '') + `calibrated ${rawScore}→${finalScore}`;
  }

  if (failedTasks.length > 0) {
    const successPct = Math.round(taskSuccessRate * 100);
    note = (note ? note + ' | ' : '') + `${successPct}% tasks completed (${failedTasks.length} failed)`;
  }

  // FIX 5: Add cost calculation
  const pc = PROVIDER_COSTS[model.vendor] || { input: 0, output: 0 };
  const totalIn = finished.reduce((s, f) => s + (f.collapsed.tokensIn || 0), 0);
  const totalOut = finished.reduce((s, f) => s + (f.collapsed.tokensOut || 0), 0);
  const batchCost = (totalIn / 1000) * pc.input + (totalOut / 1000) * pc.output;
  if (batchCost > 0) {
    note = (note ? note + ' | ' : '') + `~$${batchCost.toFixed(3)}`;
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

  // FIX 6: Apply drift detection after inserting the new score
  try {
    function pageHinkley(xs: number[], delta: number = DRIFT_DELTA, lambda: number = DRIFT_LAMBDA): boolean {
      let mT = 0, M = 0, x0 = xs[0] ?? 0;
      for (const x of xs) {
        mT += (x - x0 - delta);
        M = Math.min(M, mT);
        if (mT - M > lambda) return true;
      }
      return false;
    }
    
    const recent = await db.select().from(scores)
      .where(eq(scores.modelId, model.id))
      .orderBy(desc(scores.ts)).limit(DRIFT_WINDOW);
    const series = recent.filter(r => (r as any).stupidScore >= 0).map(r => (r as any).stupidScore / 100);
    if (series.length >= 6 && pageHinkley(series)) {
      console.log(`⚠️ Potential drift detected for ${model.name}`);
      streamLog && streamLog('warning', `⚠️ Potential performance drift detected for ${model.name}`);
    }
  } catch (driftError) {
    // Don't let drift detection errors break benchmarking
    console.warn(`[DRIFT-ERROR] ${model.name}: ${String(driftError).slice(0, 100)}`);
  }

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
