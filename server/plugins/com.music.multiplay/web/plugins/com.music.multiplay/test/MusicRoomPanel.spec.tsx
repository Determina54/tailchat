import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MusicRoomPanel from '../src/group/MusicRoomPanel';
import { request } from '../src/request';
import { useMusicAudio } from '../src/group/useMusicAudio';
import type { MusicRoomState, MusicSearchResult } from '../src/types';

jest.mock('../src/request', () => ({
  request: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

jest.mock('../src/group/useMusicAudio', () => ({
  useMusicAudio: jest.fn(() => ({
    duration: 200,
    localTime: 0,
    error: undefined,
    seekLocal: jest.fn(),
    reload: jest.fn(),
  })),
}));

const mockGet = request.get as jest.Mock;
const mockPost = request.post as jest.Mock;
const mockUseMusicAudio = useMusicAudio as unknown as jest.Mock;

function buildState(overrides: Partial<MusicRoomState> = {}): MusicRoomState {
  return {
    groupId: 'g1',
    revision: 1,
    queue: [],
    history: [],
    currentTime: 0,
    isPlaying: false,
    volume: 80,
    ownerId: 'u1',
    members: [],
    ...overrides,
  };
}

function makeTracks(count: number, offset = 0): MusicSearchResult[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${offset + index}`,
    name: `song-${offset + index}`,
    artist: 'artist',
    source: 'netease',
  }));
}

function lastAudioOptions(): Record<string, any> {
  const calls = mockUseMusicAudio.mock.calls;
  return calls[calls.length - 1][0];
}

async function renderPanel(roomState: MusicRoomState): Promise<{
  container: HTMLElement;
}> {
  mockPost.mockImplementation((action: string) =>
    Promise.resolve({ data: action === 'join' ? roomState : buildState() })
  );

  const utils = render(<MusicRoomPanel />);

  await waitFor(() => expect(mockPost).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });

  return { container: utils.container };
}

function countResults(container: HTMLElement): number {
  return container.querySelectorAll('.multiplay-result').length;
}

function setScrollable(element: Element): void {
  Object.defineProperty(element, 'scrollHeight', {
    value: 400,
    configurable: true,
  });
  Object.defineProperty(element, 'clientHeight', {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(element, 'scrollTop', {
    value: 300,
    configurable: true,
    writable: true,
  });
}

describe('MusicRoomPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation((action: string) => {
      if (action === 'search') {
        return Promise.resolve({ data: [] });
      }
      if (action === 'lyric') {
        return Promise.resolve({ data: {} });
      }

      return Promise.resolve({ data: buildState() });
    });
  });

  test('owner 可以看到删除与清空按钮', async () => {
    const { container } = await renderPanel(
      buildState({
        ownerId: 'u1',
        queue: [{ id: 't1', name: 'T1' }],
      })
    );

    expect(container.querySelectorAll('.multiplay-queue-item')).toHaveLength(1);
    expect(screen.getByText('x')).toBeTruthy();
    expect(screen.getByText('清空队列')).toBeTruthy();
  });

  test('非 owner 看不到删除与清空按钮', async () => {
    const { container } = await renderPanel(
      buildState({
        ownerId: 'u2',
        queue: [{ id: 't1', name: 'T1' }],
      })
    );

    expect(container.querySelectorAll('.multiplay-queue-item')).toHaveLength(1);
    expect(screen.queryByText('x')).toBeNull();
    expect(screen.queryByText('清空队列')).toBeNull();
  });

  test('搜索首屏会替换结果而不是追加', async () => {
    mockGet.mockImplementation((action: string, config: any) => {
      if (action === 'search') {
        const pages = config?.params?.pages ?? 1;
        return Promise.resolve({
          data: pages === 1 ? makeTracks(20) : makeTracks(20, 20),
        });
      }

      return Promise.resolve({ data: buildState() });
    });

    const { container } = await renderPanel(buildState());
    const input = screen.getByPlaceholderText('搜索歌曲、歌手或专辑');
    const button = screen.getByText('搜索');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(button);

    await waitFor(() => expect(countResults(container)).toBe(20));

    fireEvent.change(input, { target: { value: 'world' } });
    fireEvent.click(button);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(countResults(container)).toBe(20);
  });

  test('滚动到底部会分页追加结果', async () => {
    mockGet.mockImplementation((action: string, config: any) => {
      if (action === 'search') {
        const pages = config?.params?.pages ?? 1;
        return Promise.resolve({
          data: pages === 1 ? makeTracks(20) : makeTracks(20, 20),
        });
      }

      return Promise.resolve({ data: buildState() });
    });

    const { container } = await renderPanel(buildState());
    const input = screen.getByPlaceholderText('搜索歌曲、歌手或专辑');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('搜索'));

    await waitFor(() => expect(countResults(container)).toBe(20));

    const list = container.querySelector('.multiplay-results') as HTMLElement;
    setScrollable(list);
    fireEvent.scroll(list);

    await waitFor(() => expect(countResults(container)).toBe(40), {
      timeout: 2000,
    });
  });

  test('300ms 内多次滚动只触发一次加载', async () => {
    mockGet.mockImplementation((action: string, config: any) => {
      if (action === 'search') {
        const pages = config?.params?.pages ?? 1;
        return Promise.resolve({
          data: pages === 1 ? makeTracks(20) : makeTracks(20, 20),
        });
      }

      return Promise.resolve({ data: buildState() });
    });

    const { container } = await renderPanel(buildState());

    fireEvent.change(screen.getByPlaceholderText('搜索歌曲、歌手或专辑'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByText('搜索'));

    await waitFor(() => expect(countResults(container)).toBe(20));

    const list = container.querySelector('.multiplay-results') as HTMLElement;
    setScrollable(list);

    fireEvent.scroll(list);
    fireEvent.scroll(list);
    fireEvent.scroll(list);
    fireEvent.scroll(list);

    await waitFor(
      () =>
        expect(
          mockGet.mock.calls.filter(([action]) => action === 'search')
        ).toHaveLength(2),
      { timeout: 2000 }
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(
      mockGet.mock.calls.filter(([action]) => action === 'search')
    ).toHaveLength(2);
  });

  test('audio ended 会发送 next', async () => {
    mockGet.mockImplementation(() => Promise.resolve({ data: buildState() }));

    await renderPanel(
      buildState({
        currentTrackId: 't1',
        currentTrack: { id: 't1', name: 'T1', source: 'netease' },
        isPlaying: true,
      })
    );

    const options = lastAudioOptions();
    expect(typeof options.onEnded).toBe('function');

    act(() => {
      options.onEnded();
    });

    await waitFor(() =>
      expect(
        mockPost.mock.calls.some(([action]) => action === 'next')
      ).toBe(true)
    );
  });

  test('切歌会请求歌词', async () => {
    mockGet.mockImplementation((action: string) => {
      if (action === 'lyric') {
        return Promise.resolve({
          data: { lyric: '[00:01.00]hi', tlyric: '[00:01.00]嗨' },
        });
      }

      return Promise.resolve({ data: buildState() });
    });

    const { container } = await renderPanel(
      buildState({
        currentTrackId: 't1',
        currentTrack: { id: 't1', name: 'T1', source: 'netease' },
      })
    );

    await waitFor(() =>
      expect(
        mockGet.mock.calls.some(([action]) => action === 'lyric')
      ).toBe(true)
    );
    await waitFor(() =>
      expect(container.querySelectorAll('.multiplay-lyrics > div').length).toBeGreaterThan(1)
    );
  });
});
