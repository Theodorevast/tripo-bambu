// 首页星球的小动作（H2）：悬停时轻轻放大、慢慢转；按下去压扁一点、松开时回弹（欠阻尼的弹簧，冲过头再回来）；
// 不悬停了转速慢慢停下（停在哪就是哪，不倒着转回去）。要进这颗星球时（settle）很快转回原来的朝向：
// 星球视图、草、作品都按「星球只平移、缩放，不旋转」算，云层全遮住那一刻 World 再把角度归零。
// 纯数学，不碰 three（单元测试直接测）

export const HOME_MOTION = {
  hoverScale: 0.08, // 悬停时放大多少
  hoverRate: 9, // 放大、缩回的快慢（每秒逼近的速率）
  spin: 0.42, // 悬停时转多快（弧度 / 秒，约 24°/s）
  spinRate: 2.2, // 转速加上来、停下来的速率
  settle: 14, // 要进这颗星球时转回原来朝向的弹簧（临界阻尼，约 0.4 秒）
  press: 0.075, // 按下去压扁多少（缩放少多少）
  pressK: 520, // 回弹的弹簧刚度
  pressC: 13, // 阻尼：越小弹得越多（520 / 13 时冲过头约 30%）
  delay: 0.12, // 松开以后等多久才开始转场（秒）：先看到回弹，再穿云
};

const TAU = Math.PI * 2;
const SUBSTEP = 1 / 120;

// 角度收到 (-π, π]
export function wrapAngle(a: number): number {
  const w = a - TAU * Math.floor((a + Math.PI) / TAU);
  return w === -Math.PI ? Math.PI : w;
}

export class PlanetMotion {
  hover = 0; // 0..1（平滑过的）
  press = 0; // 缩放的偏移（压扁时是负的，回弹时冲过 0）
  pressV = 0;
  spin = 0; // 绕竖轴转过的角度（-π..π）
  spinV = 0; // 弧度 / 秒
  pressed = false;

  // hovered：指针在这颗星球（或它的名牌）上；settle：要进这颗星球了（或在星球视图里），转回原来的朝向
  step(dt: number, hovered: boolean, settle: boolean): void {
    if (!(dt > 0)) return;
    const p = HOME_MOTION;
    this.hover += ((hovered && !settle ? 1 : 0) - this.hover) * (1 - Math.exp(-p.hoverRate * dt));
    // 回弹的弹簧按 1/120 秒细分着走：卡了一帧（dt 大）也不会炸开
    const target = this.pressed ? -p.press : 0;
    for (let left = Math.min(dt, 0.1); left > 1e-6; left -= SUBSTEP) {
      const h = Math.min(SUBSTEP, left);
      const a = -p.pressK * (this.press - target) - p.pressC * this.pressV;
      this.pressV += a * h;
      this.press += this.pressV * h;
      if (settle) {
        // 临界阻尼的弹簧把角度拉回 0（走近的那一边，最多半圈）
        const k = p.settle;
        const acc = -k * k * this.spin - 2 * k * this.spinV;
        this.spinV += acc * h;
        this.spin += this.spinV * h;
      }
    }
    if (!settle) {
      this.spinV += ((hovered ? p.spin : 0) - this.spinV) * (1 - Math.exp(-p.spinRate * dt));
      this.spin = wrapAngle(this.spin + this.spinV * dt);
    }
  }

  // 静止下来了（没在弹、没在转、没放大）：World 就不用每帧重设这颗星球的缩放和角度
  get resting(): boolean {
    return !this.pressed && this.hover < 1e-3 && Math.abs(this.press) < 1e-4 && Math.abs(this.pressV) < 1e-3 && Math.abs(this.spinV) < 1e-4;
  }

  // 乘在星球缩放上的倍数
  get scale(): number {
    return (1 + HOME_MOTION.hoverScale * this.hover) * (1 + this.press);
  }

  // 立刻回到原样（云层全遮住时、换团队列表时）
  reset(): void {
    this.hover = 0;
    this.press = 0;
    this.pressV = 0;
    this.spin = 0;
    this.spinV = 0;
    this.pressed = false;
  }
}
