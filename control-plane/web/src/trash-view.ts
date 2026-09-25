/**
 * How Trash reads on a page.
 *
 * Kept apart from the components so the wording and the one real decision --
 * which restore may be offered where -- are stated once and tested without
 * rendering anything. Nothing here decides whether something *is* in Trash:
 * the Control Plane says so, from both tombstones, and this only words it.
 */

/** What the Control Plane says about one project's place in Trash. */
export interface ProjectTrash {
  /** Its own tombstone. */
  trashed: boolean;
  /** Its Node's tombstone, which puts it in Trash too. */
  inherited: boolean;
  effective: boolean;
  trashed_at: string | null;
  node_trashed_at?: string | null;
  worker: string | null;
  worker_failure?: string | null;
}

export interface NodeTrash {
  trashed: boolean;
  trashed_at: string | null;
}

export interface TrashTreeNode {
  node_id: string;
  display_name: string;
  connection_state?: string;
  /** `trashed` for a Node in Trash; `context` for an active Node holding trashed projects. */
  role: 'trashed' | 'context';
  trash: NodeTrash;
  projects: { project_id: string; display_name: string; trash: ProjectTrash }[];
}

/**
 * Said before anything is moved, the same way everywhere.
 *
 * The four facts a person needs and would otherwise have to guess: where it
 * goes, that nothing is lost, that it can come back, and that it does not free
 * any disk.
 */
export const TRASH_PROJECT_CONFIRMATION =
  'This project will disappear from Projects, Runs and every other active view, and its worker will be stopped. Its workspace, runs, chat history, credential and model are kept exactly as they are. You can restore it from Trash at any time. Nothing is deleted from the Node, so no disk space is freed.';

export const TRASH_NODE_CONFIRMATION =
  'This Node and every project on it will disappear from active views, and its project workers will be stopped. The Node stays enrolled, and all of its projects, credentials, runs and history are kept. You can restore it from Trash at any time; projects that were already in Trash on their own stay there. Nothing is uninstalled or deleted, so no disk space is freed.';

/** What Trash last did to a project's worker, in words. Empty when it did nothing. */
export function workerLabel(worker: string | null | undefined): string {
  switch (worker) {
    case 'stopping':
      return 'Stopping its worker — waiting for the Node';
    case 'stopped':
      return 'Worker stopped';
    case 'stop_failed':
      return 'Its worker could not be stopped';
    case 'starting':
      return 'Starting its worker — waiting for the Node';
    case 'running':
      return 'Worker running';
    case 'start_failed':
      return 'Its worker did not come back';
    case 'not_managed':
      // Honest about who runs it: nothing here was stopped or started.
      return 'Its runtime is not run by this Node, so nothing on the host was changed';
    case 'unsupported':
      return "This Node's build cannot stop workers, so nothing on the host was changed";
    default:
      return '';
  }
}

export function workerTone(worker: string | null | undefined): 'ok' | 'warn' | 'fail' {
  if (worker === 'stop_failed' || worker === 'start_failed') return 'fail';
  if (worker === 'stopping' || worker === 'starting') return 'warn';
  return 'ok';
}

/** Why a project is in Trash, as the row under its Node says it. */
export function projectTrashReason(trash: ProjectTrash): string {
  if (trash.trashed && trash.inherited) {
    return 'In Trash on its own and with its Node. It stays in Trash when the Node is restored.';
  }
  if (trash.trashed) return 'In Trash on its own.';
  if (trash.inherited) return 'In Trash with its Node.';
  return '';
}

/**
 * Whether this project may be restored from its own row.
 *
 * Only a project in Trash on its own, under a Node that is not. Under a Node in
 * Trash the Node is what is restored, and a project-level restore there is
 * refused by the Control Plane -- so it is not offered, and the row says why.
 */
export function projectRestore(
  trash: ProjectTrash,
): { offered: true } | { offered: false; reason: string } {
  if (trash.inherited) return { offered: false, reason: 'Restore its Node first.' };
  if (!trash.trashed) return { offered: false, reason: '' };
  return { offered: true };
}
