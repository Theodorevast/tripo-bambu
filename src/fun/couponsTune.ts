import { COUPONS } from './couponsMath';

// ?tune 的「Coupons」组：翠宝吐券每一步的时长和幅度、券的飞行和寿命、捡券、音量；两个按钮（吐一次、收掉地上的券）。
// 改了下一次就用新值。tune.ts 只调 addCouponsTune、把 COUPONS 放进「Copy parameters」的 JSON

// 用到的那部分 Tweakpane 接口（和 tune.ts 里的一样，自己写，类型检查不依赖 @tweakpane/core）
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
  addButton(params: { title: string }): Events;
}

type Key = keyof typeof COUPONS & string;
type Slider = [Key, number, number, number, string];

function sliders(folder: Folder, list: Slider[]): void {
  for (const [key, min, max, step, label] of list) folder.addBinding(COUPONS, key, { min, max, step, label });
}

export function addCouponsTune(pane: Folder): void {
  const f = pane.addFolder({ title: 'Coupons', expanded: false });
  const triboo = f.addFolder({ title: 'Triboo · timing', expanded: true });
  sliders(triboo, [
    ['turn', 0, 0.6, 0.01, 'turn to camera s'],
    ['charge', 0.05, 1, 0.01, 'charge s'],
    ['spring', 0.05, 0.6, 0.01, 'spring up s'],
    ['launchAt', 0, 1, 0.01, 'spit at (of spring)'],
    ['recover', 0.1, 1.5, 0.01, 'recover s'],
    ['wiggle', 0.1, 1.5, 0.01, 'happy wiggle s'],
    ['shakeSeconds', 0.2, 1.5, 0.01, 'head shake s'],
    ['cooldown', 0, 10, 0.1, 'cooldown s'],
  ]);
  const feel = f.addFolder({ title: 'Triboo · feel', expanded: false });
  sliders(feel, [
    ['squash', 0, 0.5, 0.01, 'squash'],
    ['tremble', 0, 0.06, 0.001, 'tremble'],
    ['stretch', 0, 0.5, 0.01, 'stretch'],
    ['hop', 0, 0.5, 0.01, 'hop (× height)'],
    ['wiggleAngle', 0, 30, 0.5, 'wiggle°'],
    ['shakeAngle', 0, 45, 0.5, 'head shake°'],
    ['hoverSquash', 0, 0.2, 0.005, 'hover squash'],
    ['glow', 0, 5, 0.05, 'logo glow'],
  ]);
  const flight = f.addFolder({ title: 'Flight', expanded: false });
  sliders(flight, [
    ['countMin', 1, 5, 1, 'count min'],
    ['countMax', 1, 5, 1, 'count max'],
    ['stagger', 0, 0.3, 0.005, 'stagger s'],
    ['flight', 0.3, 2.5, 0.01, 'flight s'],
    ['arc', 0, 2.5, 0.01, 'arc height (m)'],
    ['spread', 0.4, 3, 0.01, 'spread (m)'],
    ['fan', 30, 300, 1, 'fan°'],
    ['flips', 0, 5, 1, 'flips'],
    ['flutter', 0, 0.5, 0.005, 'flutter (m)'],
    ['confetti', 0, 60, 1, 'confetti'],
  ]);
  const ground = f.addFolder({ title: 'On the grass', expanded: false });
  sliders(ground, [
    ['hover', 0.1, 1, 0.01, 'hover (m)'],
    ['bob', 0, 0.15, 0.005, 'bob (m)'],
    ['spin', 0, 3, 0.05, 'spin rad/s'],
    ['size', 0.2, 1.2, 0.01, 'size (m)'],
    ['life', 1, 30, 0.5, 'life s'],
    ['fade', 0.1, 3, 0.05, 'fade s'],
    ['boost', 0, 3, 0.05, 'planet view boost'],
    ['minScreen', 0, 0.15, 0.005, 'min size on screen (× view height)'],
  ]);
  const pick = f.addFolder({ title: 'Pick up', expanded: false });
  sliders(pick, [
    ['pickup', 0.15, 1.5, 0.01, 'fly to camera s'],
    ['volume', 0, 1, 0.01, 'volume'],
  ]);
  f.addButton({ title: 'Spit coupons now' }).on('click', () => { window.__coupons?.poke(); });
  f.addButton({ title: 'Clear coupons' }).on('click', () => { window.__coupons?.clear(); });
}
