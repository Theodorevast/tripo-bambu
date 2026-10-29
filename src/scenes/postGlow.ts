import * as THREE from 'three/webgpu';
import { float, floor, fract, Fn, interleavedGradientNoise, max, min, smoothstep, texture, time, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { NIGHT_SKY } from '../nature/nightSky';
import { valueNoise } from '../style/grade';

// 第二版后期的两样（v2-sky，接进 scenes/post.ts 的 MainPost）：
// 1. 泛光（GlowPass）：星星、月亮、灯、星尘、萤火虫这些真正亮的地方带一点光晕（阈值按乘了曝光以后的亮度比，云、地面、作品的受光面都在阈值以下，画面不发雾）。便宜的做法：
//    四分之一分辨率取亮部（每个小像素覆盖 4×4 个原像素：场景缓冲是最近邻取样，16 个点都取到，细小的星点不会漏掉、镜头转动时不闪），
//    软阈值（knee），再横竖各一遍 13 点的高斯（7 次双线性取样）；最后一步在调色之前（线性 HDR）加回去，一起过 AgX。
//    2880×1800 时三遍都在 720×450 上：每遍不到 33 万像素，合计约 0.1 ms（见报告）。不缩小、不模糊原画面，只是叠一层光晕
// 2. 胶片颗粒（filmGrain）：显示空间、调色之后、不调色的那一层（券）之前。单色、零均值（不改整体明暗，不闪），
//    中间调最明显、暗部和高光少（不脏）；每秒换 grainFps 次（像胶片一格一格，不是每帧都换）
// 参数在 nature/nightSky.ts 的 NIGHT_SKY 表里（bloom*、grain*；?tune → Night sky）

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// 13 点高斯的双线性取样（偏移按小像素，权重和为 1）
const TAPS: Array<[number, number]> = [
  [0, 0.1964825501511404],
  [1.411764705882353, 0.2969069646728344],
  [3.2941176470588234, 0.09447039785044732],
  [5.176470588235294, 0.010381362401148057],
];

const U = {
  grain: uniform(0),
  grainSize: uniform(1.25),
  grainFps: uniform(24),
};

export class GlowPass {
  private readonly down: THREE.RenderTarget;
  private readonly blurH: THREE.RenderTarget;
  private readonly blurV: THREE.RenderTarget;
  private readonly downQuad: THREE.QuadMesh;
  private readonly hQuad: THREE.QuadMesh;
  private readonly vQuad: THREE.QuadMesh;
  private readonly fullInv = uniform(new THREE.Vector2(1, 1)); // 原分辨率一个像素（uv）
  private readonly smallInv = uniform(new THREE.Vector2(1, 1)); // 四分之一分辨率一个像素
  private readonly threshold = uniform(NIGHT_SKY.bloomThreshold);
  private readonly exposure = uniform(1); // 渲染器现在的曝光：阈值按「乘了曝光以后」比（星球页曝光高一些，亮面也不会一起泛光）
  private readonly knee = uniform(NIGHT_SKY.bloomKnee);
  private readonly radius = uniform(NIGHT_SKY.bloomRadius);
  readonly strength = uniform(0); // 最后一步按它叠回去（0 时最后一步也不取样）

  constructor(sceneColor: THREE.Texture) {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.down = new THREE.RenderTarget(1, 1, opts);
    this.blurH = new THREE.RenderTarget(1, 1, opts);
    this.blurV = new THREE.RenderTarget(1, 1, opts);
    this.down.texture.name = 'glow-down';
    this.blurH.texture.name = 'glow-h';
    this.blurV.texture.name = 'glow-v';
    this.downQuad = new THREE.QuadMesh(this.buildDown(sceneColor));
    this.hQuad = new THREE.QuadMesh(this.buildBlur(this.down.texture, new THREE.Vector2(1, 0)));
    this.vQuad = new THREE.QuadMesh(this.buildBlur(this.blurH.texture, new THREE.Vector2(0, 1)));
  }

  // 泛光的结果（最后一步取样用）
  get texture(): THREE.Texture {
    return this.blurV.texture;
  }

  get on(): boolean {
    return this.strength.value > 0.001;
  }

  // 表 → uniform（每帧调，便宜）。exposure：渲染器的曝光（atmosphere 每帧设）
  apply(exposure = 1): void {
    this.exposure.value = Math.max(1e-3, exposure);
    this.strength.value = Math.max(0, NIGHT_SKY.bloom);
    this.threshold.value = Math.max(0, NIGHT_SKY.bloomThreshold);
    this.knee.value = Math.max(1e-3, NIGHT_SKY.bloomKnee);
    // 最多 1：13 点高斯的双线性取样是按「一个小像素」排的偏移，拉开了取样点之间有空当，一个亮点会散成一格一格的格子（漫游时水面上实测）
    this.radius.value = Math.min(1, Math.max(0.25, NIGHT_SKY.bloomRadius));
    U.grain.value = Math.max(0, NIGHT_SKY.grain);
    U.grainSize.value = Math.max(0.5, NIGHT_SKY.grainSize);
    U.grainFps.value = Math.max(1, NIGHT_SKY.grainFps);
  }

  resize(w: number, h: number): void {
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    if (this.down.width !== qw || this.down.height !== qh) {
      this.down.setSize(qw, qh);
      this.blurH.setSize(qw, qh);
      this.blurV.setSize(qw, qh);
    }
    this.fullInv.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    this.smallInv.value.set(1 / qw, 1 / qh);
  }

  // 三遍：取亮部 → 横 → 竖。渲染目标留在最后一张上（MainPost 接着画最后一步时自己换）
  render(r: THREE.WebGPURenderer): void {
    if (!this.on) return;
    r.setRenderTarget(this.down);
    this.downQuad.render(r);
    r.setRenderTarget(this.blurH);
    this.hQuad.render(r);
    r.setRenderTarget(this.blurV);
    this.vQuad.render(r);
  }

  // 开场预编译（MainPost.compile 里调，和光束那两步同样的做法：只在调 compileAsync 的那一下换渲染目标）
  async compile(r: THREE.WebGPURenderer, saved: THREE.RenderTarget | null): Promise<void> {
    for (const [quad, target] of [[this.downQuad, this.down], [this.hQuad, this.blurH], [this.vQuad, this.blurV]] as const) {
      r.setRenderTarget(target);
      const done = r.compileAsync(quad, quad.camera);
      r.setRenderTarget(saved);
      await done;
    }
  }

  dispose(): void {
    for (const t of [this.down, this.blurH, this.blurV]) t.dispose();
    for (const q of [this.downQuad, this.hQuad, this.vQuad]) (q.material as THREE.Material).dispose();
  }

  // 取亮部：4×4 个原像素（最近邻）各自过软阈值再平均
  private buildDown(sceneColor: THREE.Texture): THREE.NodeMaterial {
    const color = texture(sceneColor);
    const m = new THREE.NodeMaterial();
    m.name = 'MainPost glow down';
    m.fragmentNode = Fn(() => {
      const st = uv();
      const sum = vec3(0).toVar();
      for (const oy of [-1.5, -0.5, 0.5, 1.5]) {
        for (const ox of [-1.5, -0.5, 0.5, 1.5]) {
          const c = color.sample(st.add(this.fullInv.mul(vec2(ox, oy)))).rgb;
          const br = max(c.r, max(c.g, c.b)).mul(this.exposure);
          // 软阈值（knee）：阈值附近慢慢进来，不是一刀切
          const soft = min(max(br.sub(this.threshold).add(this.knee), 0), this.knee.mul(2));
          const w = max(soft.mul(soft).div(this.knee.mul(4)), br.sub(this.threshold)).div(max(br, 1e-4));
          sum.addAssign(min(c, vec3(64)).mul(w));
        }
      }
      return vec4(sum.div(16), 1);
    })();
    return m;
  }

  private buildBlur(src: THREE.Texture, axis: THREE.Vector2): THREE.NodeMaterial {
    const tex = texture(src);
    const m = new THREE.NodeMaterial();
    m.name = 'MainPost glow blur';
    m.fragmentNode = Fn(() => {
      const st = uv();
      const step = this.smallInv.mul(vec2(axis.x, axis.y)).mul(this.radius);
      const sum = tex.sample(st).rgb.mul(TAPS[0][1]).toVar();
      for (const [o, w] of TAPS.slice(1)) {
        sum.addAssign(tex.sample(st.add(step.mul(o))).rgb.mul(w));
        sum.addAssign(tex.sample(st.sub(step.mul(o))).rgb.mul(w));
      }
      return vec4(sum, 1);
    })();
    return m;
  }
}

// 胶片颗粒（显示空间 0..1 的颜色进、出）。pixel：像素坐标
export function filmGrain(rgb: V3, pixel: V2): V3 {
  const frame = floor(time.mul(U.grainFps));
  const seed = vec2(fract(frame.mul(0.1373)).mul(613.7), fract(frame.mul(0.2551)).mul(409.3));
  const p = pixel.div(U.grainSize);
  // 两种尺度：一层平滑的（颗粒的团），一层逐像素的（颗粒的边），都是零均值
  const n = valueNoise(p.add(seed)).sub(0.5).mul(0.75).add(interleavedGradientNoise(pixel.add(seed.mul(1.7))).sub(0.5).mul(0.5));
  const l = rgb.dot(vec3(0.2126, 0.7152, 0.0722));
  const weight = smoothstep(0.0, 0.25, l).mul(float(1).sub(smoothstep(0.6, 1.0, l)).mul(0.7).add(0.3));
  return rgb.add(n.mul(U.grain).mul(weight)).max(0);
}
