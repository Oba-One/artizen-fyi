import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('deploy matching catalog', () => {
  it('writes version-matched core, project-list, and single-project assets', () => {
    const temp = mkdtempSync(join(tmpdir(), 'artizen-match-catalog-test-'));
    try {
      const index = JSON.parse(readFileSync('test/fixtures/match-index.json', 'utf8'));
      index.source.kind = 'artizen-api';
      const input = join(temp, 'index.json');
      const output = join(temp, 'match');
      writeFileSync(input, JSON.stringify(index));

      const run = spawnSync(process.execPath, ['scripts/build-match-catalog.mjs', input, output], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);

      const core = JSON.parse(readFileSync(join(output, 'core.json'), 'utf8'));
      const projects = JSON.parse(readFileSync(join(output, 'projects.json'), 'utf8'));
      expect(core.indexVersion).toBe(index.indexVersion);
      expect(core.projects).toEqual([]);
      expect(projects.indexVersion).toBe(index.indexVersion);
      expect(projects.projects).toHaveLength(index.projects.length);

      const first = index.projects[0];
      const key = createHash('sha256').update(first.id).digest('hex');
      const one = JSON.parse(readFileSync(join(output, 'project', `${key}.json`), 'utf8'));
      expect(one).toEqual({ indexVersion: index.indexVersion, projects: [first] });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
