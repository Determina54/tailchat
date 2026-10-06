import { act, renderHook, waitFor } from '@testing-library/react';
import { useMusicAudio } from '../src/group/useMusicAudio';
import { request } from '../src/request';

jest.mock('../src/request', () => ({
  request: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockGet = request.get as jest.Mock;

type Listener = () => void;

class FakeAudio {
  static instances: FakeAudio[] = [];

  listeners = new Map<string, Set<Listener>>();
  dataset: Record<string, string> = {};
  currentTime = 0;
  duration = 180;
  volume = 1;
  src = '';
  preload = '';
  paused = true;

  play = jest.fn(async () => {
    this.paused = false;
  });

  pause = jest.fn(() => {
    this.paused = true;
  });

  load = jest.fn();

  removeAttribute = jest.fn((name: string) => {
    if (name === 'src') {
      this.src = '';
    }
  });

  addEventListener = (type: string, callback: Listener) => {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
  };

  removeEventListener = (type: string, callback: Listener) => {
    this.listeners.get(type)?.delete(callback);
  };

  emit(type: string): void {
    this.listeners.get(type)?.forEach((callback) => callback());
  }

  listenerCount(): number {
    let total = 0;
    this.listeners.forEach((set) => {
      total += set.size;
    });
    return total;
  }

  constructor() {
    FakeAudio.instances.push(this);
  }
}

const track = { id: 't1', name: 'T1', source: 'netease' };

function lastInstance(): FakeAudio {
  return FakeAudio.instances[FakeAudio.instances.length - 1];
}

describe('useMusicAudio', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    FakeAudio.instances = [];
    (global as unknown as { Audio: unknown }).Audio = FakeAudio;
    mockGet.mockResolvedValue({ data: { url: 'https://audio/t1.mp3' } });
  });

  test('获取播放地址后会设置 src 并按服务端时间定位', async () => {
    renderHook(() =>
      useMusicAudio({
        track,
        isPlaying: true,
        serverTime: 12,
        volume: 80,
        onEnded: jest.fn(),
      })
    );

    await waitFor(() => expect(lastInstance().src).toBe('https://audio/t1.mp3'));
    expect(lastInstance().currentTime).toBe(12);
  });

  test('切歌时会丢弃过期响应', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    mockGet
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ data: { url: 'https://audio/t2.mp3' } });

    const { rerender } = renderHook(
      ({ id }: { id: string }) =>
        useMusicAudio({
          track: { id, name: id, source: 'netease' },
          isPlaying: false,
          serverTime: 0,
          volume: 80,
          onEnded: jest.fn(),
        }),
      { initialProps: { id: 't1' } }
    );

    rerender({ id: 't2' });

    await waitFor(() => expect(lastInstance().src).toBe('https://audio/t2.mp3'));

    await act(async () => {
      resolveFirst({ data: { url: 'https://audio/t1.mp3' } });
      await Promise.resolve();
    });

    expect(lastInstance().src).toBe('https://audio/t2.mp3');
  });

  test('获取 url 失败时给出错误提示', async () => {
    mockGet.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useMusicAudio({
        track,
        isPlaying: false,
        serverTime: 0,
        volume: 80,
        onEnded: jest.fn(),
      })
    );

    await waitFor(() => expect(result.current.error).toBeTruthy());
  });

  test('卸载时暂停、清空 src 并移除监听器', async () => {
    const { unmount } = renderHook(() =>
      useMusicAudio({
        track,
        isPlaying: false,
        serverTime: 0,
        volume: 80,
        onEnded: jest.fn(),
      })
    );

    await waitFor(() => expect(lastInstance().src).toBeTruthy());
    const instance = lastInstance();
    expect(instance.listenerCount()).toBeGreaterThan(0);

    unmount();

    expect(instance.pause).toHaveBeenCalled();
    expect(instance.removeAttribute).toHaveBeenCalledWith('src');
    expect(instance.load).toHaveBeenCalled();
    expect(instance.listenerCount()).toBe(0);
  });

  test('漂移超过阈值时才校准播放时间', async () => {
    const { rerender } = renderHook(
      ({ serverTime }: { serverTime: number }) =>
        useMusicAudio({
          track,
          isPlaying: true,
          serverTime,
          volume: 80,
          onEnded: jest.fn(),
        }),
      { initialProps: { serverTime: 0 } }
    );

    await waitFor(() => expect(lastInstance().src).toBeTruthy());
    const instance = lastInstance();

    // 阈值内不校准
    instance.currentTime = 1;
    rerender({ serverTime: 2 });
    expect(instance.currentTime).toBe(1);

    // 超过阈值才校准
    rerender({ serverTime: 10 });
    expect(instance.currentTime).toBe(10);
  });

  test('音量会同步到 audio 元素', async () => {
    const { rerender } = renderHook(
      ({ volume }: { volume: number }) =>
        useMusicAudio({
          track,
          isPlaying: false,
          serverTime: 0,
          volume,
          onEnded: jest.fn(),
        }),
      { initialProps: { volume: 30 } }
    );

    await waitFor(() => expect(lastInstance().volume).toBeCloseTo(0.3, 5));

    rerender({ volume: 150 });
    expect(lastInstance().volume).toBe(1);
  });

  test('audio ended 事件会调用 onEnded', async () => {
    const onEnded = jest.fn();

    renderHook(() =>
      useMusicAudio({
        track,
        isPlaying: true,
        serverTime: 0,
        volume: 80,
        onEnded,
      })
    );

    await waitFor(() => expect(lastInstance().src).toBeTruthy());

    act(() => {
      lastInstance().emit('ended');
    });

    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
