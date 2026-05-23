import { describe, it, expect } from 'vitest';
import {
  qiniuManageToken,
  qiniuSignDownload,
  urlSafeBase64,
} from '../../src/lib/oss/qiniu.js';
import { buildObjectKey } from '../../src/lib/mirrorService.js';
import { loadOssEnv } from '../../src/lib/oss/types.js';

describe('qiniu / oss helpers', () => {
  it('urlSafeBase64 replaces + and / with - and _', () => {
    // Pick bytes whose base64 encoding contains both `+` and `/`
    // Buffer [0xfb, 0xff, 0xff] → base64 "+///" → urlSafe "-___"
    const out = urlSafeBase64(Buffer.from([0xfb, 0xff, 0xff]));
    expect(out).toBe('-___');
    // Round-trip a string
    const s = urlSafeBase64('Man');
    expect(s).toBe('TWFu');
  });

  it('qiniuManageToken matches the documented signing rule', () => {
    // Sample taken from Qiniu's developer docs: signing string is "<path>\n<body>"
    // for management APIs. We verify the algorithm is HMAC-SHA1 with urlSafe base64.
    // Reference value computed once via Node's crypto for these inputs.
    const ak = 'MY_ACCESS_KEY';
    const sk = 'MY_SECRET_KEY';
    const path = '/stat/dGVzdC1idWNrZXQ6Zm9v';
    const tok = qiniuManageToken(ak, sk, path);
    expect(tok.startsWith(`${ak}:`)).toBe(true);
    // Token is deterministic; this catches accidental algorithm changes.
    // Computed via: HMAC-SHA1(sk, path + "\n").base64-urlsafe
    //   node -e "const c=require('crypto');const sk='MY_SECRET_KEY';
    //     console.log('MY_ACCESS_KEY:'+c.createHmac('sha1',sk)
    //       .update('/stat/dGVzdC1idWNrZXQ6Zm9v\n').digest()
    //       .toString('base64').replace(/\+/g,'-').replace(/\//g,'_'))"
    expect(tok).toBe('MY_ACCESS_KEY:9OlM9acRj7nGnfgn5LpILCyWm0I=');
  });

  it('qiniuSignDownload appends e and token query params', () => {
    const url = 'https://cdn.example.com/path/to/object.mp4';
    const signed = qiniuSignDownload('AK', 'SK', url, 1700000000);
    expect(signed.startsWith(url)).toBe(true);
    expect(signed).toContain('?e=1700000000');
    expect(signed).toContain('&token=AK%3A');
  });

  it('qiniuSignDownload preserves preexisting query strings (uses & instead of ?)', () => {
    const url = 'https://cdn.example.com/file?attname=hi.mp4';
    const signed = qiniuSignDownload('AK', 'SK', url, 1700000000);
    expect(signed).toMatch(/\?attname=hi\.mp4&e=1700000000&token=/);
  });

  it('buildObjectKey is deterministic and namespaced by awemeId', () => {
    expect(buildObjectKey({ awemeId: '7351234567890123456', kind: 'video' })).toBe(
      'douyin/7351234567890123456/video.mp4',
    );
    expect(buildObjectKey({ awemeId: '7351234567890123456', kind: 'cover' })).toBe(
      'douyin/7351234567890123456/cover.jpg',
    );
    expect(
      buildObjectKey({ awemeId: '7351234567890123456', kind: 'image', index: 3 }),
    ).toBe('douyin/7351234567890123456/image-3.jpg');
    expect(buildObjectKey({ awemeId: '7351234567890123456', kind: 'music' })).toBe(
      'douyin/7351234567890123456/music.mp3',
    );
  });

  it('buildObjectKey strips dangerous characters from awemeId', () => {
    const key = buildObjectKey({ awemeId: '../etc/passwd 123', kind: 'video' });
    expect(key).toBe('douyin/etcpasswd123/video.mp4');
  });

  it('loadOssEnv defaults autoMirror to false even when credentials are present', () => {
    const env = loadOssEnv({
      OSS_PROVIDER: 'qiniu',
      OSS_ACCESS_KEY: 'ak',
      OSS_SECRET_KEY: 'sk',
      OSS_BUCKET: 'bk',
      OSS_REGION: 'z2',
      OSS_PUBLIC_HOST: 'https://cdn.example.com',
    } as NodeJS.ProcessEnv);
    expect(env.enabled).toBe(true);
    expect(env.autoMirror).toBe(false);
  });

  it('loadOssEnv parses autoMirror truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', 'Yes']) {
      const env = loadOssEnv({ OSS_AUTO_MIRROR: v } as NodeJS.ProcessEnv);
      expect(env.autoMirror, `value=${v}`).toBe(true);
    }
  });

  it('loadOssEnv treats empty / unknown values as autoMirror=false', () => {
    for (const v of ['', '0', 'no', 'off', 'false', 'maybe']) {
      const env = loadOssEnv({ OSS_AUTO_MIRROR: v } as NodeJS.ProcessEnv);
      expect(env.autoMirror, `value=${v}`).toBe(false);
    }
  });

  it('loadOssEnv defaults ttlMinutes to 30', () => {
    const env = loadOssEnv({} as NodeJS.ProcessEnv);
    expect(env.ttlMinutes).toBe(30);
  });

  it('loadOssEnv prefers OSS_OBJECT_TTL_MINUTES over legacy hours', () => {
    const env = loadOssEnv({
      OSS_OBJECT_TTL_MINUTES: '15',
      OSS_OBJECT_TTL_HOURS: '12',
    } as NodeJS.ProcessEnv);
    expect(env.ttlMinutes).toBe(15);
  });

  it('loadOssEnv falls back to OSS_OBJECT_TTL_HOURS x 60 when minutes is missing', () => {
    const env = loadOssEnv({
      OSS_OBJECT_TTL_HOURS: '2',
    } as NodeJS.ProcessEnv);
    expect(env.ttlMinutes).toBe(120);
  });

  it('loadOssEnv caps ttlMinutes at 1440 (24h)', () => {
    const env = loadOssEnv({
      OSS_OBJECT_TTL_MINUTES: '99999',
    } as NodeJS.ProcessEnv);
    expect(env.ttlMinutes).toBe(1440);
  });
});
