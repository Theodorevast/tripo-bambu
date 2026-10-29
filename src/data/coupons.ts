// 翠宝吐出来的 Tripo 优惠券：先用一组假的（待接真实后端）。
// 接后端时换掉 drawCoupons：由服务端发券（面额、券名、兑换码、有效期），这里的种类表只留给离线演示用。
// COUPONS_LIVE = false：卡片上的兑换码下面有一行小字说明这是示例码（接上真实后端后改成 true，那行字就不显示了）

export const COUPONS_LIVE = false;

export interface CouponKind {
  id: string;
  title: string; // 券名（卡片标题、券面上的小字）
  value: string; // 面额的大字：「-20%」「+100」
  unit: string; // 面额后面的小字：「off」「credits」
  blurb: string; // 卡片上的一句说明
  paper: 'yellow' | 'cream'; // 券面主色：翠宝黄或奶油白（另一种做票根）
}

export const COUPON_KINDS: readonly CouponKind[] = [
  { id: 'pro-20', title: 'Pro Plan', value: '-20%', unit: 'off', blurb: '20% off your first month of Tripo Pro.', paper: 'yellow' },
  { id: 'credits-100', title: 'Credit Shower', value: '+100', unit: 'credits', blurb: '100 bonus credits for your next generations.', paper: 'cream' },
  { id: 'annual-30', title: 'Annual Plan', value: '-30%', unit: 'off', blurb: '30% off a full year of Tripo Pro.', paper: 'yellow' },
  { id: 'credits-300', title: 'Big Bag of Credits', value: '+300', unit: 'credits', blurb: '300 bonus credits, no strings attached.', paper: 'cream' },
  { id: 'texture-50', title: 'Texture Treat', value: '+50', unit: 'credits', blurb: '50 credits for texturing and retopology.', paper: 'yellow' },
];

export interface CouponTicket {
  kind: number; // COUPON_KINDS 的下标（也是贴图图集里的行号）
  code: string; // 假的兑换码
}

// 兑换码不用容易看错的字符（0/O、1/I/L）
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function couponCode(rand: () => number): string {
  const block = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length) % CODE_CHARS.length]).join('');
  return `TRIBOO-${block()}-${block()}`;
}

// 一次吐 count 张：种类不重复（种类不够时才重复），每张一个兑换码
export function drawCoupons(rand: () => number, count: number): CouponTicket[] {
  const order = COUPON_KINDS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1)) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({ kind: order[i % order.length], code: couponCode(rand) }));
}
