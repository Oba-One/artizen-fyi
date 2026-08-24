import { describe, expect, it } from 'vitest';
import type { ProjectProfile } from '../src/artizen/types';
import { moveActive, pickerState } from '../src/matching/project-picker';

// Mirrors the shape of the live catalog, which really does contain projects whose whole name or
// slug is a single character. Typing "w" used to select "Dance to Water Ecosystems".
const projects: ProjectProfile[] = [
  { id: 'water', slug: 'w', name: 'Dance to Water Ecosystems', description: 'Movement and rivers', tags: ['Water'] },
  { id: 'a', slug: 'a-2', name: 'a', description: 'A single letter project', tags: [] },
  { id: 'green-goods', slug: 'green-goods', name: 'Green Goods', description: 'Regenerative public goods', tags: ['Climate'] },
  { id: 'wildlands', slug: 'wildlands', name: 'Wildlands', description: 'Rewilding stories', tags: ['Ecology'] },
];

describe('project picker', () => {
  it('never selects a project while the user is still typing', () => {
    for (const query of ['w', 'a', 'wi', 'green goods']) {
      expect(pickerState(projects, query, 'typing').committed).toBeUndefined();
    }
  });

  it('still offers a full option list for a single-character query', () => {
    const state = pickerState(projects, 'w', 'typing');
    expect(state.options.length).toBeGreaterThan(1);
    expect(state.options.map((project) => project.id)).toContain('wildlands');
  });

  it('highlights the first option so Enter has something to commit', () => {
    expect(pickerState(projects, 'green', 'typing').activeIndex).toBe(0);
    expect(pickerState(projects, 'no such project anywhere', 'typing').activeIndex).toBe(-1);
  });

  it('commits an exact name or slug only once typing has finished', () => {
    expect(pickerState(projects, 'w', 'commit').committed?.id).toBe('water');
    expect(pickerState(projects, 'Green Goods', 'commit').committed?.id).toBe('green-goods');
    expect(pickerState(projects, '', 'commit').committed).toBeUndefined();
    expect(pickerState(projects, 'wil', 'commit').committed).toBeUndefined();
  });

  it('wraps arrow-key movement around the option list', () => {
    expect(moveActive(-1, 4, 1)).toBe(0);
    expect(moveActive(-1, 4, -1)).toBe(3);
    expect(moveActive(3, 4, 1)).toBe(0);
    expect(moveActive(0, 4, -1)).toBe(3);
    expect(moveActive(0, 0, 1)).toBe(-1);
  });
});
