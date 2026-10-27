import { describe, expect, it } from 'vitest';
import { formatTris, initials } from '../src/ui/dom';

describe('initials', () => {
  it('取前两个词的首字母', () => {
    expect(initials('Ollie Park')).toBe('OP');
    expect(initials('mia_makes')).toBe('MM');
    expect(initials('Brass Lantern of Doom')).toBe('BL');
    expect(initials('')).toBe('?');
  });
});

describe('formatTris', () => {
  it('千分位；0 显示为破折号', () => {
    expect(formatTris(128402)).toBe('128,402 tris');
    expect(formatTris(0)).toBe('— tris');
  });
});
