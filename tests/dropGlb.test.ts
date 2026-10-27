import { describe, expect, it } from 'vitest';
import { checkDrop, MAX_DROP_BYTES } from '../src/editor/dropGlb';

describe('checkDrop', () => {
  it('接受 100 MB 以内的 .glb（扩展名不分大小写）', () => {
    expect(checkDrop({ name: 'robot.GLB', size: 5_000_000 })).toEqual({ ok: true });
    expect(checkDrop({ name: 'a.glb', size: MAX_DROP_BYTES })).toEqual({ ok: true });
  });
  it('拒绝其他格式', () => {
    expect(checkDrop({ name: 'scene.gltf', size: 10 })).toEqual({ ok: false, reason: 'Only .glb files can be dropped here' });
  });
  it('拒绝超过 100 MB 的文件', () => {
    expect(checkDrop({ name: 'huge.glb', size: MAX_DROP_BYTES + 1 })).toEqual({ ok: false, reason: 'That file is over 100 MB' });
  });
});
