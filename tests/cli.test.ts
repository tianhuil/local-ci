import { describe, expect, test } from 'bun:test';

describe('local-ci CLI', () => {
  test('prints the documented version', async () => {
    const child = Bun.spawn(['node', 'bin/local-ci.js', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(child.stdout).text()).toBe('0.1.0\n');
    expect(await child.exited).toBe(0);
  });

  test('rejects unknown options with exit code 2', async () => {
    const child = Bun.spawn(['node', 'bin/local-ci.js', '--forse'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(child.stderr).text()).toBe('error: unknown option --forse; valid options: --force, --no-push, --jobs, --help, --version\n');
    expect(await child.exited).toBe(2);
  });
});
