import { parseRoute, toHash, type Route } from '../router';

// 地址栏现在是不是还停在这条路由上：两边都先规范成 toHash 的写法再比，
// 所以 #/ 和空地址都算星系，结尾多个斜杠、转义写法不同也算同一条。
// 路由是排队执行的，轮到一条坏地址执行时用户可能已经去了别处（新地址的跳转已经排上）：
// 这时只提示，不再改地址栏，免得把那条新记录改掉
export function isCurrentRoute(route: Route, hash: string = location.hash): boolean {
  return toHash(parseRoute(hash)) === toHash(route);
}
