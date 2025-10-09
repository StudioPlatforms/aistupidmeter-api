import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

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
