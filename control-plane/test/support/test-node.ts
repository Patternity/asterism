/**
 * A Node that connects the way a real one does.
 *
 * The alternative — marking a node online in the session map, or stubbing
 * `isOnline` — would test the routes against a fiction. Half of what these
 * routes decide comes from the channel: whether the Node is reachable, what it
 * advertises, and whether a command actually reaches it. A fake that answers
 * "yes" to all three proves nothing about any of them.
 *
 * So this is a real WebSocket, a real Ed25519 handshake against the real
 * challenge, and real capability delivery through `capabilities.get`.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { WebSocket } from 'ws';

import {
  MESSAGE_TYPES,
  authTranscript,
  buildEnvelope,
  fingerprintOf,
  newNonce,
} from '../../src/protocol.js';

/** The capability set a Node with project provisioning advertises. */
export const PROVISIONING_CAPABILITIES = {
  api_version: 1,
  runtime_kinds: ['hermes-loop'],
  projects: {
    multi_project: true,
    project_runtime: 'hermes_home',
    project_provisioning: true,
    project_memory_isolation: true,
    project_session_isolation: true,
    project_workspace_routing: true,
    workspace_modes: ['empty', 'clone'],
    provision_command_version: 1,
  },
} as const;

/** A Node whose build predates project provisioning: it advertises none of it. */
export const LEGACY_CAPABILITIES = {
  api_version: 1,
  runtime_kinds: ['hermes-loop'],
} as const;

export interface ReceivedCommand {
  command_id: string;
  command: string;
  project_id?: string | null;
  payload: Record<string, unknown>;
}

export interface TestNodeKeys {
  publicKeyBase64: string;
  fingerprint: string;
  sign: (message: Buffer) => string;
}

/** An Ed25519 identity in the encoding the protocol uses. */
export function createNodeKeys(): TestNodeKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Raw 32 bytes, which is what the wire carries: the DER wrapper is an
  // encoding detail of this process, not of the protocol.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKeyBase64 = raw.toString('base64');
  return {
    publicKeyBase64,
    fingerprint: fingerprintOf(publicKeyBase64),
    sign: (message: Buffer) => cryptoSign(null, message, privateKey).toString('base64'),
  };
}

/**
 * A connected Node, held open for the duration of a test.
 *
 * Commands that arrive are recorded rather than executed: these tests are about
 * what the Control Plane decides and delivers, and a Node that answered every
 * command would hide whether the right one was sent.
 */
export class TestNode {
  readonly commands: ReceivedCommand[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: ((command: ReceivedCommand) => void)[] = [];

  private constructor(
    socket: WebSocket,
    readonly nodeId: string,
    private readonly capabilities: Record<string, unknown>,
  ) {
    this.socket = socket;
  }

  static async connect(
    baseUrl: string,
    nodeId: string,
    keys: TestNodeKeys,
    capabilities: Record<string, unknown>,
  ): Promise<TestNode> {
    const socket = new WebSocket(`${baseUrl}/v1/node/session`);
    const node = new TestNode(socket, nodeId, capabilities);
    await node.handshake(keys);
    return node;
  }

  private send(type: string, payload: unknown, correlationId?: string): void {
    this.socket.send(JSON.stringify(buildEnvelope(type, payload, correlationId)));
  }

  private async handshake(keys: TestNodeKeys): Promise<void> {
    const instanceId = `inst-${Date.now()}`;
    const capabilitiesDigest = 'digest-test';

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timed out')), 10_000);

      this.socket.on('error', reject);
      this.socket.on('message', (raw: Buffer) => {
        const envelope = JSON.parse(raw.toString('utf8')) as {
          type: string;
          payload: Record<string, unknown>;
        };

        if (envelope.type === MESSAGE_TYPES.serverChallenge) {
          const payload = envelope.payload as {
            session_id: string;
            server_nonce: string;
            issued_at: number;
            expires_at: number;
            protocol_version: number;
          };
          // Signed over the same canonical transcript the server rebuilds, so a
          // divergence in either implementation fails here rather than silently
          // accepting a different message.
          const transcript = authTranscript({
            capabilitiesDigest,
            clientNonce: this.clientNonce,
            expiresAt: payload.expires_at,
            instanceId,
            issuedAt: payload.issued_at,
            nodeId: this.nodeId,
            protocolVersion: payload.protocol_version,
            serverNonce: payload.server_nonce,
            sessionId: payload.session_id,
          });
          this.send(MESSAGE_TYPES.clientAuthenticate, {
            session_id: payload.session_id,
            signature: keys.sign(transcript),
          });
          return;
        }

        if (envelope.type === MESSAGE_TYPES.serverReady) {
          clearTimeout(timer);
          resolve();
          return;
        }

        if (envelope.type === MESSAGE_TYPES.serverCommand) {
          this.receiveCommand(envelope.payload as unknown as ReceivedCommand);
          return;
        }

        if (envelope.type === MESSAGE_TYPES.error) {
          clearTimeout(timer);
          reject(new Error(`handshake refused: ${JSON.stringify(envelope.payload)}`));
        }
      });

      this.socket.on('open', () => {
        this.send(MESSAGE_TYPES.clientHello, {
          supported_versions: [1],
          node_id: this.nodeId,
          instance_id: instanceId,
          public_key_fingerprint: keys.fingerprint,
          client_nonce: this.clientNonce,
          capabilities_digest: capabilitiesDigest,
          software_version: 'test',
        });
      });
    });
  }

  private readonly clientNonce = newNonce();

  private receiveCommand(command: ReceivedCommand): void {
    this.commands.push(command);
    // The capability set arrives the way it does in production: requested right
    // after authentication and answered by the Node, so the stored snapshot is
    // one this Node actually claimed.
    if (command.command === 'capabilities.get') {
      this.completeCommand(command.command_id, { capabilities: this.capabilities });
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(command);
  }

  /** Answer one command as a Node would. */
  completeCommand(commandId: string, result: unknown): void {
    this.send(MESSAGE_TYPES.clientCommandResult, {
      command_id: commandId,
      state: 'completed',
      result,
    });
  }

  /** Answer one command with a refusal. */
  failCommand(commandId: string, errorCode: string, result?: unknown): void {
    this.send(MESSAGE_TYPES.clientCommandResult, {
      command_id: commandId,
      state: 'failed',
      error_code: errorCode,
      ...(result === undefined ? {} : { result }),
    });
  }

  /** Wait until a command of this type arrives, or give up. */
  async waitForCommand(type: string, timeoutMs = 5_000): Promise<ReceivedCommand> {
    const existing = this.commands.find((command) => command.command === type);
    if (existing) return existing;
    return new Promise<ReceivedCommand>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${type} command within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const check = (command: ReceivedCommand) => {
        if (command.command === type) {
          clearTimeout(timer);
          resolve(command);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  async close(): Promise<void> {
    this.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
