/**
 * Pluggable OSS provider abstraction.
 *
 * Why this layer exists:
 * Our origin server has only 1Mbps egress. Streaming Douyin media through it
 * is the bottleneck. By "mirroring" each media object to a cloud bucket
 * (Qiniu / Tencent COS / Aliyun OSS / S3) we let the user fetch directly from
 * the storage CDN, completely bypassing our 1Mbps pipe.
 *
 * Each provider must implement:
 *   - cloudFetch(): ask the storage to PULL the file from a remote URL on
 *     its OWN bandwidth (so our server transfers ZERO bytes).
 *   - signGetUrl(): produce a time-limited URL the browser can hit directly.
 *   - head(): probe whether an object already exists (dedup hits).
 */

export type MediaKind = 'video' | 'image' | 'music';

export interface CloudFetchOptions {
  /** Source URL on Douyin CDN. Provider may forward `headers` if it supports it. */
  srcUrl: string;
  /** Target object key inside the bucket. */
  objectKey: string;
  /**
   * Custom upstream headers (e.g. Referer) the provider should send when
   * pulling. Some providers (Qiniu) ignore this. We try our best.
   */
  upstreamHeaders?: Record<string, string>;
  /** Best-effort MIME hint. */
  contentType?: string;
}

export interface CloudFetchResult {
  /** True when the provider has confirmed the object is in the bucket. */
  done: boolean;
  /** Optional persistent ID returned by async-fetch APIs (e.g. Qiniu sisyphus). */
  taskId?: string;
}

export interface ObjectInfo {
  exists: boolean;
  size?: number;
  etag?: string;
  /** Unix epoch seconds. */
  uploadedAt?: number;
}

export interface OssProvider {
  /** Provider name for logging / diagnostics. */
  readonly name: string;

  /**
   * Ensure `objectKey` ends up in the bucket pulled from `srcUrl`. Returns
   * `done:true` once the object is confirmed present. Implementations that
   * back this with a synchronous fetch should block until the upload is
   * finished; async ones should poll internally.
   *
   * Caller is expected to wrap this in a memoized in-flight registry to
   * avoid duplicate fetches for the same object.
   */
  cloudFetch(opts: CloudFetchOptions): Promise<CloudFetchResult>;

  /** Probe object existence (cheap HEAD or list-prefix). */
  head(objectKey: string): Promise<ObjectInfo>;

  /**
   * Delete an object from the bucket. Used to enforce sub-day TTLs (e.g.
   * Qiniu lifecycle is whole-days only — for "delete after 30 minutes" we
   * have to schedule the call ourselves). Implementations should be
   * idempotent: deleting a missing key is NOT an error.
   */
  del?(objectKey: string): Promise<void>;

  /**
   * Build a temporary GET URL the browser can use directly. `ttlSec` is the
   * desired lifetime. Implementations that drive a public bucket may simply
   * return an unsigned CDN URL.
   */
  signGetUrl(objectKey: string, ttlSec: number, opts?: SignOptions): string;
}

export interface SignOptions {
  /** Suggest browser to download with this filename rather than display. */
  attachmentFilename?: string;
  /** Override response content-type if the storage supports it. */
  responseContentType?: string;
}

export interface OssEnv {
  provider: 'qiniu' | 'tencent-cos' | 'aliyun-oss' | 's3' | '';
  accessKey: string;
  secretKey: string;
  bucket: string;
  /** Provider-specific zone code (qiniu: z0/z1/z2/na0/as0; cos region; oss region). */
  region: string;
  /** Public CDN host bound to the bucket, e.g. https://img.cdn.example.com */
  publicHost: string;
  /**
   * Signed URL TTL in MINUTES. Default 30. The bucket lifecycle rule should
   * delete objects on the same schedule so the file genuinely disappears
   * after this window — the signed URL just enforces the upper bound from
   * the auth side.
   */
  ttlMinutes: number;
  /** When non-empty, mirroring infrastructure is configured (provider/keys present). */
  enabled: boolean;
  /**
   * Whether /api/parse should automatically warm-up mirrors for every parsed
   * link. Defaults to FALSE — even when credentials are configured we do not
   * burn quota / risk an untested provider on every parse. Operators should
   * use the manual `POST /api/mirror/test` endpoint to verify the full pipe
   * first, then flip OSS_AUTO_MIRROR=1 once they're confident.
   */
  autoMirror: boolean;
}

export function loadOssEnv(env: NodeJS.ProcessEnv = process.env): OssEnv {
  const provider = (env.OSS_PROVIDER || '').trim() as OssEnv['provider'];
  const accessKey = (env.OSS_ACCESS_KEY || '').trim();
  const secretKey = (env.OSS_SECRET_KEY || '').trim();
  const bucket = (env.OSS_BUCKET || '').trim();
  const region = (env.OSS_REGION || '').trim();
  const publicHost = (env.OSS_PUBLIC_HOST || '').replace(/\/+$/, '');
  // Prefer the new minute-precision env var; fall back to the legacy hour
  // var for older deployments. Hard-cap at 1440 (24h) so a stale value can't
  // accidentally produce a long-lived link to a "30-min" object.
  const explicitMin = Number(env.OSS_OBJECT_TTL_MINUTES || '');
  const legacyHours = Number(env.OSS_OBJECT_TTL_HOURS || '');
  let ttlMinutes = 30;
  if (Number.isFinite(explicitMin) && explicitMin > 0) {
    ttlMinutes = explicitMin;
  } else if (Number.isFinite(legacyHours) && legacyHours > 0) {
    ttlMinutes = legacyHours * 60;
  }
  if (ttlMinutes > 1440) ttlMinutes = 1440;
  const enabled = Boolean(provider && accessKey && secretKey && bucket && publicHost);
  const autoRaw = (env.OSS_AUTO_MIRROR || '').trim().toLowerCase();
  const autoMirror = autoRaw === '1' || autoRaw === 'true' || autoRaw === 'yes';
  return {
    provider,
    accessKey,
    secretKey,
    bucket,
    region,
    publicHost,
    ttlMinutes,
    enabled,
    autoMirror,
  };
}
