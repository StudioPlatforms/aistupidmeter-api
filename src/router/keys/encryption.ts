import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Key version prefix for rotation support (Fix #9)
// v1 = original master key, future versions enable decrypt-with-old / re-encrypt-with-new
const CURRENT_KEY_VERSION = 'v1';

// Get master key from environment (must be 32 bytes / 64 hex chars)
function getMasterKey(): Buffer {
  const key = process.env.ROUTER_MASTER_KEY;
  if (!key) {
    throw new Error('ROUTER_MASTER_KEY environment variable is required');
  }
  if (key.length !== 64) {
    throw new Error('ROUTER_MASTER_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(key, 'hex');
}

/**
 * Derive a purpose-specific subkey via HKDF (Fix #8).
 *
 * Parameters (documented for audit / rotation):
 *   Algorithm:  HKDF-SHA256
 *   IKM:        ROUTER_MASTER_KEY (32 bytes, high-entropy, from env)
 *   Salt:       empty string (defensible: IKM is already uniformly random)
 *   Info:       purpose string ('provider-keys' or 'prompts')
 *   L:          32 bytes (256 bits)
 *
 * Same master key, different info strings → disjoint ciphertext domains.
 * If ROUTER_MASTER_KEY leaks, this doesn't help — but it prevents
 * cross-domain ciphertext confusion and makes future key-splitting trivial.
 */
function deriveSubkey(purpose: 'provider-keys' | 'prompts'): Buffer {
  const masterKey = getMasterKey();
  return crypto.hkdfSync('sha256', masterKey, '', purpose, 32) as unknown as Buffer;
}

/**
 * Encrypt a provider API key using AES-256-GCM
 * Format: iv:authTag:encrypted
 */
export function encryptProviderKey(plaintext: string): string {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Return format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a provider API key
 */
export function decryptProviderKey(encrypted: string): string {
  const masterKey = getMasterKey();
  const parts = encrypted.split(':');
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted key format');
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Generate a universal API key
 * Format: aism_<64 hex chars>
 */
export function generateUniversalKey(): string {
  const randomPart = crypto.randomBytes(32).toString('hex');
  return `aism_${randomPart}`;
}

/**
 * Hash an API key for storage (SHA-256)
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Get the prefix of an API key for display (first 12 chars)
 */
export function getKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

/**
 * Validate API key format
 */
export function isValidApiKeyFormat(key: string): boolean {
  return /^aism_[a-f0-9]{64}$/.test(key);
}

/**
 * Generate a secure master key (for initial setup)
 * This should be run once and stored in environment variables
 */
export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================================
// Prompt text encryption — HKDF-derived subkey (Fix #8), versioned format (Fix #9)
// ============================================================================

/**
 * Encrypt prompt text for at-rest storage.
 * Uses AES-256-GCM with an HKDF-derived subkey (purpose: 'prompts').
 * Format: v1:iv:authTag:encrypted
 * The version prefix enables future key rotation (decrypt-with-old, re-encrypt-with-new).
 */
export function encryptPromptText(plaintext: string): string {
  if (!plaintext) return '';
  const subkey = deriveSubkey('prompts');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, subkey, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();
  return `${CURRENT_KEY_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt prompt text from storage.
 * Fix #4: Returns '[DECRYPTION_FAILED]' sentinel on error instead of silent empty string.
 * Fix #9: Handles both legacy (3-part) and versioned (4-part) ciphertext formats.
 */
export function decryptPromptText(encrypted: string): string {
  if (!encrypted) return '';
  try {
    const parts = encrypted.split(':');

    let key: Buffer;
    let ivHex: string, authTagHex: string, encryptedHex: string;

    if (parts.length === 4 && parts[0].startsWith('v')) {
      // Versioned format: v1:iv:authTag:encrypted
      const version = parts[0];
      if (version !== 'v1') {
        console.error(`Unknown prompt encryption version: ${version}`);
        return '[DECRYPTION_FAILED]';
      }
      key = deriveSubkey('prompts');
      [, ivHex, authTagHex, encryptedHex] = parts;
    } else if (parts.length === 3) {
      // Legacy format (pre-HKDF): iv:authTag:encrypted — uses raw master key
      key = getMasterKey();
      [ivHex, authTagHex, encryptedHex] = parts;
    } else {
      console.error(`Invalid prompt ciphertext format (${parts.length} parts)`);
      return '[DECRYPTION_FAILED]';
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    // Fix #4: Log with enough context to diagnose (length hints at format, not content)
    console.error(`Failed to decrypt prompt text (length=${encrypted.length}):`, err);
    return '[DECRYPTION_FAILED]';
  }
}
