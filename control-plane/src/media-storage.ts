/**
 * Where uploaded image bytes live.
 *
 * Local disk, deliberately: this alpha stores images on the Control Plane's own
 * volume rather than reaching for object storage nothing else in the deployment
 * uses. The interface is the point — a future S3-compatible backend replaces
 * this file and nothing in the chat path, the Node protocol, or the database
 * model changes, because everything above holds an opaque storage key.
 *
 * Storage keys are generated here and never derived from anything a user
 * supplies. A filename from a browser is a hostile string; it is kept as
 * metadata for display and never touches a path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredObject {
  storageKey: string;
  byteSize: number;
  sha256: string;
}

export interface MediaStorage {
  /** Write bytes and return their key. Partial writes never become visible. */
  put(bytes: Buffer, extension: string): Promise<StoredObject>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
  /** Whether the backend is usable right now, checked before accepting a file. */
  healthy(): Promise<boolean>;
}

/** A storage key is two hex segments and an extension. Nothing else parses. */
const STORAGE_KEY = /^[0-9a-f]{2}\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/;

export class LocalMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a key to a path, refusing anything that is not one we generated.
   *
   * The pattern check is the guard, not the containment check that follows it:
   * a key never comes from a request in the first place, and one that does not
   * look generated means a corrupted row rather than a path to be repaired.
   */
  private resolve(storageKey: string): string {
    if (!STORAGE_KEY.test(storageKey)) {
      throw new Error('malformed storage key');
    }
    const resolved = path.resolve(this.root, storageKey);
    if (resolved !== path.normalize(resolved) || !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error('storage key escapes the storage root');
    }
    return resolved;
  }

  async put(bytes: Buffer, extension: string): Promise<StoredObject> {
    const id = randomUUID().replace(/-/g, '');
    const storageKey = `${id.slice(0, 2)}/${id}.${extension}`;
    const target = this.resolve(storageKey);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

    // Write beside the target and rename: a reader never sees a half-written
    // image, and a crash leaves a temporary file rather than a corrupt one under
    // a key the database already points at.
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      storageKey,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async read(storageKey: string): Promise<Buffer> {
    const { readFile } = await import('node:fs/promises');
    return readFile(this.resolve(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.resolve(storageKey), { force: true });
  }

  async healthy(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await access(this.root, constants.W_OK | constants.R_OK);
      const info = await stat(this.root);
      return info.isDirectory();
    } catch {
      return false;
    }
  }
}

/** Null object for a deployment with uploads switched off. */
export class DisabledMediaStorage implements MediaStorage {
  private fail(): never {
    throw new Error('upload storage is not configured');
  }

  put(): Promise<StoredObject> {
    this.fail();
  }

  read(): Promise<Buffer> {
    this.fail();
  }

  async remove(): Promise<void> {
    // Removing from nothing is not an error: cleanup paths run unconditionally.
  }

  async healthy(): Promise<boolean> {
    return false;
  }
}

export function createMediaStorage(uploadDir: string): MediaStorage {
  return uploadDir ? new LocalMediaStorage(uploadDir) : new DisabledMediaStorage();
}
