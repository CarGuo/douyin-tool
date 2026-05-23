/**
 * Parse the `window._ROUTER_DATA` JSON island from an iesdouyin share page
 * and normalize it into our internal AwemeDetail shape.
 *
 * This module is intentionally side-effect free and HTTP-free, so it can be
 * unit tested with fixture HTML without hitting Douyin servers.
 */

export type AwemeKind = 'video' | 'image' | 'unknown';

export interface ParsedAweme {
  kind: AwemeKind;
  awemeId: string;
  desc: string;
  author: { nickname: string; uid?: string; avatar?: string };
  cover?: string;
  video?: { playUrl: string; playUrlNoWatermark: string; duration?: number };
  images?: Array<{ url: string; width?: number; height?: number }>;
  music?: { title?: string; author?: string; playUrl?: string };
  raw?: unknown;
}

const ROUTER_DATA_RE = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/;

export function findRouterDataJson(html: string): string | null {
  const m = html.match(ROUTER_DATA_RE);
  return m ? m[1] : null;
}

interface RawUrlListContainer {
  url_list?: string[];
  uri?: string;
}

interface RawAwemeDetail {
  aweme_id?: string;
  awemeId?: string;
  desc?: string;
  images?: Array<RawUrlListContainer & { width?: number; height?: number }> | null;
  video?: {
    play_addr?: RawUrlListContainer;
    cover?: RawUrlListContainer;
    duration?: number;
  };
  music?: {
    title?: string;
    author?: string;
    play_url?: RawUrlListContainer;
  };
  author?: { nickname?: string; uid?: string; avatar_thumb?: RawUrlListContainer };
}

function pickFirstUrl(container?: RawUrlListContainer): string | undefined {
  if (!container || !container.url_list) return undefined;
  return container.url_list.find(Boolean);
}

/**
 * Replace `playwm` segment with `play` to obtain a no-watermark variant.
 * Douyin's CDN historically accepts both, this is the long-standing trick.
 */
export function toNoWatermark(url: string): string {
  return url.replace('/playwm/', '/play/').replace('playwm', 'play');
}

/**
 * Walk the deserialized _ROUTER_DATA looking for the first object containing
 * an `aweme_detail` (single page) or `aweme_id` field.
 */
export function findAwemeDetail(routerData: unknown): RawAwemeDetail | null {
  if (!routerData || typeof routerData !== 'object') return null;
  const stack: unknown[] = [routerData];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    const obj = cur as Record<string, unknown>;
    if (
      (obj.aweme_id || obj.awemeId) &&
      (obj.video || obj.images || obj.music)
    ) {
      return obj as RawAwemeDetail;
    }
    if (obj.aweme_detail && typeof obj.aweme_detail === 'object') {
      stack.push(obj.aweme_detail);
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

export function normalizeAweme(raw: RawAwemeDetail): ParsedAweme {
  const awemeId = raw.aweme_id ?? raw.awemeId ?? '';
  const desc = raw.desc ?? '';

  const cover = pickFirstUrl(raw.video?.cover);

  const author = {
    nickname: raw.author?.nickname ?? '',
    uid: raw.author?.uid,
    avatar: pickFirstUrl(raw.author?.avatar_thumb),
  };

  const music = raw.music
    ? {
        title: raw.music.title,
        author: raw.music.author,
        playUrl: pickFirstUrl(raw.music.play_url),
      }
    : undefined;

  const hasImages = Array.isArray(raw.images) && raw.images.length > 0;
  if (hasImages) {
    const images = (raw.images ?? [])
      .map((img) => ({
        url: pickFirstUrl(img) ?? '',
        width: img.width,
        height: img.height,
      }))
      .filter((i) => i.url);
    return {
      kind: 'image',
      awemeId,
      desc,
      author,
      cover,
      images,
      music,
    };
  }

  const playRaw = pickFirstUrl(raw.video?.play_addr);
  if (playRaw) {
    return {
      kind: 'video',
      awemeId,
      desc,
      author,
      cover,
      video: {
        playUrl: playRaw,
        playUrlNoWatermark: toNoWatermark(playRaw),
        duration: raw.video?.duration,
      },
      music,
    };
  }

  return { kind: 'unknown', awemeId, desc, author, cover, music };
}

export function parseHtml(html: string): ParsedAweme | null {
  const json = findRouterDataJson(html);
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const detail = findAwemeDetail(data);
  if (!detail) return null;
  return normalizeAweme(detail);
}
