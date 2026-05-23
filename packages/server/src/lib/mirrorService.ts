/**
 * Mirror service: orchestrates "mirror Douyin media into our OSS bucket".
 *
 * Public surface:
 *   - ensureMirror(awemeId, kind, srcUrl): kicks off a fetch (idempotent).
 *   - getMirrorStatus(awemeId, kind, idx?): query state and obtain a signed
 *     URL once ready.
 *
 * Internal state:
 *   - In-memory map (awemeId+kind+idx → MirrorEntry). No persistence: if the
 *     server restarts users may need a re-fetch (cheap because storage-side
 *     the object is still there; we just re-validate via head()).
 *   - Each entry has a state machine: idle → fetching → ready / error.
 *   - Inflight Promise dedup: parallel callers wait on the same Promise.
 *
 * Object key layout (deterministic so dedup works):
 *   douyin/<awemeId>/<kind>[<-i>].<ext>
 *
 * Examples:
 *   douyin/7351234567890123456/video.mp4
 *   douyin/7351234567890123456/cover.jpg
 *   douyin/7351234567890123456/image-3.jpg
 *   douyin/7351234567890123456/music.mp3
 */

import type { OssProvider, SignOptions } from './oss/index.js';

export type MirrorKind = 'video' | 'cover' | 'image' | 'music';

export interface MirrorRequest {
  awemeId: string;
  kind: MirrorKind;
  /** 0-based index for image collections; ignored for other kinds. */
  index?: number;
  srcUrl: string;
  /** Optional MIME hint to set Content-Type on the OSS object. */
  contentType?: string;
}

export type MirrorState = 'idle' | 'fetching' | 'ready' | 'error';

export interface MirrorStatus {
  state: MirrorState;
  objectKey: string;
  /** Set when state = 'ready'. */
  signedUrl?: string;
  /** Set when state = 'error'. */
  error?: string;
  /** Unix epoch ms when fetch started. Useful for stuck-detection / UI ETA. */
  startedAt?: number;
  /** Unix epoch ms when fetch finished (success or failure). */
  finishedAt?: number;
}

interface MirrorEntry extends MirrorStatus {
  inflight?: Promise<void>;
  /** node Timer handle for the scheduled cleanup; cleared if the entry is
   * superseded or evicted before the TTL fires. */
  expireTimer?: ReturnType<typeof setTimeout>;
}

const EXT_FOR_KIND: Record<MirrorKind, string> = {
  video: 'mp4',
  cover: 'jpg',
  image: 'jpg',
  music: 'mp3',
};

const CT_FOR_KIND: Record<MirrorKind, string> = {
  video: 'video/mp4',
  cover: 'image/jpeg',
  image: 'image/jpeg',
  music: 'audio/mpeg',
};

export function buildObjectKey(req: Pick<MirrorRequest, 'awemeId' | 'kind' | 'index'>): string {
  const ext = EXT_FOR_KIND[req.kind];
  const id = req.awemeId.replace(/[^A-Za-z0-9_\-]/g, '');
  if (req.kind === 'image') {
    const idx = typeof req.index === 'number' ? req.index : 0;
    return `douyin/${id}/image-${idx}.${ext}`;
  }
  return `douyin/${id}/${req.kind}.${ext}`;
}

export interface MirrorServiceOptions {
  provider: OssProvider;
  /** TTL for signed URLs (seconds). */
  signedUrlTtlSec: number;
  /** Logger; structurally compatible with fastify's logger or console. */
  logger?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
  /** Optional cache cap to avoid unbounded memory. */
  maxEntries?: number;
}

export class MirrorService {
  private readonly entries = new Map<string, MirrorEntry>();

  constructor(private readonly opts: MirrorServiceOptions) {}

  /**
   * Idempotently start mirroring `srcUrl` into the bucket. Returns the
   * current status snapshot. Callers may poll later via getMirrorStatus().
   *
   * If the object already exists in the bucket (e.g. another user mirrored
   * it earlier, or our process restarted), we lazily transition to 'ready'
   * after a head() check — no re-fetch needed.
   */
  async ensureMirror(req: MirrorRequest): Promise<MirrorStatus> {
    const objectKey = buildObjectKey(req);
    let entry = this.entries.get(objectKey);

    if (!entry) {
      entry = { state: 'idle', objectKey };
      this.entries.set(objectKey, entry);
      this.evictIfNeeded();
    }

    if (entry.state === 'ready') return this.snapshot(entry);
    if (entry.state === 'fetching') return this.snapshot(entry);

    // idle or error: kick off (or retry) a fetch.
    entry.state = 'fetching';
    entry.startedAt = Date.now();
    entry.error = undefined;

    entry.inflight = this.runFetch(entry, req).catch((err) => {
      entry!.state = 'error';
      entry!.error = err instanceof Error ? err.message : String(err);
      entry!.finishedAt = Date.now();
      this.opts.logger?.warn?.('[mirror] fetch failed', { objectKey, err: entry!.error });
    });

    return this.snapshot(entry);
  }

