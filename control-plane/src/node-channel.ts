/**
 * Authenticated Node WebSocket channel.
 *
 * Handles the v1 handshake, keeps the in-memory session registry, dispatches
 * durable commands, ingests events, and maintains liveness. Externally
 * important state lives in PostgreSQL; only the live socket and its per-session
 * bookkeeping are in memory, so a restart loses connections but never facts.
 */
import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import type { Config } from './config.js';
import { type Pool, withTransaction } from './db.js';
import {
  MESSAGE_TYPES,
  ProtocolError,
  ERROR_CODES,
  authTranscript,
  buildEnvelope,
  ClientAuthenticateSchema,
  ClientHelloSchema,
  CommandResultSchema,
  decodeEnvelope,
  encodeEnvelope,
  errorEnvelope,
  EventDeliverySchema,
  negotiateVersion,
  newNonce,
  verifySignature,
} from './protocol.js';
import {
  auditRepo,
  commandsRepo,
  eventsRepo,
  nodesRepo,
  projectsRepo,
  runsRepo,
  sessionsRepo,
} from './repositories.js';
import {
  PROVISION_COMMAND,
  PROVISION_COMMAND_VERSION,
  isRetryable,
  knownFailure,
} from './project-provisioning.js';
import { productNodesRepo, productProjectsRepo } from './product-repositories.js';
import {
  DeviceAuthorizationRelay,
  isProviderState,
  nodeCanAuthorizeProvider,
  readDeviceAuthorization,
} from './provider-authorization.js';
import type { Logger } from './logger.js';

interface LiveSession {
  sessionId: string;
  nodeId: string;
  socket: WebSocket;
  protocolVersion: number;
  instanceId: string;
  authenticatedAt: number;
  lastInboundAt: number;
  /** Runs this session has already been asked to subscribe to. */
  subscribed: Set<string>;
}

export interface ChannelMetrics {
  connectedNodes: number;
  protocolErrors: number;
  authFailures: number;
  sessionsReplaced: number;
  commandsDispatched: number;
  eventsIngested: number;
  duplicateEvents: number;
  gapsDetected: number;
}

/**
 * Registry of live Node sessions plus everything that acts on them.
 *
 * One instance per process. Command dispatch and event acknowledgement both go
 * through here so there is a single place that knows which socket is active for
 * a Node.
 */
/**
 * How often one Node may be asked for its provider state on demand.
 *
 * The console polls every three seconds, per open browser. Asking on every poll
 * would put a command on the wire for each of them; asking rarely would leave a
 * person watching a spinner after they had already approved.
 */
const PROVIDER_STATUS_INTERVAL_MS = 3_000;

/**
 * What may be written to the database as a command's result.
 *
 * Almost everything. The exception is a device authorization: the pair a person
 * types into a browser is a temporary secret, and the relay that holds it does
 * so in memory, for as long as it is valid and no longer, precisely so that it
 * cannot be found afterwards. Persisting the same pair here defeated that
 * entirely -- the code outlived the minute it was useful for and sat in a row
 * anyone with database access could read, indefinitely.
 *
 * The command row keeps the shape of the answer, so an operator can still see
 * that the Node replied and with what kind of result, and none of its content.
 */
export function storableResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!('user_code' in record) && !('verification_uri' in record)) return result;
  return { redacted: 'device_authorization' };
}

export class NodeChannel {
  private readonly sessions = new Map<string, LiveSession>();
  /** When each Node was last asked for its provider state. */
  private readonly providerStatusAsked = new Map<string, number>();
  private readonly nonces = new Set<string>();
  private readonly metrics: ChannelMetrics = {
    connectedNodes: 0,
    protocolErrors: 0,
    authFailures: 0,
    sessionsReplaced: 0,
    commandsDispatched: 0,
    eventsIngested: 0,
    duplicateEvents: 0,
    gapsDetected: 0,
  };
  private dispatchTimer: NodeJS.Timeout | null = null;
  /**
   * Device codes waiting for a person, held in memory only.
   *
   * On the channel rather than in a repository because that is the boundary the
   * code crosses: the Node offers it, one browser is shown it, and it expires.
   * Nothing about it belongs in PostgreSQL.
   */
  readonly deviceAuthorizations = new DeviceAuthorizationRelay();
  private lastExpirySweepAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  /** Start the periodic dispatch and liveness loop. */
  start(): void {
    if (this.dispatchTimer) return;
    this.dispatchTimer = setInterval(() => {
      void this.tick().catch((error) => {
        this.log.error('dispatch tick failed', { error: String(error) });
      });
    }, 250);
  }

  async stop(): Promise<void> {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    for (const session of [...this.sessions.values()]) {
      await this.closeSession(session, 'control_plane_shutdown');
    }
  }

  snapshot(): ChannelMetrics {
    return { ...this.metrics, connectedNodes: this.sessions.size };
  }

  isOnline(nodeId: string): boolean {
    return this.sessions.has(nodeId);
  }

