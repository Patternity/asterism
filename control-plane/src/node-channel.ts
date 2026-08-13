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
export class NodeChannel {
  private readonly sessions = new Map<string, LiveSession>();
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
        response: result.result ?? null,
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

    // Acknowledged only after commit, so a crash mid-write replays the result.
    this.send(
      session.socket,
      buildEnvelope(MESSAGE_TYPES.serverCommandResultAck, { command_id: result.command_id }),
    );
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

      // A terminal run needs no further subscription.
      const terminal = terminalStatusFromEvent(event.event_type, event.payload);
      if (terminal) {
        await runsRepo.setStatus(client, run.run_id, terminal);
        await runsRepo.setSubscribed(client, run.run_id, false);
      } else if (
        inserted &&
        liveStatusFromEvent(event.event_type) === 'waiting_for_approval' &&
        !TERMINAL_RUN_STATUSES.has(run.status)
      ) {
        await runsRepo.setStatus(client, run.run_id, 'waiting_for_approval');
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
    const command = await commandsRepo.create(this.pool, {
      nodeId: session.nodeId,
      projectId: null,
      commandType: 'projects.list',
      payload: {},
      digest: 'sync',
    });
    await commandsRepo.markDispatched(this.pool, command.command_id);
    this.send(
      session.socket,
      buildEnvelope(MESSAGE_TYPES.serverCommand, {
        command_id: command.command_id,
        command: 'projects.list',
        project_id: null,
        payload: {},
      }),
    );
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

/** Status changes carried by non-terminal Node events. */
export function liveStatusFromEvent(eventType: string): string | null {
  return eventType === 'approval.request' ? 'waiting_for_approval' : null;
}
