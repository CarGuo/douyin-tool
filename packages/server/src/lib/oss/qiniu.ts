/**
 * Qiniu Cloud (Kodo) provider implementation.
 *
 * Reference docs:
 *   - Fetch API: https://developer.qiniu.com/kodo/1263/fetch
 *   - Stat (HEAD): https://developer.qiniu.com/kodo/1308/stat
 *   - Private GET signature: https://developer.qiniu.com/kodo/1202/download-token
 *   - Management/IO host map: https://developer.qiniu.com/kodo/1671/region-endpoint-fq
 *
 * Why no SDK:
 * Qiniu's three operations we need (fetch / stat / sign) are all simple HTTP
 * calls with HMAC-SHA1 signatures. Pulling in `qiniu` npm package costs us
 * a 1MB+ install footprint and a transitive dep tree on a 1Mbps server, for
 * what amounts to ~80 lines of plain code.
 */

import { createHmac } from 'node:crypto';
import axios, { type AxiosInstance } from 'axios';
import type {
  CloudFetchOptions,
  CloudFetchResult,
  ObjectInfo,
  OssProvider,
  SignOptions,
} from './types.js';

/**
 * Qiniu region → API host mapping. Their ZH docs call these "iovip" / "rs"
 * for io and management respectively. We only need fetch (which lives on the
 * "iovip" host) and stat (lives on "rs").
 */
const QINIU_HOSTS: Record<string, { io: string; rs: string }> = {
  z0: { io: 'iovip-z0.qiniuio.com', rs: 'rs-z0.qiniuapi.com' },
  z1: { io: 'iovip-z1.qiniuio.com', rs: 'rs-z1.qiniuapi.com' },
  z2: { io: 'iovip-z2.qiniuio.com', rs: 'rs-z2.qiniuapi.com' },
  na0: { io: 'iovip-na0.qiniuio.com', rs: 'rs-na0.qiniuapi.com' },
  as0: { io: 'iovip-as0.qiniuio.com', rs: 'rs-as0.qiniuapi.com' },
};

export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  /** z0 / z1 / z2 / na0 / as0 */
  region: string;
  /** Public CDN host bound to the bucket (no trailing slash). */
  publicHost: string;
  /** Treat bucket as private — sign every GET URL. Default true (safer). */
  privateBucket?: boolean;
}

/**
 * URL-safe Base64 (RFC 4648 §5). Qiniu uses this for its access tokens and
 * for encoding fetch sources/destinations.
 */
