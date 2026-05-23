import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PinGate from '../src/components/PinGate';
import { persistUnlock } from '../src/lib/pinSecurity';

interface MockOpts {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
function makeFetchMock(byUrl: Record<string, MockOpts | ((req: RequestInit) => MockOpts)>) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const entry = byUrl[url];
    const opts = typeof entry === 'function' ? entry(init) : entry ?? { status: 404 };
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(opts.headers ?? {}),
      json: async () => opts.body ?? {},
    } as unknown as Response;
  });
}

function clickDigit(d: string) {
  fireEvent.click(screen.getByRole('button', { name: `digit ${d}` }));
}

async function typePin(pin: string) {
  for (const c of pin) clickDigit(c);
}

describe('PinGate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render protected children before unlock', () => {
    vi.stubGlobal('fetch', makeFetchMock({}));
    render(
      <PinGate>
        <div data-testid="secret">my secret content</div>
      </PinGate>,
    );
    expect(screen.queryByTestId('secret')).toBeNull();
    expect(screen.getByText(/输入访问密码/)).toBeInTheDocument();
  });

  it('renders children when local exp hint is still valid', async () => {
    persistUnlock(Date.now() + 60_000);
    vi.stubGlobal('fetch', makeFetchMock({}));
    render(
      <PinGate>
        <div data-testid="secret">my secret content</div>
      </PinGate>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('secret')).toBeInTheDocument();
    });
  });

  it('rejects wrong pin (server says 401) and keeps gate up', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        '/api/auth/login': { status: 401, body: { ok: false, message: '密码不正确' } },
      }),
    );
    render(
      <PinGate>
        <div data-testid="secret">my secret content</div>
      </PinGate>,
    );
    await typePin('11111111');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('密码不正确');
    });
    expect(screen.queryByTestId('secret')).toBeNull();
  });

  it('accepts correct pin (server says 200) and reveals children', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        '/api/auth/login': { status: 200, body: { ok: true, exp: Date.now() + 3600_000 } },
      }),
    );
    render(
      <PinGate>
        <div data-testid="secret">my secret content</div>
      </PinGate>,
    );
    await typePin('20264368');
    await waitFor(() => {
      expect(screen.getByTestId('secret')).toBeInTheDocument();
    });
  });

  it('disables the keypad after enough failures (lockout)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        '/api/auth/login': { status: 401, body: { ok: false, message: '密码不正确' } },
      }),
    );
    render(
      <PinGate>
        <div data-testid="secret">my secret content</div>
      </PinGate>,
    );
    await typePin('11111111');
    await waitFor(() => screen.getByRole('alert'));
    await typePin('22222222');
    await waitFor(() => screen.getByRole('alert'));
    await typePin('33333333');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/失败过多/);
    });
    const keypad = screen.getByLabelText('pin-keypad');
    const buttons = within(keypad).getAllByRole('button');
    for (const b of buttons) expect(b).toBeDisabled();
  });

  it('shows rate-limit message on 429', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        '/api/auth/login': {
          status: 429,
          body: { ok: false },
          headers: { 'retry-after': '20' },
        },
      }),
    );
    render(
      <PinGate>
        <div data-testid="secret">my secret content</div>
      </PinGate>,
    );
    await typePin('11111111');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/失败过多|频繁/);
    });
  });
});
