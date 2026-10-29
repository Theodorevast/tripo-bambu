import { CLOUD_TRIBOO, cloudTriboo } from './homeCloudTriboo';
import { STARDUST_TRIBOO } from './homeGalaxy';
import { addHomeTuneExtra } from './homeTune';
import type { World } from './world';

// ?tune → Home 里的两组（首页的翠宝元素）：「Cloud Triboo」（云朵翠宝）、「Stardust Triboo」（开场星尘拼出标志）。
// 用 homeTune.ts 的 addHomeTuneExtra 加进去（面板打开时才建）；main.ts 装一次
export function installHomeTribooTune(world: World): void {
  addHomeTuneExtra((home) => {
    // 第二版：云朵翠宝换成了星座翠宝（homeCloudTriboo.ts），参数表还叫 CLOUD_TRIBOO
    const cloud = home.addFolder({ title: 'Constellation Triboo', expanded: false });
    cloud.addBinding(CLOUD_TRIBOO, 'on', { label: 'show', min: 0, max: 1, step: 1 });
    cloud.addBinding(CLOUD_TRIBOO, 'size', { label: 'size ×', min: 0.4, max: 2.5, step: 0.05 });
    cloud.addBinding(CLOUD_TRIBOO, 'cycle', { label: 'reappear every (s)', min: 10, max: 120, step: 1 });
    cloud.addBinding(CLOUD_TRIBOO, 'gather', { label: 'light up (s)', min: 0.5, max: 8, step: 0.1 });
    cloud.addBinding(CLOUD_TRIBOO, 'scatter', { label: 'fade out (s)', min: 0.5, max: 8, step: 0.1 });
    cloud.addBinding(CLOUD_TRIBOO, 'drift', { label: 'drift ×body', min: 0, max: 2, step: 0.05 });
    cloud.addBinding(CLOUD_TRIBOO, 'opacity', { min: 0.2, max: 1, step: 0.01 });
    cloud.addBinding(CLOUD_TRIBOO, 'gold', { label: 'chest V glow', min: 0, max: 2, step: 0.01 });
    cloud.addBinding(CLOUD_TRIBOO, 'afterIntro', { label: 'wait after stardust (s)', min: 0, max: 8, step: 0.1 });
    cloud.addButton({ title: 'Replay (fade & reappear)' }).on('click', () => cloudTriboo()?.replay());
    const dust = home.addFolder({ title: 'Stardust Triboo', expanded: false });
    dust.addBinding(STARDUST_TRIBOO, 'on', { label: 'play at opening', min: 0, max: 1, step: 1 });
    dust.addBinding(STARDUST_TRIBOO, 'at', { label: 'start at flight', min: 0, max: 1, step: 0.01 });
    dust.addBinding(STARDUST_TRIBOO, 'gather', { label: 'gather (s)', min: 0.3, max: 4, step: 0.05 });
    dust.addBinding(STARDUST_TRIBOO, 'hold', { label: 'hold (s)', min: 0, max: 4, step: 0.05 });
    dust.addBinding(STARDUST_TRIBOO, 'back', { label: 'flow back (s)', min: 0.3, max: 4, step: 0.05 });
    dust.addBinding(STARDUST_TRIBOO, 'size', { label: 'size ×screen', min: 0.1, max: 0.8, step: 0.01 });
    dust.addBinding(STARDUST_TRIBOO, 'twist', { label: 'swirl (rad)', min: 0, max: 4, step: 0.05 });
    dust.addBinding(STARDUST_TRIBOO, 'lift', { label: 'arc lift ×R', min: 0, max: 3, step: 0.05 });
    dust.addButton({ title: 'Replay' }).on('click', () => {
      if (world.focused || world.director.busy) return;
      const cam = world.rig.camera;
      void world.galaxy.playShape({ position: cam.position.clone(), target: world.rig.controls.target.clone(), fov: cam.fov }, 0);
    });
  });
}
