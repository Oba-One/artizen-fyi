import type { ProjectMatchInput, ProjectProfile } from '../artizen/types';

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function projectLabel(project: ProjectProfile): string {
  return `${project.name} — ${project.slug}`;
}

export function matchInputForProject(
  project: ProjectProfile,
  description = project.description,
  tags = project.tags,
): ProjectMatchInput {
  return {
    projectId: project.id,
    title: project.name,
    description,
    tags: [...tags],
  };
}

export function findExactProject(projects: ProjectProfile[], query: string): ProjectProfile | undefined {
  const needle = normalize(query);
  if (!needle) return undefined;
  return projects.find((project) =>
    [project.name, project.slug, projectLabel(project)].some((value) => normalize(value) === needle),
  );
}

export function searchProjects(projects: ProjectProfile[], query: string, limit = 8): ProjectProfile[] {
  const needle = normalize(query);
  const tokens = needle.split(' ').filter(Boolean);
  return projects
    .flatMap((project) => {
      const name = normalize(project.name);
      const slug = normalize(project.slug);
      const tags = normalize(project.tags.join(' '));
      const haystack = normalize(`${project.name} ${project.slug} ${project.tags.join(' ')} ${project.description}`);
      if (tokens.length && !tokens.every((token) => haystack.includes(token))) return [];
      const score =
        !needle
          ? 0
          : name === needle
            ? 100
            : slug === needle
              ? 90
              : name.startsWith(needle)
                ? 70
                : name.includes(needle)
                  ? 50
                  : tags.includes(needle)
                    ? 30
                    : 10;
      return [{ project, score }];
    })
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
    .slice(0, limit)
    .map(({ project }) => project);
}
