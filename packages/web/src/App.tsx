import { useRef, useState } from 'react';
import Result from './Result';
import { parseLink, type MirrorEcho, type ParsedAweme } from './api';

export default function App() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ParsedAweme | null>(null);
  const [mirror, setMirror] = useState<MirrorEcho | null>(null);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function onSubmit() {
    if (loading || !text.trim()) return;
    setLoading(true);
    setError(null);
    setData(null);
    setMirror(null);
    try {
      const res = await parseLink(text);
      if (res.ok) {
        setData(res.data);
        setMirror(res.mirror ?? null);
      } else {
        setError(res.message || res.code);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function pasteAndParse() {
    setPasteHint(null);
    setError(null);

    const canRead =
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.readText === 'function';

    if (canRead) {
      try {
        const t = await navigator.clipboard.readText();
        if (t && t.trim()) {
          setText(t);
          setPasteHint('已粘贴 ✓');
          window.setTimeout(() => setPasteHint(null), 1500);
          return;
        }
        setPasteHint('剪贴板为空，请先复制抖音分享链接');
        return;
      } catch {
        // permission denied / unsupported, fall through
      }
    }

    setPasteHint('请长按下方输入框，选择「粘贴」');
    textareaRef.current?.focus();
  }

  return (
    <main className="min-h-full max-w-md mx-auto px-4 pt-10 pb-16">
      <header className="mb-8 text-center">
        <img
          src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
          alt="抖音解析下载"
          width={88}
          height={88}
          className="mx-auto mb-3 rounded-2xl shadow-lg shadow-brand-500/20"
          decoding="async"
        />
        <h1 className="text-2xl font-bold tracking-wide">
          抖音<span className="text-brand-500">解析</span>
        </h1>
        <p className="text-sm text-neutral-400 mt-1">视频 · 图集 · 原声</p>
      </header>

      <section aria-label="parse-form" className="space-y-3">
        <textarea
          ref={textareaRef}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴抖音分享文本或链接，例如：\n7.99 复制打开抖音... https://v.douyin.com/xxxxx/"
          className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-sm focus:outline-none focus:border-brand-500"
        />
        <div className="flex gap-2">
          <button
            onClick={pasteAndParse}
            type="button"
            className="px-4 py-2 rounded-full border border-neutral-700 text-sm hover:border-neutral-500"
          >
            粘贴
          </button>
          <button
            onClick={onSubmit}
            type="button"
            disabled={loading || !text.trim()}
            className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white rounded-full py-2 font-semibold"
          >
            {loading ? '解析中…' : '解析'}
          </button>
        </div>
        {pasteHint && (
          <div className="text-xs text-neutral-400 bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2">
            {pasteHint}
          </div>
        )}
        {error && (
          <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </section>

      <section aria-label="result" className="mt-8">
        {data && <Result data={data} mirror={mirror} />}
      </section>

      <footer className="mt-10 text-center text-xs text-neutral-500 leading-relaxed">
        <p>仅供个人学习与作品备份，请勿用于商业或批量爬取。</p>
        <p className="mt-1">
          在 iPhone Safari 选择「分享 → 添加到主屏幕」，或 Android Chrome 选择「安装应用」即可获得桌面图标。
        </p>
        <p className="mt-1 text-neutral-600">登录有效期 30 天，期间无需再次输入密码。</p>
      </footer>
    </main>
  );
}
