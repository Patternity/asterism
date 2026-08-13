/**
 * Validated Control Plane configuration.
 *
 * Everything arrives through the environment and is validated once at startup.
 * A missing or malformed value fails the process rather than degrading quietly,
 * because a Control Plane that starts with half a configuration is worse than
 * one that does not start.
 *
 * Secrets live only in memory. Nothing here is ever logged: `describe()` is the
 * only rendering path and it deliberately omits every secret.
 */
import { z } from 'zod';

const durationMs = (fallback: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .default(fallback);

const booleanValue = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined) return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  }, z.boolean());

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  httpHost: z.string().default('127.0.0.1'),
  httpPort: z.coerce.number().int().min(0).max(65535).default(8080),
  /** Optional absolute directory containing the built operations console. */
  staticRoot: z.string().min(1).optional(),
  /** Externally reachable base URL Nodes are told to use. */
  publicBaseUrl: z.string().min(1),
  /** Temporary single-operator bearer token. Not a user model. */
  operatorToken: z.string().default(''),
  /** Deprecated Phase G compatibility API. Browser clients never use it. */
  operatorCompatibility: booleanValue(false),
  /** Exact browser origins allowed to send credentialed product requests. */
  allowedOrigins: z.array(z.string().url()).min(1),
  sessionIdleTimeoutMs: durationMs(8 * 60 * 60 * 1000),
  sessionAbsoluteTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(30 * 24 * 60 * 60 * 1000)
    .default(7 * 24 * 60 * 60 * 1000),
  loginWindowMs: durationMs(15 * 60 * 1000),
  loginAccountLimit: z.coerce.number().int().min(1).max(100).default(5),
  loginSourceLimit: z.coerce.number().int().min(1).max(1000).default(20),
  enrollmentTokenTtlMs: durationMs(60 * 60 * 1000),
  challengeTtlMs: durationMs(30 * 1000),
  heartbeatIntervalMs: durationMs(15 * 1000),
  heartbeatMissedLimit: z.coerce.number().int().min(1).max(10).default(3),
  /** Authentication must finish inside this window or the socket is closed. */
  handshakeTimeoutMs: durationMs(10 * 1000),
  maxFrameBytes: z.coerce
    .number()
    .int()
    .min(1024)
    .max(8 * 1024 * 1024)
    .default(1024 * 1024),
  maxCommandPayloadBytes: z.coerce
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024)
    .default(128 * 1024),
  commandTimeoutMs: durationMs(10 * 60 * 1000),
  eventBatchSize: z.coerce.number().int().min(1).max(1000).default(200),
  maxConnections: z.coerce.number().int().min(1).max(10_000).default(256),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Forwarded headers are ignored unless a proxy is explicitly declared. */
  trustProxy: booleanValue(false),
  /** Permits ws:// and http:// for loopback development only. */
  allowPlaintext: booleanValue(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Build the configuration from an environment map.
 *
 * Production is held to a stricter standard than development: TLS is required
 * and plaintext cannot be enabled at all, so a deployment cannot accidentally
 * inherit a development shortcut.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    httpHost: env.HTTP_HOST,
    httpPort: env.HTTP_PORT,
    staticRoot: env.STATIC_ROOT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    operatorToken: env.ASTERISM_OPERATOR_TOKEN,
    operatorCompatibility:
      env.OPERATOR_COMPATIBILITY ?? (env.NODE_ENV === 'production' ? 'false' : 'true'),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? env.PUBLIC_BASE_URL ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    sessionIdleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MS,
    sessionAbsoluteTimeoutMs: env.SESSION_ABSOLUTE_TIMEOUT_MS,
    loginWindowMs: env.LOGIN_WINDOW_MS,
    loginAccountLimit: env.LOGIN_ACCOUNT_LIMIT,
    loginSourceLimit: env.LOGIN_SOURCE_LIMIT,
    enrollmentTokenTtlMs: env.ENROLLMENT_TOKEN_TTL_MS,
    challengeTtlMs: env.CHALLENGE_TTL_MS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    heartbeatMissedLimit: env.HEARTBEAT_MISSED_LIMIT,
    handshakeTimeoutMs: env.HANDSHAKE_TIMEOUT_MS,
    maxFrameBytes: env.MAX_FRAME_BYTES,
    maxCommandPayloadBytes: env.MAX_COMMAND_PAYLOAD_BYTES,
    commandTimeoutMs: env.COMMAND_TIMEOUT_MS,
    eventBatchSize: env.EVENT_BATCH_SIZE,
    maxConnections: env.MAX_CONNECTIONS,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    allowPlaintext: env.ALLOW_PLAINTEXT,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid Control Plane configuration: ${issues}`);
  }

  const config = parsed.data;

  if (config.operatorCompatibility && config.operatorToken.length < 32) {
    throw new Error(
      'ASTERISM_OPERATOR_TOKEN must be at least 32 characters when compatibility mode is enabled',
    );
  }

  if (config.nodeEnv === 'production') {
    if (config.allowPlaintext) {
      throw new Error('ALLOW_PLAINTEXT must not be enabled in production');
    }
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new Error('PUBLIC_BASE_URL must use https:// in production');
    }
    if (config.operatorCompatibility && env.OPERATOR_COMPATIBILITY === undefined) {
      throw new Error('operator compatibility must be explicitly enabled in production');
    }
    if (config.allowedOrigins.some((origin) => !origin.startsWith('https://'))) {
      throw new Error('ALLOWED_ORIGINS must use https:// in production');
    }
  }

  if (config.allowPlaintext && !isLoopbackUrl(config.publicBaseUrl)) {
    throw new Error('ALLOW_PLAINTEXT is only permitted for a loopback PUBLIC_BASE_URL');
  }

  if (!config.allowPlaintext && !config.publicBaseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must use https:// unless ALLOW_PLAINTEXT is set for loopback');
  }

  return config;
}

/** Safe rendering for logs and diagnostics: no secrets, no credentials. */
export function describe(config: Config): Record<string, unknown> {
  return {
    node_env: config.nodeEnv,
    http: `${config.httpHost}:${config.httpPort}`,
    static_console: config.staticRoot !== undefined,
    public_base_url: config.publicBaseUrl,
    enrollment_token_ttl_ms: config.enrollmentTokenTtlMs,
    challenge_ttl_ms: config.challengeTtlMs,
    heartbeat_interval_ms: config.heartbeatIntervalMs,
    max_frame_bytes: config.maxFrameBytes,
    max_command_payload_bytes: config.maxCommandPayloadBytes,
    event_batch_size: config.eventBatchSize,
    max_connections: config.maxConnections,
    allow_plaintext: config.allowPlaintext,
    trust_proxy: config.trustProxy,
    operator_compatibility: config.operatorCompatibility,
    allowed_origins: config.allowedOrigins,
    session_idle_timeout_ms: config.sessionIdleTimeoutMs,
    session_absolute_timeout_ms: config.sessionAbsoluteTimeoutMs,
    log_level: config.logLevel,
  };
}
