export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdById: string;
  createdAt: Date;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
