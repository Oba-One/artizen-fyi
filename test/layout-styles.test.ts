import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitPageStyles } from '../src/html/layout';

describe('page CSS delivery', () => {
  it('keeps matching CSS off unrelated pages', () => {
    const source = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const styles = splitPageStyles(source);

    expect(styles.base).not.toContain('.artizen-match-card');
    expect(styles.matching).toContain('.artizen-match-card');
    expect(source).toContain('--warn: #D6C52D');
    expect(styles.matching).toContain('.artizen-fit-fill-warning { background: var(--warn); }');
  });
});
