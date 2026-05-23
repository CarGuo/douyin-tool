import { useEffect, useState, type ReactNode } from 'react';
import { hasValidUnlockToken, forgetUnlock } from '../lib/pinSecurity';
import PinKeypad from './PinKeypad';

interface PinGateProps {
  children: ReactNode;
}

/**
 * Top-level access gate. Renders children only when the user has either:
 *   - an existing valid unlock token (returning visitor), OR
 *   - just entered the correct PIN.
 *
 * Children are NEVER rendered before unlock — this prevents the protected
 * UI (and its API calls) from running for a visitor who hasn't passed.
 */
export default function PinGate({ children }: PinGateProps) {
  const [unlocked, setUnlocked] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    setUnlocked(hasValidUnlockToken());
    setHydrated(true);
  }, []);

  // Optional escape hatch: shift+click the locked-screen logo 5 times to
  // forcibly clear stored state (useful when forgetting the PIN on a shared
  // device). It does NOT bypass the PIN — you still have to type it next.
  // We expose this via a hidden interaction in PinKeypad (logo image), but
  // implementing it as a window-level listener here keeps PinKeypad pure.
  useEffect(() => {
    if (unlocked) return;
    let count = 0;
    let timer: number | null = null;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest || !target.closest('[aria-label="pin-progress"]')) return;
      if (!e.shiftKey) return;
      count += 1;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => (count = 0), 1500);
      if (count >= 5) {
        forgetUnlock();
        count = 0;
      }
    }
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('click', onClick);
      if (timer) window.clearTimeout(timer);
    };
  }, [unlocked]);

  if (!hydrated) {
    return (
      <main className="min-h-full flex items-center justify-center text-neutral-500 text-sm">
        加载中…
      </main>
    );
  }

  if (!unlocked) {
    return (
      <main className="min-h-full flex items-center justify-center px-4 py-10">
        <PinKeypad onUnlock={() => setUnlocked(true)} />
      </main>
    );
  }

  return <>{children}</>;
}
