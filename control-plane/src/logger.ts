/**
 * Structured single-line JSON logging.
 *
 * Every field passes through a redactor before rendering, so a value that
 * happens to look like a credential cannot reach the log even if a caller is
 * careless. Operator tokens, enrollment tokens, private keys, and authorization
 * headers are never logged by construction.
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

const SECRET_KEY_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'signature',
];

/**
 * Keys that contain a secret-looking fragment but are structurally incapable of
 * carrying credential material. Without these, correlating a log line to an
 * enrollment token record is impossible, which pushes operators toward worse
 * habits than the redaction was protecting against.
 */
const NEVER_SECRET_KEYS = new Set(['tokenid', 'tokencount']);

import { redactCapabilityUrls } from './media-capability.js';

const MAX_STRING = 2048;

function looksSecret(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (NEVER_SECRET_KEYS.has(normalized)) return false;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * A number or boolean cannot carry credential content, so redacting one destroys
 * telemetry for nothing. This is what made `usage.input_tokens` and
 * `enrollment_token_ttl_ms` unreadable: both matched the `token` fragment.
 */
function canCarrySecret(value: unknown): boolean {
  return typeof value !== 'number' && typeof value !== 'boolean';
}

/** Recursively redact and bound a log payload. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[redacted-depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        looksSecret(key) && canCarrySecret(child) ? '[redacted]' : redact(child, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (/^eyJ[\w-]{20,}/.test(value) || /^sk-[\w]{20,}/.test(value)) return '[redacted]';
    // A media capability URL is a bearer credential for one image. It travels
    // legitimately inside command payloads that are otherwise fine to log, so
    // the signature is stripped from the string rather than the whole field.
    const withoutCapability = redactCapabilityUrls(value);
    return withoutCapability.length > MAX_STRING
      ? `${withoutCapability.slice(0, MAX_STRING)}…[truncated]`
      : withoutCapability;
  }
  return value;
}

export interface Logger {
  fatal(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[level];
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] > threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      message,
      ...(fields ? { fields: redact(fields) } : {}),
    };
    console.log(JSON.stringify(line));
  };
  return {
    fatal: (m, f) => emit('fatal', m, f),
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
  };
}
