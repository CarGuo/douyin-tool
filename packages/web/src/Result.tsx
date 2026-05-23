import { useEffect, useRef, useState } from 'react';
import type { MirrorEcho, MirrorKind, MirrorTestFailure, MirrorTestSuccess, ParsedAweme } from './api';
import { downloadProxyUrl, inlineProxyUrl, probeSize, testMirrorUpload } from './api';

interface Props {
  data: ParsedAweme;
  /** Mirror echo from /api/parse. Undefined when OSS not configured. */
  mirror?: MirrorEcho | null;
}

interface Progress {
  key: string;
  filename: string;
  loaded: number;
  total: number;
  speed: number;
  done: boolean;
  error?: string;
  canceled?: boolean;
}

type MirrorJobState =
  | { status: 'idle' }
  | { status: 'uploading'; startedAt: number }
  | { status: 'ready'; url: string; elapsedMs: number; readyAt: number }
  | { status: 'error'; message: string };

interface MirrorTarget {
  kind: MirrorKind;
  index?: number;
  srcUrl: string;
  filename: string;
}

function safeName(s: string, fallback: string): string {
  const trimmed = (s || fallback).trim().slice(0, 40).replace(/[^\w\u4e00-\u9fa5.\-]+/g, '_');
  return trimmed || fallback;
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  return `${formatBytes(bps)}/s`;
}

function pickMimeType(filename: string, fallback: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return fallback || 'application/octet-stream';
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
interface FileSystemFileHandleLike {
  createWritable(): Promise<{
    write(data: BlobPart): Promise<void>;
    close(): Promise<void>;
  }>;
}

async function trySaveFilePicker(
  blob: Blob,
  filename: string,
): Promise<boolean> {
  const w = window as typeof window & {
    showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;
  };
  if (typeof w.showSaveFilePicker !== 'function') return false;
  try {
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      types: ext
        ? [
            {
              description: '视频/音频/图片文件',
              accept: { [blob.type || 'application/octet-stream']: [ext] },
            },
          ]
        : undefined,
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    const err = e as DOMException;
    // User-initiated cancel → don't fall back, just return true so we don't
    // also dump the file to the default downloads folder.
    if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
      return true;
    }
    return false;
  }
}

async function triggerSave(blob: Blob, filename: string): Promise<void> {
  const saved = await trySaveFilePicker(blob, filename);
  if (saved) return;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // Detach the <a> immediately, but hold the blob: URL alive long enough for
  // the OS-level save dialog (iOS "Save to Files" / Android Downloads) to
  // finish reading from it. 1.5s was too aggressive on slower iPhones — the
  // dialog showed but the underlying data was already revoked, leading to
  // 0-byte saves. 60s is conservative; the Blob is reclaimed by GC anyway
  // once the download stream is drained.
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1500);
  setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
}

async function streamingDownload(
  url: string,
  filename: string,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number, speed: number) => void,
  opts?: { credentials?: RequestCredentials },
): Promise<void> {
  const res = await fetch(url, {
    credentials: opts?.credentials ?? 'include',
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : 0;
  const ct = res.headers.get('content-type') || pickMimeType(filename, 'application/octet-stream');

  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob();
    onProgress(blob.size, blob.size, 0);
    await triggerSave(blob, filename);
    return;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const startTs = Date.now();
  let lastEmit = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      const now = Date.now();
      if (now - lastEmit > 120 || (total > 0 && loaded === total)) {
        const elapsedMs = Math.max(1, now - startTs);
        const speed = (loaded / elapsedMs) * 1000;
        onProgress(loaded, total, speed);
        lastEmit = now;
      }
    }
  }
  const elapsedMs = Math.max(1, Date.now() - startTs);
  onProgress(loaded, total || loaded, (loaded / elapsedMs) * 1000);

  const blob = new Blob(chunks as BlobPart[], { type: ct });
  await triggerSave(blob, filename);
}

function mirrorKey(kind: MirrorKind, index?: number): string {
  return `${kind}-${index ?? ''}`;
}

