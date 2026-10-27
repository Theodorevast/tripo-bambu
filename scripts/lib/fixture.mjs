// 生成一个带贴图的竖直方片 GLB，给拖入检查和模型处理脚本当测试数据
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

export async function makeBoxGlb({ textureSize = 64 } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const png = await sharp({ create: { width: textureSize, height: textureSize, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const texture = doc.createTexture('base').setImage(new Uint8Array(png)).setMimeType('image/png');
  const material = doc.createMaterial('mat').setBaseColorTexture(texture).setDoubleSided(true);
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0])))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])))
    .setIndices(accessor('SCALAR', new Uint16Array([0, 1, 2, 0, 2, 3])))
    .setMaterial(material);
  const node = doc.createNode('quad').setMesh(doc.createMesh('quad').addPrimitive(prim));
  doc.createScene('scene').addChild(node);
  return new NodeIO().writeBinary(doc);
}
