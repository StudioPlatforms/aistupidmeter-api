/**
 * Prompt Scrubber — PII / Secret Redaction
 * 
 * Removes sensitive content from user prompts before storage:
 * - API keys (OpenAI, GitHub, AWS, our own aism_ keys, etc.)
 * - JWTs and Bearer tokens
 * - Generic password/secret key=value patterns
 * - Email addresses
 * - Phone numbers
 * - High-entropy strings (catch-all for unknown secret formats)
 */

export interface ScrubResult {
  text: string;
  redactionCount: number;
  redactionTypes: string[];
}

// ============================================================================
// Known API key / token prefix patterns
// ============================================================================

const KNOWN_PREFIX_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // OpenAI keys
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, label: 'openai_key' },
  { pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/g, label: 'openai_project_key' },
  // GitHub tokens
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, label: 'github_pat' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/g, label: 'github_oauth' },
  { pattern: /ghs_[a-zA-Z0-9]{36,}/g, label: 'github_server' },
  { pattern: /github_pat_[a-zA-Z0-9_]{20,}/g, label: 'github_fine_pat' },
  // AWS
  { pattern: /AKIA[A-Z0-9]{16}/g, label: 'aws_access_key' },
  { pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[:=]\s*\S{20,}/gi, label: 'aws_secret' },
  // Our own keys
  { pattern: /aism_[a-zA-Z0-9]{20,}/g, label: 'aism_key' },
  // Anthropic
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, label: 'anthropic_key' },
  // Google / GCP
  { pattern: /AIza[a-zA-Z0-9_-]{35}/g, label: 'google_api_key' },
  // Stripe
  { pattern: /sk_(?:live|test)_[a-zA-Z0-9]{20,}/g, label: 'stripe_key' },
  { pattern: /pk_(?:live|test)_[a-zA-Z0-9]{20,}/g, label: 'stripe_pub_key' },
  // Slack tokens (Fix #7)
  { pattern: /xox[abprs]-[a-zA-Z0-9\-]{10,}/g, label: 'slack_token' },
  // SendGrid (Fix #7)
  { pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, label: 'sendgrid_key' },
  // Twilio (Fix #7)
  { pattern: /AC[a-f0-9]{32}/g, label: 'twilio_account_sid' },
  { pattern: /SK[a-f0-9]{32}/g, label: 'twilio_api_key' },
  // npm / PyPI tokens (Fix #7)
  { pattern: /npm_[a-zA-Z0-9]{36,}/g, label: 'npm_token' },
  { pattern: /pypi-AgEIcHlwaS5vcmc[a-zA-Z0-9_-]{50,}/g, label: 'pypi_token' },
  // JWTs (eyJ... base64 header)
  { pattern: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, label: 'jwt' },
  // Bearer tokens in text
  { pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/g, label: 'bearer_token' },
  // Basic auth in URLs (Fix #7): https://user:pass@host
  { pattern: /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi, label: 'basic_auth_url' },
  // Private keys (PEM format) (Fix #7)
  { pattern: /-----BEGIN\s(?:RSA\s|EC\s|OPENSSH\s|DSA\s)?PRIVATE\sKEY-----[\s\S]*?-----END\s(?:RSA\s|EC\s|OPENSSH\s|DSA\s)?PRIVATE\sKEY-----/g, label: 'private_key_pem' },
  // Generic key=value patterns for common secret names
  { pattern: /(?:password|passwd|secret|token|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?\S{8,}["']?/gi, label: 'generic_secret' },
  // Database connection strings (expanded with +srv, mssql) (Fix #7)
  { pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|mssql):\/\/[^\s]{10,}/gi, label: 'connection_string' },
];

// ============================================================================
// Email pattern
// ============================================================================

const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ============================================================================
// Phone number patterns (international + US/UK/EU formats)
// ============================================================================

const PHONE_PATTERNS = [
  /\+?1?\s*\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g,          // US: +1 (555) 123-4567
  /\+?\d{1,3}[\s.\-]?\d{2,4}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}/g, // International: +44 20 1234 5678
];

