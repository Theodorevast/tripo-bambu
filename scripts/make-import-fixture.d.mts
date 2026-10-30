// make-import-fixture.mjs 的类型（tests/importModel.test.ts 借它在测试里造模型）
import type { Document } from '@gltf-transform/core';

export function sphere(segments?: number, rings?: number): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint16Array | Uint32Array };
export function makeSphereDocument(options?: { textureSize?: number; segments?: number; rings?: number }): Promise<Document>;
