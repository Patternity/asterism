import { describe, expect, it } from 'vitest';

import { bootstrapCommand } from '../src/node-install';

const ORIGIN = 'https://onsetexpo.textura.agency';

describe('the command a person copies out of Add Node', () => {
  /**
   * Asserted whole rather than in pieces. This string is pasted into a root
   * shell on somebody's server; the thing worth testing is exactly what it
   * says, not that it contains some of the right words.
   */
  it('is exactly this, with the release pinned into it', () => {
    expect(bootstrapCommand(ORIGIN, 'v0.1.0-alpha.19')).toBe(
      'curl -fsSL https://raw.githubusercontent.com/Patternity/asterism/master/scripts/bootstrap.sh | ' +
        `sudo ASTERISM_CONTROL_PLANE=${ORIGIN} ASTERISM_VERSION=v0.1.0-alpha.19 sh`,
    );
  });

  /**
   * The version is visible in the command, not hidden in the environment of the
   * shell that runs it. Somebody about to run this on a server can see which
   * release they are about to install before they run it.
   */
  it('names the release where the operator can read it', () => {
    const command = bootstrapCommand(ORIGIN, 'v0.1.0-alpha.19') ?? '';
    expect(command).toContain('ASTERISM_VERSION=v0.1.0-alpha.19');
    expect(command).not.toContain('v0.1.0-alpha.1 ');
  });

  it('pins whichever release it is given', () => {
    expect(bootstrapCommand(ORIGIN, 'v0.2.0-alpha.3')).toContain('ASTERISM_VERSION=v0.2.0-alpha.3');
  });

  /**
   * No command rather than one that cannot work. Without a release there is
   * nothing to pin, and the installer would refuse anyway — showing a command
   * that is going to fail wastes a trip to a server.
   */
  it('offers nothing when there is no release to pin', () => {
    expect(bootstrapCommand(ORIGIN, null)).toBeNull();
    expect(bootstrapCommand(ORIGIN, undefined)).toBeNull();
    expect(bootstrapCommand(ORIGIN, '')).toBeNull();
  });

  it('honours a different repository without losing the pin', () => {
    const command = bootstrapCommand(ORIGIN, 'v0.1.0-alpha.19', 'someone/fork') ?? '';
    expect(command).toContain('someone/fork/master/scripts/bootstrap.sh');
    expect(command).toContain('ASTERISM_VERSION=v0.1.0-alpha.19');
  });
});
