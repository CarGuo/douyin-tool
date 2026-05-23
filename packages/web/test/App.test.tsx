import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../src/App';

const sampleVideo = {
  ok: true,
  data: {
    kind: 'video',
    awemeId: '7300000000000000001',
    desc: '测试视频',
    author: { nickname: 'Tester' },
    cover: 'https://p3.douyinpic.com/cover/test.jpg',
    video: {
      playUrl: 'https://x/play/v.mp4',
      playUrlNoWatermark: 'https://x/play/v.mp4',
      duration: 15000,
    },
    music: { title: 'Sound', author: 'A', playUrl: 'https://x/m.mp3' },
  },
};

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders headline and disabled button initially', () => {
    render(<App />);
    expect(screen.getByText(/抖音/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /解析/ })).toBeDisabled();
  });

  it('parses input and shows video result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => sampleVideo,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/粘贴抖音分享/), {
      target: { value: 'https://v.douyin.com/iABCDEF/' },
    });
    fireEvent.click(screen.getByRole('button', { name: /解析/ }));

    await waitFor(() => {
      expect(screen.getByText(/直接下载.*无水印视频/)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/parse',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows error message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ ok: false, code: 'INVALID_LINK', message: '链接无效' }),
      } as Response),
    );
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/粘贴抖音分享/), {
      target: { value: 'not a link' },
    });
    fireEvent.click(screen.getByRole('button', { name: /解析/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('链接无效'));
  });
});
