// hash 路由：#/、#/t/<teamId>、#/t/<teamId>/members、#/t/<teamId>/museum[/<workId>]
export type Route =
  | { view: 'galaxy' }
  | { view: 'planet'; teamId: string }
  | { view: 'members'; teamId: string }
  | { view: 'museum'; teamId: string; workId?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 't' || !parts[1]) return { view: 'galaxy' };
  const teamId = parts[1];
  if (parts.length === 2) return { view: 'planet', teamId };
  if (parts[2] === 'members' && parts.length === 3) return { view: 'members', teamId };
  if (parts[2] === 'museum' && parts.length === 3) return { view: 'museum', teamId };
  if (parts[2] === 'museum' && parts.length === 4) return { view: 'museum', teamId, workId: parts[3] };
  return { view: 'galaxy' };
}

export function toHash(route: Route): string {
  const team = (id: string) => `#/t/${encodeURIComponent(id)}`;
  switch (route.view) {
    case 'galaxy':
      return '#/';
    case 'planet':
      return team(route.teamId);
    case 'members':
      return `${team(route.teamId)}/members`;
    case 'museum':
      return `${team(route.teamId)}/museum${route.workId ? `/${encodeURIComponent(route.workId)}` : ''}`;
  }
}