  /**
   * Force-refresh from storage state. Useful when ensureMirror was called
   * before but the process has since restarted (entry lost, but the object
   * may already be in the bucket).
   */
  async getMirrorStatus(req: Pick<MirrorRequest, 'awemeId' | 'kind' | 'index'>, signOpts?: SignOptions): Promise<MirrorStatus> {
    const objectKey = buildObjectKey(req);
    const entry = this.entries.get(objectKey);
    if (entry?.state === 'ready') {
      return this.snapshot(entry, signOpts);
    }
    if (entry?.state === 'fetching' || entry?.state === 'error') {
      return this.snapshot(entry);
    }
    // Cold lookup: maybe the object exists in storage from a previous run.
    try {
      const info = await this.opts.provider.head(objectKey);
      if (info.exists) {
        const newEntry: MirrorEntry = {
          state: 'ready',
          objectKey,
          finishedAt: Date.now(),
        };
        this.entries.set(objectKey, newEntry);
        // Best-effort: schedule a cleanup TTL from "now". If the object was
        // uploaded earlier in a previous process this overshoots, but the
        // worst case is the file lives a bit longer than ttlMinutes — never
        // shorter — which is acceptable for a "no longer than 30 min" UX.
        this.scheduleExpiry(newEntry);
        return this.snapshot(newEntry, signOpts);
      }
    } catch (err) {
      this.opts.logger?.warn?.('[mirror] head probe failed', { objectKey, err });
    }
    return { state: 'idle', objectKey };
  }

  /** For tests / diagnostics. */
  size(): number {
    return this.entries.size;
  }

  private async runFetch(entry: MirrorEntry, req: MirrorRequest): Promise<void> {
    const { objectKey } = entry;
    // Pre-flight head: if a previous run already uploaded, skip the fetch.
    try {
      const info = await this.opts.provider.head(objectKey);
      if (info.exists) {
        entry.state = 'ready';
        entry.finishedAt = Date.now();
        this.scheduleExpiry(entry);
        return;
      }
    } catch {
      // Ignore head errors; we'll try fetch anyway.
    }

    await this.opts.provider.cloudFetch({
      srcUrl: req.srcUrl,
      objectKey,
      contentType: req.contentType ?? CT_FOR_KIND[req.kind],
      upstreamHeaders: { Referer: 'https://www.douyin.com/' },
    });

    entry.state = 'ready';
    entry.finishedAt = Date.now();
    this.scheduleExpiry(entry);
  }

  /**
   * Qiniu (and most cloud storages) expose lifecycle rules with whole-day
   * granularity, so a "delete after 30 minutes" policy can't be enforced at
   * the bucket level. We schedule a process-side `provider.del()` instead.
   * The signed URL TTL is matched to this same window so the link goes dead
   * the instant the object is removed.
   *
   * Caveats:
   *   - If the server restarts before the timer fires the object will live
   *     until the next time the same key is mirrored (head() will re-set the
   *     timer). Operators wanting hard guarantees should also configure a
   *     bucket-side daily cleanup as a safety net.
   *   - We deliberately .unref() the timer so it never blocks process exit.
   */
  private scheduleExpiry(entry: MirrorEntry): void {
    if (entry.expireTimer) clearTimeout(entry.expireTimer);
    const ttlMs = this.opts.signedUrlTtlSec * 1000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const provider = this.opts.provider;
    if (!provider.del) return;
    const t = setTimeout(() => {
      provider
        .del!(entry.objectKey)
        .then(() => {
          this.opts.logger?.info?.('[mirror] expired & deleted', { objectKey: entry.objectKey });
          // Drop the entry so the next request triggers a fresh re-fetch
          // rather than handing out a signed URL pointing at a vanished
          // object.
          if (this.entries.get(entry.objectKey) === entry) {
            this.entries.delete(entry.objectKey);
          }
        })
        .catch((err) => {
          this.opts.logger?.warn?.('[mirror] expiry delete failed', {
            objectKey: entry.objectKey,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }, ttlMs);
    if (typeof t.unref === 'function') t.unref();
    entry.expireTimer = t;
  }

  private snapshot(entry: MirrorEntry, signOpts?: SignOptions): MirrorStatus {
    const out: MirrorStatus = {
      state: entry.state,
      objectKey: entry.objectKey,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      error: entry.error,
    };
    if (entry.state === 'ready') {
      out.signedUrl = this.opts.provider.signGetUrl(
        entry.objectKey,
        this.opts.signedUrlTtlSec,
        signOpts,
      );
    }
    return out;
  }

  private evictIfNeeded(): void {
    const cap = this.opts.maxEntries ?? 5000;
    if (this.entries.size <= cap) return;
    // Map preserves insertion order; drop the oldest entries until under cap.
    const overflow = this.entries.size - cap;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (removed >= overflow) break;
      const e = this.entries.get(key);
      if (e?.state === 'fetching') continue; // never evict an inflight fetch
      if (e?.expireTimer) clearTimeout(e.expireTimer);
      this.entries.delete(key);
      removed += 1;
    }
  }
}