  /**
   * Ask a Node for its provider state, if it is worth asking right now.
   *
   * A person approves a device code in a browser, and nothing about that reaches
   * this process: the credential is written on the Node's own disk by a CLI
   * neither side is watching. Without this, the state stays `authorizing` until
   * the Node happens to reconnect -- and `canDispatchRuns` refuses every run in
   * the meantime, so the project a person just authorized stays unusable for as
   * long as the connection happens to hold.
   *
   * Called from the endpoint the console polls while it is showing a code, so
   * the answer arrives within seconds of the approval. Rate-limited, because
   * that poll is every three seconds and per browser.
   */
  async refreshProviderState(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) return;
    const now = Date.now();
    const asked = this.providerStatusAsked.get(nodeId) ?? 0;
    if (now - asked < PROVIDER_STATUS_INTERVAL_MS) return;
    this.providerStatusAsked.set(nodeId, now);
    // Failures are the caller's business only in that they must not fail the
    // page: a status that could not be asked for is the state the console
    // already has.
    await this.requestAfterHandshake(session, 'provider.status').catch(() => undefined);
  }

  /** Terminate a Node's session, used when an operator revokes its identity. */
  async disconnect(nodeId: string, reason: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (session) await this.closeSession(session, reason);
  }

  // ------------------------------------------------------------ handshake

  /** Drive one accepted socket through authentication and then serve it. */
  async handleConnection(socket: WebSocket, remoteAddress: string | null): Promise<void> {
    const sessionId = `sess-${randomUUID()}`;
    let authenticated: LiveSession | null = null;

    // An unauthenticated socket is a liability: it gets a hard deadline.
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        this.log.warn('handshake timed out', { session_id: sessionId });
        socket.close(4408, 'handshake timeout');
      }
    }, this.config.handshakeTimeoutMs);

    const state = { hello: null as null | ReturnType<typeof ClientHelloSchema.parse> };
    let challenge: { nonce: string; issuedAt: number; expiresAt: number; version: number } | null =
      null;

    // `ws` emits messages synchronously, but every handler below performs
    // asynchronous PostgreSQL work. Chain frames per socket so a replay burst
    // cannot open one database transaction per event, exhaust the pool, or
    // process acknowledgements out of order.
    let frameQueue = Promise.resolve();
    socket.on('message', (raw: Buffer) => {
      frameQueue = frameQueue.then(async () => {
        let envelope;
        try {
          envelope = decodeEnvelope(raw);
        } catch (error) {
          this.metrics.protocolErrors += 1;
          this.send(socket, errorEnvelope(error as ProtocolError));
          return;
        }

        try {
          if (authenticated) {
            authenticated.lastInboundAt = Date.now();
            await this.handleAuthenticatedFrame(authenticated, envelope);
            return;
          }

          if (envelope.type === MESSAGE_TYPES.clientHello) {
            const hello = ClientHelloSchema.parse(envelope.payload);
            state.hello = hello;

            const version = negotiateVersion(hello.supported_versions);
            if (version === null) {
              throw new ProtocolError(ERROR_CODES.unsupportedVersion, 'no shared protocol version');
            }
            const issuedAt = Date.now();
            challenge = {
              nonce: newNonce(),
              issuedAt,
              expiresAt: issuedAt + this.config.challengeTtlMs,
              version,
            };
            await sessionsRepo
              .open(this.pool, { sessionId, nodeId: hello.node_id, remoteAddress })
              .catch(() => undefined);

            this.send(
              socket,
              buildEnvelope(
                MESSAGE_TYPES.serverChallenge,
                {
                  protocol_version: version,
                  session_id: sessionId,
                  server_nonce: challenge.nonce,
                  issued_at: issuedAt,
                  expires_at: challenge.expiresAt,
                },
                envelope.message_id,
              ),
            );
            return;
          }

          if (envelope.type === MESSAGE_TYPES.clientAuthenticate) {
            const auth = ClientAuthenticateSchema.parse(envelope.payload);
            const hello = state.hello;
            if (!hello || !challenge) {
              throw new ProtocolError(ERROR_CODES.notAuthenticated, 'no challenge is outstanding');
            }
            authenticated = await this.completeAuthentication({
              socket,
              sessionId,
              hello,
              challenge,
              signature: auth.signature,
              remoteAddress,
            });
            clearTimeout(handshakeTimer);
            return;
          }

          throw new ProtocolError(
            ERROR_CODES.notAuthenticated,
            `message ${envelope.type} is not permitted before authentication`,
          );
        } catch (error) {
          const protocolError =
            error instanceof ProtocolError
              ? error
              : new ProtocolError(ERROR_CODES.malformedFrame, String((error as Error).message));
          this.metrics.protocolErrors += 1;
          if (
            protocolError.code === ERROR_CODES.authenticationFailed ||
            protocolError.code === ERROR_CODES.challengeExpired ||
            protocolError.code === ERROR_CODES.challengeReplayed ||
            protocolError.code === ERROR_CODES.unknownNode
          ) {
            this.metrics.authFailures += 1;
          }
          this.send(socket, errorEnvelope(protocolError, envelope.message_id));
          if (!authenticated) socket.close(4401, protocolError.code);
        }
      });
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      const session = authenticated;
      if (session && this.sessions.get(session.nodeId)?.sessionId === session.sessionId) {
        this.sessions.delete(session.nodeId);
        void this.recordDisconnect(session, 'socket_closed');
      }
    });

    socket.on('error', () => {
      /* close handler performs the bookkeeping */
    });
  }

  /** Verify the signature and activate the session, or throw a typed error. */
  private async completeAuthentication(input: {
    socket: WebSocket;
    sessionId: string;
    hello: ReturnType<typeof ClientHelloSchema.parse>;
    challenge: { nonce: string; issuedAt: number; expiresAt: number; version: number };
    signature: string;
    remoteAddress: string | null;
  }): Promise<LiveSession> {
    const { hello, challenge, sessionId } = input;

    if (Date.now() > challenge.expiresAt) {
      throw new ProtocolError(ERROR_CODES.challengeExpired, 'the challenge has expired');
    }
    // Nonce reuse is the Control Plane's responsibility: the Node cannot detect it.
    if (this.nonces.has(challenge.nonce)) {
      throw new ProtocolError(ERROR_CODES.challengeReplayed, 'this challenge was already used');
    }

    const node = await nodesRepo.byId(this.pool, hello.node_id);
    if (!node) {
      throw new ProtocolError(ERROR_CODES.unknownNode, 'this node is not enrolled');
    }
    if (node.revoked_at) {
      throw new ProtocolError(ERROR_CODES.unknownNode, 'this node identity has been revoked');
    }
    if (node.fingerprint !== hello.public_key_fingerprint) {
      throw new ProtocolError(
        ERROR_CODES.authenticationFailed,
        'the presented fingerprint does not match the enrolled identity',
      );
    }

    const transcript = authTranscript({
      protocolVersion: challenge.version,
      nodeId: hello.node_id,
      instanceId: hello.instance_id,
      sessionId,
      clientNonce: hello.client_nonce,
      serverNonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      capabilitiesDigest: hello.capabilities_digest,
    });

    if (!verifySignature(node.public_key, transcript, input.signature)) {
      await auditRepo.record(this.pool, {
        action: 'node.authentication',
        actor: hello.node_id,
        targetType: 'node',
        targetId: hello.node_id,
        result: 'failure',
        detail: { reason: 'signature_verification_failed' },
      });
      throw new ProtocolError(ERROR_CODES.authenticationFailed, 'signature verification failed');
    }

    this.nonces.add(challenge.nonce);

    // Deterministic replacement: the newest authenticated session wins, and the
    // previous one is closed with a typed reason so the old Node knows why.
    const existing = this.sessions.get(hello.node_id);
    if (existing) {
      this.metrics.sessionsReplaced += 1;
      await auditRepo.record(this.pool, {
        action: 'node.session_replaced',
        actor: hello.node_id,
        targetType: 'node',
        targetId: hello.node_id,
        result: 'success',
        detail: { replaced_session: existing.sessionId, new_session: sessionId },
      });
      await this.closeSession(existing, ERROR_CODES.sessionReplaced);
    }

    const session: LiveSession = {
      sessionId,
      nodeId: hello.node_id,
      socket: input.socket,
      protocolVersion: challenge.version,
      instanceId: hello.instance_id,
      authenticatedAt: Date.now(),
      lastInboundAt: Date.now(),
      subscribed: new Set(),
    };
    this.sessions.set(hello.node_id, session);

    await withTransaction(this.pool, async (client) => {
      await sessionsRepo.authenticate(client, sessionId, {
        protocolVersion: challenge.version,
        instanceId: hello.instance_id,
        capabilitiesDigest: hello.capabilities_digest,
      });
      await nodesRepo.recordSession(client, hello.node_id, {
        sessionId,
        instanceId: hello.instance_id,
        softwareVersion: hello.software_version,
        protocolVersion: challenge.version,
        capabilities: { digest: hello.capabilities_digest },
      });
      await auditRepo.record(client, {
        action: 'node.authentication',
        actor: hello.node_id,
        targetType: 'node',
        targetId: hello.node_id,
        result: 'success',
        correlationId: sessionId,
        detail: { protocol_version: challenge.version },
      });
    });

    this.send(
      input.socket,
      buildEnvelope(MESSAGE_TYPES.serverReady, {
        session_id: sessionId,
        protocol_version: challenge.version,
        server_metadata: { control_plane: 'asterism' },
      }),
    );

    this.log.info('node session established', {
      node_id: hello.node_id,
      session_id: sessionId,
      protocol_version: challenge.version,
    });

    // Learn the Node's project inventory and re-establish subscriptions.
    void this.synchronise(session).catch((error) =>
      this.log.error('post-authentication sync failed', {
        node_id: session.nodeId,
        error: String(error),
      }),
    );

    return session;
  }

  // --------------------------------------------------------------- frames

  private async handleAuthenticatedFrame(
    session: LiveSession,
    envelope: ReturnType<typeof decodeEnvelope>,
  ): Promise<void> {
    switch (envelope.type) {
      case MESSAGE_TYPES.clientHeartbeat: {
        await sessionsRepo.heartbeat(this.pool, session.sessionId).catch(() => undefined);
        await nodesRepo.touch(this.pool, session.nodeId).catch(() => undefined);
        const payload = envelope.payload as Record<string, unknown> | undefined;
        if (typeof payload?.draining === 'boolean') {
          await nodesRepo.setDraining(this.pool, session.nodeId, payload.draining);
        }
        this.send(
          session.socket,
          buildEnvelope(MESSAGE_TYPES.serverHeartbeatAck, {}, envelope.message_id),
        );
        return;
      }

      case MESSAGE_TYPES.clientCommandAccepted: {
        const commandId = (envelope.payload as { command_id?: string })?.command_id;
        if (commandId) await commandsRepo.markAccepted(this.pool, commandId);
        return;
      }

      case MESSAGE_TYPES.clientCommandResult: {
        await this.handleCommandResult(session, envelope);
        return;
      }

      case MESSAGE_TYPES.clientEvent: {
        await this.handleEvent(session, envelope);
        return;
      }

      case MESSAGE_TYPES.error: {
        // A Node telling this Control Plane it could not do something is not a
        // protocol violation, and answering it with one is how a single unknown
        // command took every Node offline: the Node replied `error`, this
        // dispatcher called that an unsupported message type, and the Node
        // treated *that* as fatal and reconnected — forever.
        //
        // Recorded and carried on. The command it belongs to is already failed
        // by its own result, or will time out; the session is not the casualty.
        const payload = (envelope.payload ?? {}) as Record<string, unknown>;
        this.log.warn('node reported an error frame', {
          node_id: session.nodeId,
          // The Node's own code and message, which are typed and safe. Nothing
          // from a payload is echoed back to it.
          code: typeof payload.code === 'string' ? payload.code : 'unknown',
        });
        return;
      }

      default: {
        this.metrics.protocolErrors += 1;
        this.send(
          session.socket,
          errorEnvelope(
            new ProtocolError(
              ERROR_CODES.unknownMessageType,
              `unsupported message type ${envelope.type}`,
            ),
            envelope.message_id,
          ),
        );
      }
    }
  }

  /** Persist a command result, then acknowledge so the Node can drop it. */
  private async handleCommandResult(
    session: LiveSession,
    envelope: ReturnType<typeof decodeEnvelope>,
  ): Promise<void> {
    const parsed = CommandResultSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.metrics.protocolErrors += 1;
      return;
    }
    const result = parsed.data;
    const state = result.state === 'completed' ? 'completed' : 'failed';

    const command = await withTransaction(this.pool, async (client) => {
      // Idempotent: a retransmitted result does not overwrite a recorded one.
      const updated = await commandsRepo.complete(client, result.command_id, {
        state,
        response: storableResult(result.result ?? null),
        errorCode: result.error_code ?? null,
        errorPayload: result.error_message ? { message: result.error_message } : null,
      });

      const command = updated ?? (await commandsRepo.byId(client, result.command_id));
      if (command) await this.applyCommandOutcome(client, command, result);
      return command;
    });

    // A complete inventory snapshot is applied outside the result transaction so
    // one long project list cannot hold the command row lock.
    if (command?.command_type === 'projects.list') {
      const projects = (result.result as { projects?: unknown } | null)?.projects;
      await this.applyProjectInventory(session.nodeId, projects);
    }

    if (command?.command_type === 'capabilities.get' && state === 'completed') {
      const payload = result.result as { capabilities?: unknown } | null;
      const capabilities = payload?.capabilities ?? payload;
      await this.applyCapabilities(session.nodeId, capabilities);
      // Asked here rather than during the handshake sequence, because this is
      // the first moment the answer is knowable. `synchronise` runs before any
      // of these results are back, so a Node that had just gained the capability
      // -- every Node, the first time it is upgraded -- was judged unable to
      // answer and never asked.
      if (nodeCanAuthorizeProvider(capabilities)) {
        // Read unscoped: this runs on the Node's own channel, which has no
        // organization in hand, and the row is the same row either way.
        const known = await nodesRepo.byId(this.pool, session.nodeId).catch(() => null);
        // Only when nothing better is known. A Node mid-authorization must not
        // have its state pulled back to whatever it happens to answer now.
        if (
          !known ||
          !isProviderState(known.provider_state) ||
          known.provider_state === 'unknown'
        ) {
          await this.requestAfterHandshake(session, 'provider.status');
        }
      }
    }

    if (
      command?.command_type === 'provider.status' ||
      command?.command_type === 'provider.cancel'
    ) {
      const reported = (result.result as { state?: unknown } | null)?.state;
      if (state === 'completed' && isProviderState(reported)) {
        await productNodesRepo.setProviderState(this.pool, session.nodeId, reported);
      }
      if (command.command_type === 'provider.cancel') {
        this.deviceAuthorizations.forget(session.nodeId);
      }
    }

    if (command?.command_type === 'provider.authorize') {
      if (state === 'completed') {
        const device = readDeviceAuthorization(result.result);
        if (device) {
          this.deviceAuthorizations.remember(session.nodeId, command.organization_id, device);
          await productNodesRepo.setProviderState(this.pool, session.nodeId, 'authorizing');
        } else {
          await productNodesRepo.setProviderState(this.pool, session.nodeId, 'failed');
        }
      } else {
        // The transcript the Node saw is deliberately not carried here: it may
        // contain a partial code, and the typed state is what the console acts on.
        this.deviceAuthorizations.forget(session.nodeId);
        await productNodesRepo.setProviderState(this.pool, session.nodeId, 'failed');
      }
    }

    // Acknowledged only after commit, so a crash mid-write replays the result.
    this.send(
      session.socket,
      buildEnvelope(MESSAGE_TYPES.serverCommandResultAck, { command_id: result.command_id }),
    );
  }

  /**
   * Apply a Node's provisioning result to the project it belongs to.
   *
   * The generation is the whole defence. A Node that reconnects mid-attempt can
   * deliver the outcome of work the operator has already retried past, and
   * accepting it would mark the newer attempt ready on the strength of an older
   * one — the project would claim a worker nobody started. Rather than reading
   * the row and then writing it, the generation travels into the `WHERE`, so a
   * stale result simply matches nothing.
   */
  private async applyProvisioningOutcome(
    client: Parameters<typeof commandsRepo.complete>[0],
    command: { command_id: string; command_type: string; node_id: string },
    result: { state: string; error_code?: string | null; error_message?: string | null },
    payload: Record<string, unknown>,
  ): Promise<void> {
    // An unknown newer event is refused rather than guessed at: a shape this
    // build does not understand must not move a project's state.
    const version = payload.event_version;
    if (version !== undefined && version !== PROVISION_COMMAND_VERSION) {
      this.metrics.protocolErrors += 1;
      return;
    }

    const projectId = typeof payload.project_id === 'string' ? payload.project_id : null;
    const generation =
      typeof payload.provisioning_generation === 'number' ? payload.provisioning_generation : null;
    if (!projectId || generation === null) {
      this.metrics.protocolErrors += 1;
      return;
    }

    // The project is read only to establish ownership; the transition itself is
    // guarded in SQL.
    const owner = await client.query<{ organization_id: string; node_id: string }>(
      'SELECT organization_id, node_id FROM projects WHERE project_id = $1',
      [projectId],
    );
    const project = owner.rows[0];
    // A result from a Node that does not own this project is not a late
    // message; it is a message about something else.
    if (!project || project.node_id !== command.node_id) {
      this.metrics.protocolErrors += 1;
      return;
    }

    const succeeded = result.state === 'completed' && payload.outcome === 'provisioned';
    if (succeeded) {
      const applied = await productProjectsRepo.markProvisioningReady(
        client,
        project.organization_id,
        projectId,
        generation,
      );
      // No row moved means the result was stale, or the project was disabled
      // while it was in flight. Either way nothing happened, so nothing is
      // audited as having happened.
      if (applied) {
        await auditRepo.record(client, {
          action: 'project.provisioning_succeeded',
          actor: command.node_id,
          targetType: 'project',
          targetId: projectId,
          result: 'success',
          organizationId: project.organization_id,
          correlationId: command.command_id,
          detail: {
            node_id: command.node_id,
            provisioning_generation: generation,
            workspace_mode:
              typeof payload.workspace_mode === 'string' ? payload.workspace_mode : null,
            runtime_kind: typeof payload.runtime_kind === 'string' ? payload.runtime_kind : null,
          },
        });
      }
      return;
    }

    // Everything else is a failure, including a command the Node refused
    // outright: the project did not get built either way.
    const reported = typeof payload.failure === 'string' ? payload.failure : null;
    const failure =
      knownFailure(reported) ?? knownFailure(result.error_code) ?? 'profile_provision_failed';
    const message = typeof payload.message === 'string' ? payload.message : null;
    const applied = await productProjectsRepo.markProvisioningFailed(
      client,
      project.organization_id,
      projectId,
      generation,
      failure,
      message,
    );
    if (applied) {
      await auditRepo.record(client, {
        action: 'project.provisioning_failed',
        actor: command.node_id,
        targetType: 'project',
        targetId: projectId,
        result: 'failure',
        organizationId: project.organization_id,
        correlationId: command.command_id,
        detail: {
          node_id: command.node_id,
          provisioning_generation: generation,
          failure,
          retryable: isRetryable(failure),
        },
      });
    }
  }

  /** Translate a command outcome into run state. */
  private async applyCommandOutcome(
    client: Parameters<typeof commandsRepo.complete>[0],
    command: { command_id: string; command_type: string; node_id: string },
    result: {
      state: string;
      result?: unknown;
      error_code?: string | null;
      error_message?: string | null;
    },
  ): Promise<void> {
    const payload = (result.result ?? {}) as Record<string, unknown>;

    if (command.command_type === PROVISION_COMMAND) {
      await this.applyProvisioningOutcome(client, command, result, payload);
      return;
    }

    if (
      result.state !== 'completed' &&
      (command.command_type === 'runs.create' || command.command_type === 'runs.retry')
    ) {
      const run = await client.query<{ run_id: string }>(
        'SELECT run_id FROM runs WHERE create_command_id = $1',
        [command.command_id],
      );
      const runId = run.rows[0]?.run_id;
      if (runId) {
        await runsRepo.setStatus(client, runId, 'failed', {
          terminalReason: 'Node rejected run creation',
          errorCode: result.error_code ?? 'command_failed',
          errorMessage: result.error_message ?? 'run creation command failed',
        });
      }
      return;
    }

    if (command.command_type === 'runs.create' && typeof payload.run_id === 'string') {
      const run = await client.query<{ run_id: string }>(
        'SELECT run_id FROM runs WHERE create_command_id = $1',
        [command.command_id],
      );
      const runId = run.rows[0]?.run_id;
      if (runId) {
        await runsRepo.attachNodeRun(client, runId, payload.run_id);
        await runsRepo.setSubscribed(client, runId, true);
      }
    }

    if (command.command_type === 'runs.retry' && typeof payload.run_id === 'string') {
      const run = await client.query<{ run_id: string }>(
        'SELECT run_id FROM runs WHERE create_command_id = $1',
        [command.command_id],
      );
      const runId = run.rows[0]?.run_id;
      if (runId) {
        await runsRepo.attachNodeRun(client, runId, payload.run_id);
        await runsRepo.setSubscribed(client, runId, true);
      }
    }

    if (command.command_type === 'approvals.resolve' && result.state === 'completed') {
      const run = await client.query<{ run_id: string; status: string }>(
        `SELECT run_id, status
           FROM runs
          WHERE node_id = $1
            AND node_run_id = (
              SELECT request_payload->>'run_id' FROM remote_commands WHERE command_id = $2
            )`,
        [command.node_id, command.command_id],
      );
      const resolved = run.rows[0];
      if (resolved?.status === 'waiting_for_approval') {
        await runsRepo.setStatus(client, resolved.run_id, 'running');
      }
    }
  }

  /**
   * Ingest one event, then acknowledge only the highest **contiguous** sequence.
   *
   * Acknowledging past a gap would tell the Node to stop resending events that
   * were never stored, so the cursor advances only over a gapless prefix.
   */
  private async handleEvent(
    session: LiveSession,
    envelope: ReturnType<typeof decodeEnvelope>,
  ): Promise<void> {
    const parsed = EventDeliverySchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.metrics.protocolErrors += 1;
      return;
    }
    const event = parsed.data;

    const acked = await withTransaction(this.pool, async (client) => {
      const run = await runsRepo.byNodeRunId(client, session.nodeId, event.run_id);
      if (!run) return null;

      const inserted = await eventsRepo.insert(client, {
        nodeId: session.nodeId,
        runId: run.run_id,
        seq: event.seq,
        projectId: run.project_id,
        eventType: event.event_type,
        recordedAt: event.recorded_at ?? null,
        payload: event.payload,
        source: 'node',
      });
      if (inserted) this.metrics.eventsIngested += 1;
      else this.metrics.duplicateEvents += 1;

      const contiguous = await eventsRepo.highestContiguous(
        client,
        run.run_id,
        Number(run.acked_event_seq),
      );
      if (contiguous > Number(run.acked_event_seq)) {
        await eventsRepo.setAckedSeq(client, run.run_id, contiguous);
      } else if (event.seq > contiguous + 1) {
        this.metrics.gapsDetected += 1;
      }

      const failure = runFailureFromEvent(event.event_type, event.payload);

      // A terminal run needs no further subscription.
      const terminal = terminalStatusFromEvent(event.event_type, event.payload);
      if (terminal) {
        await runsRepo.setStatus(client, run.run_id, terminal, failure ?? {});
        await runsRepo.setSubscribed(client, run.run_id, false);
      } else {
        // The reason a run failed arrives before the event that ends it, so it
        // is recorded on its own rather than waiting for a terminal event that
        // does not carry it.
        if (failure) await runsRepo.recordFailure(client, run.run_id, failure);
        if (
          inserted &&
          liveStatusFromEvent(event.event_type) === 'waiting_for_approval' &&
          !TERMINAL_RUN_STATUSES.has(run.status)
        ) {
          await runsRepo.setStatus(client, run.run_id, 'waiting_for_approval');
        }
      }

      return contiguous;
    });

    if (acked === null) return;

    // Acknowledged strictly after commit.
    this.send(
      session.socket,
      buildEnvelope(MESSAGE_TYPES.serverEventAck, {
        run_id: event.run_id,
        acked_seq: acked,
      }),
    );
  }

  // ------------------------------------------------------------- dispatch

  /**
   * One scheduling tick.
   *
   * Nodes are visited round-robin so no single busy Node starves the others,
   * and per Node the oldest queued commands go first.
   */
  private async tick(): Promise<void> {
    // Before anything session-shaped: a command stranded by a dead session
    // belongs to no session, and its Node may not be connected at all.
    if (Date.now() - this.lastExpirySweepAt >= EXPIRY_SWEEP_INTERVAL_MS) {
      this.lastExpirySweepAt = Date.now();
      await expireStaleCommands(this.pool, this.config, this.log);
    }

    const nodeIds = [...this.sessions.keys()];
    for (const nodeId of nodeIds) {
      const session = this.sessions.get(nodeId);
      if (!session) continue;

      // Liveness: no inbound traffic for the configured window ends the session.
      const silentFor = Date.now() - session.lastInboundAt;
      if (silentFor > this.config.heartbeatIntervalMs * this.config.heartbeatMissedLimit * 2) {
        this.log.warn('node session timed out', { node_id: nodeId, silent_ms: silentFor });
        await this.closeSession(session, 'heartbeat_timeout');
        continue;
      }

      await this.dispatchFor(session);
      await this.ensureSubscriptions(session);
    }
  }

  private async dispatchFor(session: LiveSession): Promise<void> {
    const node = await nodesRepo.byId(this.pool, session.nodeId);
    if (!node || node.revoked_at) return;

    await withTransaction(this.pool, async (client) => {
      const pending = await commandsRepo.claimPending(client, session.nodeId, 8);
      for (const command of pending) {
        // A draining Node accepts no new run creation.
        if (node.draining && command.command_type === 'runs.create') continue;

        await commandsRepo.markDispatched(client, command.command_id);
        this.send(
          session.socket,
          buildEnvelope(MESSAGE_TYPES.serverCommand, {
            command_id: command.command_id,
            command: command.command_type,
            project_id: await nodeProjectIdFor(client, command.project_id),
            payload: command.request_payload,
          }),
        );
        this.metrics.commandsDispatched += 1;
      }
    });
  }

  /** Ask the Node to stream any subscribed run this session has not covered. */
  private async ensureSubscriptions(session: LiveSession): Promise<void> {
    const runs = await runsRepo.subscribedRuns(this.pool, session.nodeId);
    for (const run of runs) {
      if (!run.node_run_id || session.subscribed.has(run.run_id)) continue;
      const project = await projectsRepo.byId(this.pool, run.project_id);
      if (!project) continue;

      session.subscribed.add(run.run_id);
      const command = await commandsRepo.create(this.pool, {
        nodeId: session.nodeId,
        projectId: run.project_id,
        commandType: 'events.subscribe',
        payload: { run_id: run.node_run_id, from_seq: Number(run.acked_event_seq) },
        digest: 'subscription',
      });
      await commandsRepo.markDispatched(this.pool, command.command_id);
      this.send(
        session.socket,
        buildEnvelope(MESSAGE_TYPES.serverCommand, {
          command_id: command.command_id,
          command: 'events.subscribe',
          project_id: project.node_project_id,
          payload: { run_id: run.node_run_id, from_seq: Number(run.acked_event_seq) },
        }),
      );
    }
  }

  /** Learn the Node's project inventory right after authentication. */
  private async synchronise(session: LiveSession): Promise<void> {
    await this.requestAfterHandshake(session, 'projects.list');
    // The handshake carries only a *digest* of the Node's capabilities, so what
    // the Node can actually do has to be asked for. Requested on every
    // authentication, which is what keeps the stored snapshot honest across an
    // upgrade that adds or removes a capability.
    await this.requestAfterHandshake(session, 'capabilities.get');
    // Asked only of a Node that has said it understands the question. A Node
    // that predates provider reporting answers an unknown command with an error
    // frame, and there is nothing to learn from making it do that on every
    // connection.
    //
    // Provider authorization is deliberately not part of the capability
    // advertisement — it changes without the digest changing, so a console that
    // refreshed it only on upgrade would offer to authorize a host that already
    // is — but whether the Node *can* answer is.
    const known = await nodesRepo.byId(this.pool, session.nodeId);
    if (nodeCanAuthorizeProvider(known?.capabilities)) {
      await this.requestAfterHandshake(session, 'provider.status');
    }
  }

  /** Issue one payload-free command immediately after authentication. */
  private async requestAfterHandshake(session: LiveSession, commandType: string): Promise<void> {
    const command = await commandsRepo.create(this.pool, {
      nodeId: session.nodeId,
      projectId: null,
      commandType,
      payload: {},
      digest: `sync:${commandType}`,
    });
    await commandsRepo.markDispatched(this.pool, command.command_id);
    this.send(
      session.socket,
      buildEnvelope(MESSAGE_TYPES.serverCommand, {
        command_id: command.command_id,
        command: commandType,
        project_id: null,
        payload: {},
      }),
    );
  }

  /**
   * Store what the Node reported it can do.
   *
   * Kept as the authenticated advertisement rather than anything derived: the
   * sanitizing happens where it is read, so a capability this Control Plane
   * does not understand today is still recorded and becomes usable when it
   * does, without a second handshake.
   */
  async applyCapabilities(nodeId: string, capabilities: unknown): Promise<void> {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return;
    await nodesRepo.recordCapabilities(this.pool, nodeId, capabilities as Record<string, unknown>);
  }

  /** Apply a `projects.list` result as a complete inventory snapshot. */
  async applyProjectInventory(nodeId: string, projects: unknown): Promise<void> {
    if (!Array.isArray(projects)) return;
    const present: string[] = [];

    await withTransaction(this.pool, async (client) => {
      for (const raw of projects) {
        const project = raw as Record<string, unknown>;
        const nodeProjectId = project.project_id;
        if (typeof nodeProjectId !== 'string') continue;
        present.push(nodeProjectId);
        await projectsRepo.upsert(client, {
          nodeId,
          nodeProjectId,
          displayName:
            typeof project.display_name === 'string' ? project.display_name : nodeProjectId,
          enabled: project.enabled !== false,
          metadata: project.metadata ?? {},
        });
      }
      // Only a complete snapshot may mark projects unavailable.
      if (present.length > 0) {
        await projectsRepo.markAbsentUnavailable(client, nodeId, present);
      }
    });
  }

  // -------------------------------------------------------------- helpers

  private async closeSession(session: LiveSession, reason: string): Promise<void> {
    try {
      session.socket.close(4000, reason);
    } catch {
      /* already gone */
    }
    this.sessions.delete(session.nodeId);
    await this.recordDisconnect(session, reason);
  }

  private async recordDisconnect(session: LiveSession, reason: string): Promise<void> {
    await sessionsRepo.close(this.pool, session.sessionId, reason).catch(() => undefined);
    await nodesRepo.setConnectionState(this.pool, session.nodeId, 'offline').catch(() => undefined);
    this.log.info('node session closed', { node_id: session.nodeId, reason });
  }

  private send(socket: WebSocket, envelope: ReturnType<typeof buildEnvelope>): void {
    try {
      socket.send(encodeEnvelope(envelope));
    } catch (error) {
      this.log.warn('failed to send frame', { error: String(error) });
    }
  }
}

