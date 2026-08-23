import { describe, expect, it } from 'vitest';
import type { ProjectProfile } from '../src/artizen/types';
import { findExactProject, matchInputForProject, searchProjects } from '../src/matching/project-search';

const projects: ProjectProfile[] = [
  {
    id: 'green-goods',
    slug: 'green-goods',
    name: 'Green Goods',
    description: 'Regenerative public goods infrastructure',
    tags: ['Climate', 'Technology'],
  },
  {
    id: 'climate-frames',
    slug: 'climate-frames',
    name: 'Climate Frames',
    description: 'Documentary storytelling',
    tags: ['Climate', 'Film'],
  },
];

describe('project search', () => {
  it('finds a project from a plain, case-insensitive name', () => {
    expect(findExactProject(projects, 'green goods')?.id).toBe('green-goods');
  });

  it('searches names, tags, descriptions, and multiple terms', () => {
    expect(searchProjects(projects, 'green').map((project) => project.id)).toEqual(['green-goods']);
    expect(searchProjects(projects, 'climate film').map((project) => project.id)).toEqual(['climate-frames']);
    expect(searchProjects(projects, 'regenerative infrastructure').map((project) => project.id)).toEqual(['green-goods']);
  });

  it('returns a stable alphabetical browse list for an empty query', () => {
    expect(searchProjects(projects, '').map((project) => project.name)).toEqual(['Climate Frames', 'Green Goods']);
  });

  it('keeps all ten stored tags when selecting an existing project', () => {
    const tags = ['Agroforestry', 'Circular Economy', 'Climate Action', 'Community Building', 'Ecology', 'Education', 'Greenpill', 'Regenerative Economics', 'Solar', 'Waste Management'];
    const input = matchInputForProject({ ...projects[0], tags });
    expect(input.tags).toEqual(tags);
    expect(input.tags).toHaveLength(10);
  });
});