export function urlSafeBase64(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Qiniu management token: `{accessKey}:{urlSafeBase64(HMAC-SHA1(secret, signing))}`
 * where `signing` is the HTTP method-specific string described in the docs.
 *
 * For management APIs (fetch / stat / move / copy / delete) the signing
 * payload is `<path>?<query>\n<body>` (body empty for GET/POST without form).
 */
export function qiniuManageToken(
  accessKey: string,
  secretKey: string,
  pathWithQuery: string,
  body = '',
): string {
  const signing = `${pathWithQuery}\n${body}`;
  const sig = createHmac('sha1', secretKey).update(signing).digest();
  return `${accessKey}:${urlSafeBase64(sig)}`;
}

/**
 * Qiniu private GET signing: append `?e=<deadline>&token=<accessKey>:<sig>`
 * where sig = urlSafeBase64(HMAC-SHA1(sk, urlBeforeAppending)).
 */
export function qiniuSignDownload(
  accessKey: string,
  secretKey: string,
  rawUrl: string,
  deadlineSec: number,
): string {
  const sep = rawUrl.includes('?') ? '&' : '?';
  const withDeadline = `${rawUrl}${sep}e=${deadlineSec}`;
  const sig = createHmac('sha1', secretKey).update(withDeadline).digest();
  const token = `${accessKey}:${urlSafeBase64(sig)}`;
  return `${withDeadline}&token=${encodeURIComponent(token)}`;
}

export class QiniuProvider implements OssProvider {
  readonly name = 'qiniu';
  private readonly client: AxiosInstance;
  private readonly hosts: { io: string; rs: string };

  constructor(private readonly cfg: QiniuConfig) {
    const hosts = QINIU_HOSTS[cfg.region];
    if (!hosts) {
      throw new Error(`unknown qiniu region: ${cfg.region}`);
    }
    this.hosts = hosts;
    this.client = axios.create({
      timeout: 30_000,
      // Qiniu fetch may legitimately return 4xx (e.g. 478 partial fetch); we
      // want the body to inspect the error code instead of axios throwing.
      validateStatus: (s) => s >= 200 && s < 600,
    });
  }

  async cloudFetch(opts: CloudFetchOptions): Promise<CloudFetchResult> {
    const encodedSrc = urlSafeBase64(opts.srcUrl);
    const encodedEntry = urlSafeBase64(`${this.cfg.bucket}:${opts.objectKey}`);
    const path = `/fetch/${encodedSrc}/to/${encodedEntry}`;
    const token = qiniuManageToken(this.cfg.accessKey, this.cfg.secretKey, path);
    const url = `https://${this.hosts.io}${path}`;

    const res = await this.client.post(url, undefined, {
      headers: {
        Authorization: `QBox ${token}`,
        'Content-Type': 'application/octet-stream',
      },
    });

    if (res.status >= 200 && res.status < 300) {
      return { done: true };
    }
    const err = (res.data && (res.data.error || res.data.message)) || `qiniu fetch ${res.status}`;
    throw new Error(`qiniu cloudFetch failed: ${err}`);
  }

  async head(objectKey: string): Promise<ObjectInfo> {
    const encodedEntry = urlSafeBase64(`${this.cfg.bucket}:${objectKey}`);
    const path = `/stat/${encodedEntry}`;
    const token = qiniuManageToken(this.cfg.accessKey, this.cfg.secretKey, path);
    const url = `https://${this.hosts.rs}${path}`;

    const res = await this.client.get(url, {
      headers: { Authorization: `QBox ${token}` },
    });
    if (res.status === 200 && res.data && typeof res.data.fsize === 'number') {
      return {
        exists: true,
        size: res.data.fsize,
        etag: res.data.hash,
        // putTime is "100ns since epoch" per Qiniu docs.
        uploadedAt: res.data.putTime
          ? Math.floor(res.data.putTime / 1e7)
          : undefined,
      };
    }
    if (res.status === 612 || res.status === 404) {
      return { exists: false };
    }
    return { exists: false };
  }

  async del(objectKey: string): Promise<void> {
    const encodedEntry = urlSafeBase64(`${this.cfg.bucket}:${objectKey}`);
    const path = `/delete/${encodedEntry}`;
    const token = qiniuManageToken(this.cfg.accessKey, this.cfg.secretKey, path);
    const url = `https://${this.hosts.rs}${path}`;
    const res = await this.client.post(url, undefined, {
      headers: { Authorization: `QBox ${token}` },
    });
    // 200 = deleted; 612 = "no such file" (treat as success for idempotency).
    if (res.status === 200 || res.status === 612 || res.status === 404) return;
    const err = (res.data && (res.data.error || res.data.message)) || `qiniu delete ${res.status}`;
    throw new Error(`qiniu delete failed: ${err}`);
  }

  signGetUrl(objectKey: string, ttlSec: number, opts?: SignOptions): string {
    const params = new URLSearchParams();
    if (opts?.attachmentFilename) {
      params.set('attname', opts.attachmentFilename);
    }
    if (opts?.responseContentType) {
      params.set('content-type', opts.responseContentType);
    }
    const query = params.toString();
    const baseUrl = `${this.cfg.publicHost}/${encodeURIPath(objectKey)}${query ? `?${query}` : ''}`;

    if (this.cfg.privateBucket === false) {
      return baseUrl;
    }
    const deadline = Math.floor(Date.now() / 1000) + ttlSec;
    return qiniuSignDownload(this.cfg.accessKey, this.cfg.secretKey, baseUrl, deadline);
  }
}

/**
 * Path components inside an object key may legitimately contain `/` (we want
 * to keep the slashes), but other reserved chars must be percent-encoded.
 */
function encodeURIPath(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