/** Map a Control Plane project id to the Node-local id the wire expects. */
async function nodeProjectIdFor(
  client: { query: Pool['query'] },
  projectId: string | null,
): Promise<string | null> {
  if (!projectId) return null;
  const result = await client.query<{ node_project_id: string }>(
    'SELECT node_project_id FROM projects WHERE project_id = $1',
    [projectId],
  );
  return result.rows[0]?.node_project_id ?? null;
}

/**
 * Run statuses the Node treats as final. A run in any of these will never
 * produce another event, so the Control Plane must stop showing it as active.
 */
export const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
  'rejected',
]);

/**
 * Recognise the Node's terminal run event.
 *
 * Two events can end a run, and missing the second one is what makes a run
 * appear active forever:
 *
 * * `asterism.run.terminal` — the Node observed the backend finish the run.
 * * `asterism.reconciled` — the Node found, after a restart or a lost stream,
 *   that the backend no longer knows the run. Its `new_status` is authoritative
 *   and is frequently terminal (`interrupted`, `lost`). Ignoring it leaves the
 *   Control Plane reporting `running` for a run the Node has already closed.
 */
/** How often the stranded-command sweep runs. The tick itself is every 250ms. */
const EXPIRY_SWEEP_INTERVAL_MS = 5_000;

/**
 * Ends commands that were delivered into a session that died before answering.
 *
 * A command is sent exactly once. If the session carrying it ends before the
 * Node replies, that delivery is gone: nothing re-sends it, and the Node has no
 * record of it either. The command then stays `dispatched` and its run stays
 * `queued`, which is worse than it sounds — a project runs one run at a time, so
 * a single lost message leaves the project unable to start anything ever again.
 *
 * Neither recovery path reaches that state. `cancel` refuses because the Node
 * never accepted the run; `force-close` refuses because the Node is online. They
 * exclude each other precisely here.
 *
 * `commandTimeoutMs` already existed, with a default and an environment
 * override. Nothing applied it. This applies it.
 *
 * The run becomes `lost` rather than `failed` on purpose. The command reached
 * the wire, so whether the Node acted on it is genuinely unknown, and `failed`
 * would assert something no one here can know.
 */
