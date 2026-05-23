import { describe, it, expect } from 'vitest';
import { extractShareUrl, isAllowedHost } from '../src/lib/extractUrl.js';

describe('extractShareUrl', () => {
  it('extracts a v.douyin.com short url from typical share text', () => {
    const text = '7.99 复制打开抖音，看看【XXX】 https://v.douyin.com/iABCDEF/ 转发给朋友';
    expect(extractShareUrl(text)).toBe('https://v.douyin.com/iABCDEF/');
  });

  it('extracts a long iesdouyin url', () => {
    const text = '看看 https://www.iesdouyin.com/share/video/7300000000000000001/?region=CN';
    expect(extractShareUrl(text)).toBe(
      'https://www.iesdouyin.com/share/video/7300000000000000001/?region=CN',
    );
  });

  it('rejects non-douyin urls', () => {
    expect(extractShareUrl('hello https://example.com/abc')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractShareUrl('')).toBeNull();
  });

  it('isAllowedHost works', () => {
    expect(isAllowedHost('v.douyin.com')).toBe(true);
    expect(isAllowedHost('evil.com')).toBe(false);
  });
});
