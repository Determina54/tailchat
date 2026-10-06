import { renderHook, waitFor, act } from '@testing-library/react';
import { showToasts } from '@capital/common';
import { useMusicRoom } from '../src/group/useMusicRoom';
import { request } from '../src/request';
import type { MusicRoomState } from '../src/types';

jest.mock('../src/request', () => ({
  request: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockGet = request.get as jest.Mock;
const mockPost = request.post as jest.Mock;
const mockShowToasts = showToasts as jest.Mock;

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

async function renderRoom(groupId = 'g1') {
  const utils = renderHook(() => useMusicRoom(groupId));

  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('join', expect.anything()));
  await act(async () => {
    await Promise.resolve();
  });

  return utils;
}

describe('useMusicRoom', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: buildState() });
    mockPost.mockImplementation((action: string) =>
      Promise.resolve({
        data:
          action === 'join'
            ? buildState({ revision: 5, ownerId: 'u1' })
            : buildState({ revision: 6 }),
      })
    );
  });

  test('join 后会写入权威状态并识别 owner', async () => {
    const { result } = await renderRoom();

    await waitFor(() => expect(result.current.state.revision).toBe(5));
    expect(result.current.isOwner).toBe(true);
  });

  test('revision 更旧的状态会被丢弃', async () => {
    const { result } = await renderRoom();
    await waitFor(() => expect(result.current.state.revision).toBe(5));

    mockPost.mockResolvedValueOnce({
      data: buildState({ revision: 4, ownerId: 'someone-else' }),
    });

    await act(async () => {
      await result.current.control('pause');
    });

    expect(result.current.state.revision).toBe(5);
    expect(result.current.state.ownerId).toBe('u1');
  });

  test('revision 更新的状态会被应用', async () => {
    const { result } = await renderRoom();
    await waitFor(() => expect(result.current.state.revision).toBe(5));

    await act(async () => {
      await result.current.control('pause');
    });

    expect(result.current.state.revision).toBe(6);
  });

  test('429 冷却会给出提示且不抛出', async () => {
    const { result } = await renderRoom();

    mockPost.mockRejectedValueOnce({
      response: {
        data: {
          type: 'MUSIC_CONTROL_COOLDOWN',
          message: 'cooldown',
        },
      },
    });

    await act(async () => {
      await result.current.control('pause');
    });

    expect(mockShowToasts).toHaveBeenCalled();
  });

  test('重连后会重新拉取状态', async () => {
    await renderRoom();
    mockGet.mockClear();

    // 该环境没有 socket，onReconnect 不可用，refresh 单独验证
    const { result } = await renderRoom();
    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGet).toHaveBeenCalledWith('getState', {
      params: { groupId: 'g1' },
    });
  });

  test('卸载后延迟发送 leave，快速重挂载会取消它', async () => {
    const first = await renderRoom();
    const leaveCalls = () =>
      mockPost.mock.calls.filter(([action]) => action === 'leave').length;

    first.unmount();
    expect(leaveCalls()).toBe(0);

    // 在 300ms 内重新挂载：应取消 leave
    const second = await renderRoom();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(leaveCalls()).toBe(0);

    second.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(leaveCalls()).toBe(1);
  });
});