export async function expireStaleCommands(
  pool: Pool,
  config: Config,
  log: Logger,
): Promise<number> {
  const stale = await commandsRepo.staleDispatched(pool, config.commandTimeoutMs);
  if (stale.length === 0) return 0;

  for (const command of stale) {
    await withTransaction(pool, async (client) => {
      await commandsRepo.markIndeterminate(
        client,
        command.command_id,
        'no result before the command timeout',
      );

      // The same lookup a Node-side rejection uses, so a timed-out creation
      // lands the run in exactly the shape an operator already recognises.
      if (command.command_type === 'runs.create' || command.command_type === 'runs.retry') {
        const run = await client.query<{ run_id: string }>(
          'SELECT run_id FROM runs WHERE create_command_id = $1',
          [command.command_id],
        );
        const runId = run.rows[0]?.run_id;
        if (runId) {
          await runsRepo.setStatus(client, runId, 'lost', {
            terminalReason: 'command_timeout',
            errorCode: 'command_timeout',
            errorMessage: 'the Node never answered the command that would have started this run',
          });
          await runsRepo.setSubscribed(client, runId, false);
        }
      }
    });

    log.warn('command expired without a result', {
      command_id: command.command_id,
      command_type: command.command_type,
      node_id: command.node_id,
      dispatched_at: command.dispatched_at,
    });
  }

  return stale.length;
}

