import { describe, expect, it } from 'vitest';
import { friendlyLabel } from '../src/ui/tuneLabels';

describe('friendlyLabel：调参面板的参数名改成人话', () => {
  it('常量名：PLANET_RADIUS → Planet radius', () => {
    expect(friendlyLabel('PLANET_RADIUS')).toBe('Planet radius');
  });

  it('驼峰的参数名拆成词：seaHeight → Sea height、walkerHeight → Walker height', () => {
    expect(friendlyLabel('seaHeight')).toBe('Sea height');
    expect(friendlyLabel('walkerHeight')).toBe('Walker height');
  });

  it('本来就是一句话：只把首字母大写，单位、符号、括号不动', () => {
    expect(friendlyLabel('rocks at rim ×')).toBe('Rocks at rim ×');
    expect(friendlyLabel('galaxy sea drop ×R')).toBe('Galaxy sea drop ×R');
    expect(friendlyLabel('radius (m)')).toBe('Radius (m)');
    expect(friendlyLabel('post (?look=0)')).toBe('Post (?look=0)');
    expect(friendlyLabel('height')).toBe('Height');
  });

  it('缩写写成大写', () => {
    expect(friendlyLabel('fov°')).toBe('FOV°');
    expect(friendlyLabel('life cpu')).toBe('Life CPU');
  });

  it('空标签（故意不显示名字）原样返回', () => {
    expect(friendlyLabel('')).toBe('');
  });
});
