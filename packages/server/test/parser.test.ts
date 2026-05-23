import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHtml, toNoWatermark } from '../src/lib/parser.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(resolve(here, 'fixtures', name), 'utf8');
}

describe('toNoWatermark', () => {
  it('replaces playwm with play', () => {
    expect(toNoWatermark('https://x/aweme/v1/playwm/?video_id=v1')).toBe(
      'https://x/aweme/v1/play/?video_id=v1',
    );
  });
});

describe('parseHtml', () => {
  it('parses video fixture', () => {
    const r = parseHtml(loadFixture('video.html'));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('video');
    expect(r!.awemeId).toBe('7300000000000000001');
    expect(r!.video?.playUrlNoWatermark).toContain('/play/');
    expect(r!.music?.playUrl).toMatch(/^https:\/\//);
    expect(r!.author.nickname).toBe('Fixture User');
  });

  it('parses image fixture', () => {
    const r = parseHtml(loadFixture('image.html'));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('image');
    expect(r!.images).toHaveLength(3);
    expect(r!.images![0].url).toMatch(/^https:\/\//);
  });

  it('returns null when no _ROUTER_DATA', () => {
    expect(parseHtml('<html><body>nope</body></html>')).toBeNull();
  });
});