export function terminalStatusFromEvent(eventType: string, payload: unknown): string | null {
  const fields = payload as { status?: unknown; new_status?: unknown } | null;

  if (eventType === 'asterism.run.terminal') {
    return typeof fields?.status === 'string' ? fields.status : null;
  }

  if (eventType === 'asterism.reconciled') {
    const status = fields?.new_status;
    // A reconciliation may also move a run back to a live state; only a
    // terminal outcome ends it here.
    if (typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status)) return status;
    return null;
  }

  return null;
}

/**
 * The failure reason a Node event carries, if any.
 *
 * Hermes explains why a turn ended in `run.failed` — a quota rejection, an
 * authentication failure, a storage error — but that is not the event that ends
 * the run: `asterism.run.terminal` follows it carrying only a status. Nothing
 * read the explanation, so every one of those outcomes reached the console as a
 * bare "failed" with no assistant output and no reason.
 *
 * The two producers spell it differently, so each is read on its own terms. A
 * Node-side refusal puts a slug in `error` and the prose in `message`; Hermes
 * puts the prose in `error` and has no slug.
 */
export function runFailureFromEvent(
  eventType: string,
  payload: unknown,
): { errorCode?: string; errorMessage?: string } | null {
  const fields = payload as { error?: unknown; message?: unknown } | null;
  if (!fields) return null;

  // The column is bounded by the wire schema; a runtime that sends more must
  // not fail the whole ingestion.
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.slice(0, 4096) : undefined;

  if (eventType === 'run.failed') {
    const errorMessage = text(fields.error);
    return errorMessage ? { errorMessage } : null;
  }

  if (eventType === 'asterism.run.terminal') {
    const errorCode = text(fields.error);
    const errorMessage = text(fields.message);
    if (!errorCode && !errorMessage) return null;
    return { ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}) };
  }

  return null;
}

/** Status changes carried by non-terminal Node events. */
export function liveStatusFromEvent(eventType: string): string | null {
  return eventType === 'approval.request' ? 'waiting_for_approval' : null;
}
