// hash 路由：#/、#/t/<teamId>、#/t/<teamId>/members、#/t/<teamId>/museum[/<workId>]、#/create（建一颗星球，P3）
export type Route =
  | { view: 'galaxy' }
  | { view: 'create' }
  | { view: 'planet'; teamId: string }
  | { view: 'members'; teamId: string }
  | { view: 'museum'; teamId: string; workId?: string };

// 按段解码：某段的 % 转义是坏的（如手打的 #/t/100%）就保留原样。这样它只是一个找不到的团队或作品，
// 由 App 提示后回星系、由 Museum 提示后留在网格（spec 第 9 节）；段数不对、视图词不认识的地址才直接回星系
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeSegment);
  if (parts[0] === 'create' && parts.length === 1) return { view: 'create' };
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
    case 'create':
      return '#/create';
    case 'planet':
      return team(route.teamId);
    case 'members':
      return `${team(route.teamId)}/members`;
    case 'museum':
      return `${team(route.teamId)}/museum${route.workId ? `/${encodeURIComponent(route.workId)}` : ''}`;
  }
}
