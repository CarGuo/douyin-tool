/**
 * Pure utility: extract a Douyin share URL from arbitrary user-pasted text.
 *
 * Users typically paste the whole share string like:
 *   "7.99 复制打开抖音，看看【XXX】 https://v.douyin.com/iABCDEF/ 转发给朋友"
 * We need to pull the URL out before doing anything else.
 */

const URL_REGEX = /(https?:\/\/[^\s\u4e00-\u9fa5]+)/g;

const ALLOWED_HOSTS = new Set([
  'v.douyin.com',
  'www.douyin.com',
  'douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
]);

export function extractShareUrl(input: string): string | null {
  if (!input) return null;
  const matches = input.match(URL_REGEX);
  if (!matches) return null;
  for (const raw of matches) {
    try {
      const u = new URL(raw);
      if (ALLOWED_HOSTS.has(u.hostname)) return u.toString();
    } catch {
      // ignore malformed
    }
  }
  return null;
}

export function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host);
}
