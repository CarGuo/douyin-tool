/**
 * Thin HTTP client for Douyin endpoints.
 * Centralizes UA / Referer headers so every call mimics a real iPhone.
 */
import axios, { AxiosInstance } from 'axios';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

export interface DouyinClientOptions {
  timeoutMs?: number;
  ua?: string;
}

export function createDouyinClient(opts: DouyinClientOptions = {}): AxiosInstance {
  const ua = opts.ua ?? IPHONE_UA;
  const instance = axios.create({
    timeout: opts.timeoutMs ?? 12000,
    maxRedirects: 5,
    headers: {
      'User-Agent': ua,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return instance;
}

/**
 * Resolve a v.douyin.com short URL to the canonical iesdouyin share URL.
 * If `url` is already a long URL, returns it unchanged.
 */
export async function resolveShareUrl(client: AxiosInstance, url: string): Promise<string> {
  const u = new URL(url);
  if (u.hostname !== 'v.douyin.com') return url;
  // Use HEAD first, fall back to GET.
  try {
    const res = await client.head(url, { maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
    const loc = res.headers['location'];
    if (typeof loc === 'string' && loc.length > 0) return loc;
  } catch {
    // some shorts respond 405 on HEAD
  }
  const res = await client.get(url, { maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
  const loc = res.headers['location'];
  if (typeof loc === 'string' && loc.length > 0) return loc;
  return url;
}

export async function fetchSharePage(client: AxiosInstance, longUrl: string): Promise<string> {
  const res = await client.get<string>(longUrl, { responseType: 'text' });
  return res.data;
}