// ============================================================================
// Shannon entropy for catch-all high-entropy detection
// ============================================================================

function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ============================================================================
// Internal replacement helpers
// ============================================================================

function replaceKnownPrefixes(text: string): { text: string; count: number; types: string[] } {
  let count = 0;
  const types: string[] = [];

  for (const { pattern, label } of KNOWN_PREFIX_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      count += matches.length;
      if (!types.includes(label)) types.push(label);
      text = text.replace(pattern, `[${label.toUpperCase()}_REDACTED]`);
    }
  }

  return { text, count, types };
}

function replaceEmails(text: string): { text: string; count: number } {
  const matches = text.match(EMAIL_PATTERN);
  if (!matches || matches.length === 0) return { text, count: 0 };
  return {
    text: text.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]'),
    count: matches.length
  };
}

function replacePhoneNumbers(text: string): { text: string; count: number } {
  let count = 0;
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) {
      // Only redact things that look like phone numbers (mostly digits)
      for (const match of matches) {
        const digitsOnly = match.replace(/\D/g, '');
        if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
          text = text.replace(match, '[PHONE_REDACTED]');
          count++;
        }
      }
    }
  }
  return { text, count };
}

function replaceHighEntropyStrings(text: string): { text: string; count: number } {
  // Find contiguous non-whitespace tokens of 20+ chars and check entropy
  let count = 0;
  const HIGH_ENTROPY_THRESHOLD = 4.5;
  const MIN_LENGTH = 20;

  // Split on whitespace but preserve structure for replacement
  text = text.replace(/\S{20,}/g, (token) => {
    // Skip things that are clearly URLs or already-redacted markers
    if (token.startsWith('http://') || token.startsWith('https://') || token.includes('_REDACTED]')) {
      return token;
    }
    // Skip things that look like code identifiers (camelCase/snake_case with mostly lowercase)
    const alphaRatio = (token.match(/[a-zA-Z]/g)?.length || 0) / token.length;
    if (alphaRatio > 0.9 && token.includes('_')) {
      return token; // Likely a variable name like my_very_long_variable_name
    }

    const entropy = shannonEntropy(token);
    if (entropy >= HIGH_ENTROPY_THRESHOLD && token.length >= MIN_LENGTH) {
      count++;
      return '[HIGH_ENTROPY_REDACTED]';
    }
    return token;
  });

  return { text, count };
}

// ============================================================================
// Main scrubber — public API
// ============================================================================

/**
 * Scrub sensitive content from prompt text before storage.
 * 
 * Processing order matters: known prefixes first (most specific),
 * then emails, phones, and finally high-entropy catch-all.
 * 
 * @param input - Raw prompt text from user
 * @returns Scrubbed text + metadata about what was redacted
 */
export function scrubPromptText(input: string): ScrubResult {
  if (!input || input.length === 0) {
    return { text: '', redactionCount: 0, redactionTypes: [] };
  }

  let text = input;
  let totalCount = 0;
  const allTypes: string[] = [];

  // 1. Known API key / token prefixes (most specific patterns)
  const prefixResult = replaceKnownPrefixes(text);
  text = prefixResult.text;
  totalCount += prefixResult.count;
  allTypes.push(...prefixResult.types);

  // 2. Email addresses
  const emailResult = replaceEmails(text);
  text = emailResult.text;
  if (emailResult.count > 0) {
    totalCount += emailResult.count;
    allTypes.push('email');
  }

  // 3. Phone numbers
  const phoneResult = replacePhoneNumbers(text);
  text = phoneResult.text;
  if (phoneResult.count > 0) {
    totalCount += phoneResult.count;
    allTypes.push('phone');
  }

  // 4. High-entropy catch-all (runs last to avoid false positives on already-redacted text)
  const entropyResult = replaceHighEntropyStrings(text);
  text = entropyResult.text;
  if (entropyResult.count > 0) {
    totalCount += entropyResult.count;
    allTypes.push('high_entropy');
  }

  return {
    text,
    redactionCount: totalCount,
    redactionTypes: allTypes
  };
}