export default function Result({ data, mirror }: Props) {
  const baseName = safeName(data.desc, data.awemeId || 'douyin');
  const [progress, setProgress] = useState<Progress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ios = isIOS();

  // Map of media-key -> probed byte size, populated asynchronously after the
  // parse response arrives. We surface this on the "直接下载" buttons so users
  // see a "12.4 MB" hint *before* choosing how to download. 0 / undefined
  // means "still probing" or "size unknown" (rare CDNs don't honor HEAD).
  const [sizes, setSizes] = useState<Record<string, number>>({});

  // Probe sizes for video / cover / images / music in parallel right after
  // /api/parse returns. Each result is independent — a HEAD failure for one
  // media object never blocks the others.
  useEffect(() => {
    let aborted = false;
    const tasks: Array<Promise<void>> = [];
    const push = (key: string, url: string | undefined) => {
      if (!url) return;
      tasks.push(
        probeSize(url).then((n) => {
          if (aborted || !n || n <= 0) return;
          setSizes((prev) => (prev[key] === n ? prev : { ...prev, [key]: n }));
        }),
      );
    };
    push('video', data.video?.playUrlNoWatermark);
    push('music', data.music?.playUrl);
    if (Array.isArray(data.images)) {
      data.images.forEach((img, i) => push(`img-${i}`, img.url));
    }
    void Promise.allSettled(tasks);
    return () => {
      aborted = true;
    };
  }, [data]);

  // iOS Safari (and iPad WKWebView) reclaim <video> media buffers when the
  // tab goes to background. Coming back to the foreground frequently lands
  // on a "broken video" placeholder because the in-flight stream from
  // /api/download was already torn down. Force a fresh load() when the
  // document becomes visible again so the element re-requests bytes.
  useEffect(() => {
    if (data.kind !== 'video') return;
    const onShow = () => {
      const v = videoRef.current;
      if (!v) return;
      if (document.visibilityState === 'visible' && (v.readyState === 0 || v.error)) {
        try {
          v.load();
        } catch {
          // ignore — the next user interaction will retry
        }
      }
    };
    document.addEventListener('visibilitychange', onShow);
    // pageshow also fires on bfcache restore (Safari back/forward navigation).
    window.addEventListener('pageshow', onShow);
    return () => {
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('pageshow', onShow);
    };
  }, [data.kind]);

  // Mirror jobs are user-triggered (one button per media object). We do NOT
  // auto-warm anymore — the user explicitly wanted two buttons: "direct" and
  // "via Qiniu". The job lifecycle is idle → uploading → ready (which then
  // becomes a download button) | error.
  const [mirrorJobs, setMirrorJobs] = useState<Record<string, MirrorJobState>>({});
  // Tick once a second so the "uploading… X.Xs" label stays current without
  // each individual mirror button owning a timer.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const anyUploading = Object.values(mirrorJobs).some((j) => j.status === 'uploading');
    if (!anyUploading) return;
    const t = window.setInterval(() => setNowTick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [mirrorJobs]);

  const ttlMinutes = mirror?.ttlMinutes ?? 30;
  const mirrorEnabled = !!mirror?.enabled;

  async function runMirrorJob(key: string, target: MirrorTarget) {
    const cur = mirrorJobs[key];
    if (cur?.status === 'uploading') return;
    setMirrorJobs((prev) => ({ ...prev, [key]: { status: 'uploading', startedAt: Date.now() } }));
    const result: MirrorTestSuccess | MirrorTestFailure = await testMirrorUpload({
      srcUrl: target.srcUrl,
      kind: target.kind,
      index: target.index,
      awemeId: data.awemeId,
      filename: target.filename,
    });
    if (result.ok) {
      setMirrorJobs((prev) => ({
        ...prev,
        [key]: {
          status: 'ready',
          url: result.url,
          elapsedMs: result.elapsedMs,
          readyAt: Date.now(),
        },
      }));
      // Mirror done = file is on Qiniu CDN. Immediately stream it to the
      // user's machine with the same progress UI as direct download. This is
      // what the user actually wanted: "上传完成后给我一个下载".
      await handleMirroredDownload(result.url, target.filename, key);
    } else {
      setMirrorJobs((prev) => ({
        ...prev,
        [key]: { status: 'error', message: result.message || '上传失败' },
      }));
    }
  }

  async function handleMirroredDownload(url: string, filename: string, key: string) {
    // Stream the signed Qiniu URL through the same progress pipeline as
    // direct download. The signed URL already carries `attname=...`, so the
    // CDN response includes Content-Disposition: attachment — combined with
    // our fetch+Blob+a[download] flow this guarantees a real save dialog
    // (NOT a new tab playing the mp4 inline).
    if (progress && !progress.done && !progress.error && !progress.canceled) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ key, filename, loaded: 0, total: 0, speed: 0, done: false });
    try {
      await streamingDownload(
        url,
        filename,
        ctrl.signal,
        (loaded, total, speed) => {
          setProgress((prev) =>
            prev && prev.key === key ? { ...prev, loaded, total, speed } : prev,
          );
        },
        // Cross-origin to the OSS CDN host: must NOT send cookies, and
        // we don't need them (the URL is already signed).
        { credentials: 'omit' },
      );
      setProgress((prev) => (prev && prev.key === key ? { ...prev, done: true } : prev));
      window.setTimeout(() => {
        setProgress((prev) => (prev && prev.key === key && prev.done ? null : prev));
      }, 4000);
    } catch (e) {
      const err = e as Error;
      const canceled = err.name === 'AbortError';
      setProgress((prev) =>
        prev && prev.key === key
          ? { ...prev, done: true, canceled, error: canceled ? undefined : err.message }
          : prev,
      );
      window.setTimeout(() => {
        setProgress((prev) => (prev && prev.key === key && prev.done ? null : prev));
      }, 5000);
    } finally {
      abortRef.current = null;
    }
  }

  async function handleDirectDownload(srcUrl: string, filename: string, key: string) {
    if (progress && !progress.done && !progress.error && !progress.canceled) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ key, filename, loaded: 0, total: 0, speed: 0, done: false });

    try {
      await streamingDownload(
        downloadProxyUrl(srcUrl, filename),
        filename,
        ctrl.signal,
        (loaded, total, speed) => {
          setProgress((prev) =>
            prev && prev.key === key ? { ...prev, loaded, total, speed } : prev,
          );
        },
      );
      setProgress((prev) => (prev && prev.key === key ? { ...prev, done: true } : prev));
      window.setTimeout(() => {
        setProgress((prev) => (prev && prev.key === key && prev.done ? null : prev));
      }, 4000);
    } catch (e) {
      const err = e as Error;
      const canceled = err.name === 'AbortError';
      setProgress((prev) =>
        prev && prev.key === key
          ? { ...prev, done: true, canceled, error: canceled ? undefined : err.message }
          : prev,
      );
      window.setTimeout(() => {
        setProgress((prev) => (prev && prev.key === key && prev.done ? null : prev));
      }, 5000);
    } finally {
      abortRef.current = null;
    }
  }

  function cancelDownload() {
    abortRef.current?.abort();
  }

  const isDownloading = !!progress && !progress.done;
  const pctText = (() => {
    if (!progress) return '';
    if (progress.total > 0) {
      return `${Math.min(100, Math.floor((progress.loaded / progress.total) * 100))}%`;
    }
    return formatBytes(progress.loaded);
  })();
  const pctNum =
    progress && progress.total > 0
      ? Math.min(100, (progress.loaded / progress.total) * 100)
      : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        {data.author.avatar && (
          <img src={data.author.avatar} alt="" className="w-10 h-10 rounded-full bg-neutral-800" />
        )}
        <div>
          <div className="font-semibold">{data.author.nickname || '未知作者'}</div>
          <div className="text-xs text-neutral-400 line-clamp-2">{data.desc}</div>
        </div>
      </div>

      {data.kind === 'video' && data.video && (
        <div className="space-y-3">
          {data.cover && (
            <img
              src={inlineProxyUrl(data.cover)}
              alt="cover"
              className="rounded-xl w-full"
              referrerPolicy="no-referrer"
            />
          )}
          <video
            ref={videoRef}
            src={inlineProxyUrl(data.video.playUrlNoWatermark)}
            poster={data.cover ? inlineProxyUrl(data.cover) : undefined}
            controls
            playsInline
            preload="metadata"
            className="rounded-xl w-full bg-black"
          />
          <DownloadDuo
            label="视频文件"
            filename={`${baseName}.mp4`}
            jobKey="video"
            target={{
              kind: 'video',
              srcUrl: data.video.playUrlNoWatermark,
              filename: `${baseName}.mp4`,
            }}
            mirrorEnabled={mirrorEnabled}
            ttlMinutes={ttlMinutes}
            job={mirrorJobs[mirrorKey('video')] || { status: 'idle' }}
            onMirror={(t) => runMirrorJob(mirrorKey('video'), t)}
            onDirect={() =>
              handleDirectDownload(data.video!.playUrlNoWatermark, `${baseName}.mp4`, 'video')
            }
            onMirrorDownload={handleMirroredDownload}
            directDisabled={isDownloading && progress?.key === 'video'}
            directLabel={isDownloading && progress?.key === 'video' ? `下载中 ${pctText}` : undefined}
            sizeBytes={sizes['video']}
            mirrorDownloadProgressText={
              isDownloading && progress?.key === 'video' && mirrorJobs[mirrorKey('video')]?.status === 'ready'
                ? pctText
                : undefined
            }
            primary
          />
          {ios && (
            <p className="text-xs text-neutral-400 leading-relaxed">
              💡 iPhone 用户：下载完成后会弹出系统对话框，请选择「存储到文件」。如果不小心进入了 mp4 预览页面，
              <strong className="text-neutral-200">从屏幕左边缘向右滑动</strong> 即可返回。
              另一个办法：长按上方视频 → 选择「存储视频」直接保存到相册。
            </p>
          )}
        </div>
      )}

      {data.kind === 'image' && data.images && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {data.images.map((img, i) => (
              <img
                key={img.url}
                src={inlineProxyUrl(img.url)}
                alt={`img-${i}`}
                className="rounded-lg w-full"
                referrerPolicy="no-referrer"
              />
            ))}
          </div>
          <div className="space-y-2">
            {data.images.map((img, i) => {
              const k = `img-${i}`;
              const filename = `${baseName}-${i + 1}.jpg`;
              return (
                <DownloadDuo
                  key={img.url}
                  label={`第 ${i + 1} 张图片`}
                  filename={filename}
                  jobKey={k}
                  target={{ kind: 'image', index: i, srcUrl: img.url, filename }}
                  mirrorEnabled={mirrorEnabled}
                  ttlMinutes={ttlMinutes}
                  job={mirrorJobs[mirrorKey('image', i)] || { status: 'idle' }}
                  onMirror={(t) => runMirrorJob(mirrorKey('image', i), t)}
                  onDirect={() => handleDirectDownload(img.url, filename, k)}
                  onMirrorDownload={handleMirroredDownload}
                  directDisabled={isDownloading && progress?.key === k}
                  directLabel={isDownloading && progress?.key === k ? `下载中 ${pctText}` : undefined}
                  sizeBytes={sizes[`img-${i}`]}
                  mirrorDownloadProgressText={
                    isDownloading && progress?.key === k && mirrorJobs[mirrorKey('image', i)]?.status === 'ready'
                      ? pctText
                      : undefined
                  }
                />
              );
            })}
          </div>
          {ios && (
            <p className="text-xs text-neutral-400 text-center">
              iPhone 也可长按图片直接「存储到照片」
            </p>
          )}
        </div>
      )}

      {data.music?.playUrl && (
        <div className="border border-neutral-800 rounded-xl p-4 space-y-3">
          <div className="text-sm">
            🎵 <span className="font-medium">{data.music.title || '原声'}</span>
            {data.music.author ? <span className="text-neutral-400"> · {data.music.author}</span> : null}
          </div>
          <audio src={inlineProxyUrl(data.music.playUrl)} controls preload="none" className="w-full" />
          <DownloadDuo
            label="原声音频 (MP3)"
            filename={`${baseName}.mp3`}
            jobKey="music"
            target={{ kind: 'music', srcUrl: data.music.playUrl, filename: `${baseName}.mp3` }}
            mirrorEnabled={mirrorEnabled}
            ttlMinutes={ttlMinutes}
            job={mirrorJobs[mirrorKey('music')] || { status: 'idle' }}
            onMirror={(t) => runMirrorJob(mirrorKey('music'), t)}
            onDirect={() => handleDirectDownload(data.music!.playUrl!, `${baseName}.mp3`, 'music')}
            onMirrorDownload={handleMirroredDownload}
            directDisabled={isDownloading && progress?.key === 'music'}
            directLabel={isDownloading && progress?.key === 'music' ? `下载中 ${pctText}` : undefined}
            sizeBytes={sizes['music']}
            mirrorDownloadProgressText={
              isDownloading && progress?.key === 'music' && mirrorJobs[mirrorKey('music')]?.status === 'ready'
                ? pctText
                : undefined
            }
          />
        </div>
      )}

      {progress && (
        <div
          role="status"
          aria-live="polite"
          className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 w-[min(92vw,360px)] px-4 py-3 rounded-2xl bg-neutral-900/95 border border-neutral-700 text-sm text-neutral-100 shadow-lg shadow-black/50"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-neutral-400">{progress.filename}</div>
              <div className="font-medium">
                {progress.error
                  ? `下载失败：${progress.error}`
                  : progress.canceled
                    ? '已取消下载'
                    : progress.done
                      ? ios
                        ? '已弹出系统保存框，请选择「存储到文件」'
                        : '下载完成 ✓'
                      : `正在下载 ${pctText}${progress.speed > 0 ? ` · ${formatSpeed(progress.speed)}` : ''}`}
              </div>
            </div>
            {!progress.done && (
              <button
                type="button"
                onClick={cancelDownload}
                className="shrink-0 px-3 py-1 rounded-full border border-neutral-600 text-xs hover:border-neutral-400"
              >
                取消
              </button>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden">
            <div
              className={`h-full transition-[width] duration-150 ${progress.error ? 'bg-red-500' : progress.canceled ? 'bg-neutral-500' : progress.done ? 'bg-emerald-500' : 'bg-brand-500'}`}
              style={{
                width: progress.done ? '100%' : pctNum !== null ? `${pctNum}%` : '40%',
              }}
            />
          </div>
          {!progress.done && progress.total > 0 && (
            <div className="mt-1 text-[11px] text-neutral-500">
              {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
            </div>
          )}
          {!progress.done && progress.total === 0 && progress.loaded > 0 && (
            <div className="mt-1 text-[11px] text-neutral-500">
              已接收 {formatBytes(progress.loaded)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface DownloadDuoProps {
  label: string;
  filename: string;
  /** Stable key matching the one used by `progress?.key` so we can show the
   * mirror download progress *on the mirror button itself* while the file
   * is streaming from Qiniu CDN. */
  jobKey: string;
  target: MirrorTarget;
  mirrorEnabled: boolean;
  ttlMinutes: number;
  job: MirrorJobState;
  onMirror: (t: MirrorTarget) => void;
  onDirect: () => void;
  onMirrorDownload: (url: string, filename: string, key: string) => void;
  directDisabled?: boolean;
  /** Optional override label for the direct button (e.g. "下载中 42%"). */
  directLabel?: string;
  /** Pre-fetched byte size (from /api/probe). When >0 we append a "12.4 MB"
   * hint to the direct-download button so the user knows what they're about
   * to pull down. Undefined = still probing or CDN doesn't expose size. */
  sizeBytes?: number;
  /** When set, the mirror button is currently the one streaming from Qiniu;
   * we show the live percentage on it so user gets a real progress %. */
  mirrorDownloadProgressText?: string;
  /** When true the direct button uses the prominent brand color (used by the
   * main video card so the layout matches the original design). */
  primary?: boolean;
}

/**
 * Two-button row rendered next to every downloadable media object.
 *
 *   [ 直接下载 ]  [ ☁️ OSS 中转下载 ]
 *
 * The right-hand button is a state machine:
 *   idle      → click → uploading
 *   uploading → shows "上传中… X.Xs" + indeterminate bar (Qiniu /fetch is
 *               atomic and gives no real progress, so we just show elapsed
 *               time + an animated bar)
 *   ready     → button turns green: "下载（30 分钟内有效）" + 30-min disclaimer
 *   error     → red message with retry
 */
function DownloadDuo(props: DownloadDuoProps) {
  const {
    label,
    filename,
    jobKey,
    target,
    mirrorEnabled,
    ttlMinutes,
    job,
    onMirror,
    onDirect,
    onMirrorDownload,
    directDisabled,
    directLabel,
    sizeBytes,
    mirrorDownloadProgressText,
    primary,
  } = props;

  const directBase = primary
    ? 'bg-brand-500 hover:bg-brand-600 text-white'
    : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100';

  // Show seconds elapsed during upload. Re-renders are driven by the parent's
  // 250ms tick interval (only active while at least one job is uploading).
  const elapsedSec =
    job.status === 'uploading' ? Math.max(0, (Date.now() - job.startedAt) / 1000) : 0;

  // While Qiniu→browser streaming is active, the mirror button shows live %
  // (driven by the parent <Progress>) — overriding the green "下载（30 分钟内有效）"
  // label so user sees a real progress %.
  const mirrorIsStreaming = !!mirrorDownloadProgressText && job.status === 'ready';

  // Only append the size hint when we're not already showing a download
  // percentage (otherwise "下载中 42% · 12.4 MB" gets noisy).
  const sizeHint =
    sizeBytes && sizeBytes > 0 && !directLabel ? ` · ${formatBytes(sizeBytes)}` : '';
  const directButtonLabel = directLabel || `直接下载 · ${label}${sizeHint}`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onDirect}
          disabled={directDisabled}
          className={`rounded-full py-2.5 px-3 text-sm font-semibold disabled:opacity-60 ${directBase}`}
        >
          {directButtonLabel}
        </button>
        {mirrorEnabled ? (
          <button
            type="button"
            onClick={() => {
              if (mirrorIsStreaming) return;
              if (job.status === 'ready') {
                onMirrorDownload(job.url, filename, jobKey);
              } else if (job.status !== 'uploading') {
                onMirror(target);
              }
            }}
            disabled={job.status === 'uploading' || mirrorIsStreaming}
            className={`rounded-full py-2.5 px-3 text-sm font-semibold disabled:opacity-80 ${
              job.status === 'ready'
                ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                : job.status === 'error'
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700'
            }`}
          >
            {job.status === 'idle' && <>☁️ OSS 中转下载</>}
            {job.status === 'uploading' && <>① 上传中… {elapsedSec.toFixed(1)}s</>}
            {job.status === 'ready' && !mirrorIsStreaming && (
              <>⬇️ 下载（{ttlMinutes} 分钟内有效）</>
            )}
            {job.status === 'ready' && mirrorIsStreaming && (
              <>② 下载中 {mirrorDownloadProgressText}</>
            )}
            {job.status === 'error' && <>重试中转下载</>}
          </button>
        ) : (
          <div className="rounded-full py-2.5 px-3 text-xs text-neutral-500 bg-neutral-900 border border-neutral-800 text-center self-center">
            未配置 OSS 中转
          </div>
        )}
      </div>
      {job.status === 'uploading' && (
        <div className="space-y-1">
          <div className="h-1 w-full rounded-full bg-neutral-800 overflow-hidden">
            <div className="h-full w-1/3 bg-brand-500 animate-[indeterminate_1.2s_ease_infinite]" />
          </div>
          <div className="text-[11px] text-neutral-500">
            ① OSS 正从抖音 CDN 拉取并存到云端… 通常 1~5 秒（这一步没有上传比例，因为是云端到云端）
          </div>
        </div>
      )}
      {job.status === 'ready' && !mirrorIsStreaming && (
        <div className="text-[11px] text-neutral-500 leading-relaxed">
          ✓ 已上传到 OSS · 耗时 {job.elapsedMs} ms · 已自动开始下载到本机 ·{' '}
          <span className="text-amber-400">{ttlMinutes} 分钟后自动删除</span>
        </div>
      )}
      {job.status === 'error' && (
        <div className="text-[11px] text-red-400">中转失败：{job.message}</div>
      )}
    </div>
  );
}
