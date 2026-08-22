/**
 * Production deployment guard.
 *
 * `loadConfig` already refuses an unsafe configuration — but only once the
 * process is starting, on the server, after a deployment is already under way.
 * This audits the *resolved Compose configuration* instead, so the same
 * mistakes are caught in CI and before `up -d`, where they cost nothing.
 *
 * It deliberately checks the deployment shape as well as the environment: a
 * perfectly configured application still fails its own security model if
 * PostgreSQL is published to the world or the API binds past the reverse proxy
 * that terminates its TLS.
 */

export interface ComposePort {
  mode?: string;
  host_ip?: string;
  target?: number;
  published?: string | number;
  protocol?: string;
}

export interface ComposeService {
  environment?: Record<string, string | number | boolean | null>;
  ports?: ComposePort[];
}

export interface ComposeConfiguration {
  services?: Record<string, ComposeService>;
}

export interface ConfigurationProblem {
  check: string;
  message: string;
}

/** The service that serves the API and the console. */
const SERVING_SERVICE = 'control-plane';
const DATABASE_SERVICE = 'postgres';

function read(service: ComposeService | undefined, key: string): string | undefined {
  const value = service?.environment?.[key];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function isTrue(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function origins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Every published port must be bound to loopback.
 *
 * Compose defaults an omitted `host_ip` to every interface, so an absent value
 * is a failure rather than a gap in the data.
 */
function publicallyBound(ports: ComposePort[] | undefined): ComposePort[] {
  return (ports ?? []).filter((port) => {
    const host = port.host_ip;
    return host !== '127.0.0.1' && host !== '::1' && host !== 'localhost';
  });
}

export function auditProductionConfiguration(
  configuration: ComposeConfiguration,
): ConfigurationProblem[] {
  const problems: ConfigurationProblem[] = [];
  const add = (check: string, message: string): void => {
    problems.push({ check, message });
  };

  const serving = configuration.services?.[SERVING_SERVICE];
  if (!serving) {
    add('service_present', `the resolved configuration has no ${SERVING_SERVICE} service`);
    return problems;
  }

  if (read(serving, 'NODE_ENV') !== 'production') {
    add(
      'node_env',
      `NODE_ENV is ${read(serving, 'NODE_ENV') ?? 'unset'}; production deployments must say production`,
    );
  }

  const publicBaseUrl = read(serving, 'PUBLIC_BASE_URL');
  if (!publicBaseUrl) {
    add('public_base_url', 'PUBLIC_BASE_URL is not set');
  } else if (!publicBaseUrl.startsWith('https://')) {
    add('public_base_url', 'PUBLIC_BASE_URL must be an https:// address');
  }

  if (isTrue(read(serving, 'ALLOW_PLAINTEXT'))) {
    add('allow_plaintext', 'ALLOW_PLAINTEXT is a loopback development shortcut and must be off');
  }

  const compatibility = read(serving, 'OPERATOR_COMPATIBILITY');
  if (compatibility === undefined) {
    add(
      'operator_compatibility',
      'OPERATOR_COMPATIBILITY must be stated explicitly in production, not left to a default',
    );
  } else if (isTrue(compatibility)) {
    add(
      'operator_compatibility',
      'OPERATOR_COMPATIBILITY is enabled; the deprecated operator-token surface must be off unless deliberately kept',
    );
  }

  const allowed = origins(read(serving, 'ALLOWED_ORIGINS'));
  if (allowed.length === 0) {
    add('allowed_origins', 'ALLOWED_ORIGINS is empty');
  }
  const plaintextOrigins = allowed.filter((origin) => !origin.startsWith('https://'));
  if (plaintextOrigins.length > 0) {
    add('allowed_origins', `these allowed origins are not https: ${plaintextOrigins.join(', ')}`);
  }
  if (publicBaseUrl && allowed.length > 0 && !allowed.includes(publicBaseUrl)) {
    add(
      'allowed_origins',
      `PUBLIC_BASE_URL ${publicBaseUrl} is not in ALLOWED_ORIGINS; the console would be refused at its own address`,
    );
  }

  const databaseUrl = read(serving, 'DATABASE_URL');
  if (!databaseUrl) {
    add('secrets', 'DATABASE_URL is not set');
  }
  const database = configuration.services?.[DATABASE_SERVICE];
  if (database && !read(database, 'POSTGRES_PASSWORD')) {
    add('secrets', 'POSTGRES_PASSWORD is not set for the database service');
  }

  if (database && publicallyBound(database.ports).length > 0) {
    add(
      'database_exposure',
      'PostgreSQL publishes a port beyond loopback; the database belongs on the internal network only',
    );
  }

  const exposed = publicallyBound(serving.ports);
  if (exposed.length > 0) {
    const rendered = exposed
      .map((port) => `${port.host_ip ?? '0.0.0.0'}:${port.published ?? '?'}`)
      .join(', ');
    add(
      'proxy_boundary',
      `${SERVING_SERVICE} publishes ${rendered}; TLS terminates in the reverse proxy, so the container must stay on loopback`,
    );
  }

  return problems;
}
