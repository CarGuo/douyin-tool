import type { AxiosInstance } from 'axios';
import { extractShareUrl } from './extractUrl.js';
import { createDouyinClient, fetchSharePage, resolveShareUrl } from './douyinClient.js';
import { parseHtml, type ParsedAweme } from './parser.js';

export interface ParseService {
  parseFromUserInput(input: string): Promise<ParsedAweme>;
}

export class InvalidLinkError extends Error {
  code = 'INVALID_LINK';
}
export class UpstreamError extends Error {
  code = 'UPSTREAM';
  constructor(msg: string, public cause?: unknown) {
    super(msg);
  }
}
export class ParseFailedError extends Error {
  code = 'PARSE_FAILED';
}

export interface ParseServiceDeps {
  client?: AxiosInstance;
  /** Override fetcher for testing without network. */
  fetchPage?: (url: string) => Promise<string>;
  resolveUrl?: (url: string) => Promise<string>;
}

export function createParseService(deps: ParseServiceDeps = {}): ParseService {
  const client = deps.client ?? createDouyinClient();
  const resolveUrl = deps.resolveUrl ?? ((u: string) => resolveShareUrl(client, u));
  const fetchPage = deps.fetchPage ?? ((u: string) => fetchSharePage(client, u));

  return {
    async parseFromUserInput(input: string): Promise<ParsedAweme> {
      const url = extractShareUrl(input);
      if (!url) throw new InvalidLinkError('未在输入中识别到有效的抖音链接');

      let longUrl: string;
      try {
        longUrl = await resolveUrl(url);
      } catch (err) {
        throw new UpstreamError('解析短链跳转失败', err);
      }

      let html: string;
      try {
        html = await fetchPage(longUrl);
      } catch (err) {
        throw new UpstreamError('抓取分享页失败', err);
      }

      const parsed = parseHtml(html);
      if (!parsed) throw new ParseFailedError('页面结构变化，未能解析出作品数据');
      return parsed;
    },
  };
}
