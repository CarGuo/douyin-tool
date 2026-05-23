import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PIN_LENGTH,
  verifyPin,
  persistUnlock,
  recordFailure,
  lockoutRemainingMs,
} from '../lib/pinSecurity';

interface PinKeypadProps {
  onUnlock: () => void;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const BASE_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export default function PinKeypad({ onUnlock }: PinKeypadProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [lockMs, setLockMs] = useState<number>(() => lockoutRemainingMs());
  const tickRef = useRef<number | null>(null);

  // Re-shuffle digit positions whenever the keypad is freshly shown / after a clear
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const layout = useMemo(() => {
    void shuffleSeed;
    const digits = shuffle(BASE_DIGITS.slice(0, 9));
    return [...digits, '0'];
  }, [shuffleSeed]);

  // Tick the lockout countdown
  useEffect(() => {
    if (lockMs <= 0) return;
    tickRef.current = window.setInterval(() => {
      const r = lockoutRemainingMs();
      setLockMs(r);
      if (r <= 0 && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }, 250);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [lockMs > 0]);

  const locked = lockMs > 0;
  const lockSec = Math.ceil(lockMs / 1000);

  function clearPin() {
    setPin('');
    setError(null);
    setShuffleSeed((s) => s + 1);
  }

  async function tryUnlock(candidate: string) {
    setBusy(true);
    try {
      const res = await verifyPin(candidate);
      if (res.ok) {
        persistUnlock(res.exp);
        onUnlock();
        return;
      }
      if (res.status === 429) {
        setError(res.message ?? '请求过于频繁，请稍后再试');
        const wait = res.retryAfterMs ?? 30_000;
        setLockMs(wait);
        setShake(true);
        window.setTimeout(() => setShake(false), 400);
        setPin('');
        setShuffleSeed((s) => s + 1);
        return;
      }
      const next = recordFailure();
      setError(res.message ?? '密码不正确');
      setShake(true);
      window.setTimeout(() => setShake(false), 400);
      setPin('');
      setShuffleSeed((s) => s + 1);
      if (next.lockedUntil > Date.now()) {
        setLockMs(next.lockedUntil - Date.now());
      }
    } finally {
      setBusy(false);
    }
  }

  function pushDigit(d: string) {
    if (locked || busy) return;
    if (pin.length >= PIN_LENGTH) return;
    setError(null);
    const next = pin + d;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      void tryUnlock(next);
    }
  }

  function backspace() {
    if (locked || busy) return;
    setError(null);
    setPin((p) => p.slice(0, -1));
  }

  return (
    <div className="w-full max-w-xs mx-auto select-none">
      <div className="text-center mb-6">
        <img
          src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
          alt=""
          width={72}
          height={72}
          className="mx-auto mb-3 rounded-2xl shadow-lg shadow-brand-500/20"
          decoding="async"
        />
        <h2 className="text-lg font-semibold tracking-wide">输入访问密码</h2>
        <p className="text-xs text-neutral-500 mt-1">请输入 8 位数字密码继续</p>
      </div>

      <div
        role="status"
        aria-label="pin-progress"
        className={`flex justify-center gap-3 mb-6 ${shake ? 'animate-shake' : ''}`}
      >
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <span
            key={i}
            className={`w-3 h-3 rounded-full border ${
              i < pin.length ? 'bg-brand-500 border-brand-500' : 'border-neutral-600'
            }`}
          />
        ))}
      </div>

      {error && !locked && (
        <div role="alert" className="text-center text-sm text-red-400 mb-3">
          {error}
        </div>
      )}
      {locked && (
        <div role="alert" className="text-center text-sm text-amber-400 mb-3">
          失败过多，请等待 {lockSec} 秒后重试
        </div>
      )}

      <div className="grid grid-cols-3 gap-3" aria-label="pin-keypad">
        {layout.slice(0, 9).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => pushDigit(d)}
            disabled={locked || busy}
            className="aspect-square rounded-2xl text-2xl font-semibold bg-neutral-900 border border-neutral-800 hover:border-brand-500/60 active:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
            aria-label={`digit ${d}`}
          >
            {d}
          </button>
        ))}

        <button
          type="button"
          onClick={clearPin}
          disabled={locked || busy}
          className="aspect-square rounded-2xl text-sm bg-neutral-900 border border-neutral-800 hover:border-neutral-600 disabled:opacity-40"
          aria-label="clear"
        >
          清空
        </button>
        <button
          type="button"
          onClick={() => pushDigit(layout[9])}
          disabled={locked || busy}
          className="aspect-square rounded-2xl text-2xl font-semibold bg-neutral-900 border border-neutral-800 hover:border-brand-500/60 active:bg-neutral-800 disabled:opacity-40"
          aria-label={`digit ${layout[9]}`}
        >
          {layout[9]}
        </button>
        <button
          type="button"
          onClick={backspace}
          disabled={locked || busy}
          className="aspect-square rounded-2xl text-sm bg-neutral-900 border border-neutral-800 hover:border-neutral-600 disabled:opacity-40"
          aria-label="backspace"
        >
          ⌫
        </button>
      </div>

      <p className="text-[11px] text-neutral-600 text-center mt-6 leading-relaxed">
        密码由服务端校验，登录态使用 HttpOnly Cookie 存储。
      </p>
    </div>
  );
}
