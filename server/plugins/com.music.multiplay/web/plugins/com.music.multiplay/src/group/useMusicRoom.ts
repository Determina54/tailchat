import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getJWTUserInfo,
  showErrorToasts,
  showToasts,
  useGlobalSocketEvent,
  useSocketContext,
} from '@capital/common';
import { request } from '../request';
import { MUSIC_SOCKET_EVENTS } from '../events';
import type {
  MusicOwnerChangedPayload,
  MusicProgressPayload,
} from '../events';
import type { MusicRoomState } from '../types';
import { createEmptyRoomState } from '../types';
import { Translate } from '../translate';
import { subscribeReconnect } from './reconnect';

interface SessionEntry {
  count: number;
  leaveTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 同一 groupId 的挂载计数 + 延迟离开
 *
 * 用于规避 React StrictMode 的双挂载，以及同标签页内反复开合面板时的抖动。
 */
const sessions = new Map<string, SessionEntry>();

function acquireSession(groupId: string): SessionEntry {
  let entry = sessions.get(groupId);
  if (!entry) {
    entry = { count: 0 };
    sessions.set(groupId, entry);
  }

  entry.count += 1;
  if (entry.leaveTimer) {
    clearTimeout(entry.leaveTimer);
    entry.leaveTimer = undefined;
  }

  return entry;
}

function releaseSession(groupId: string): void {
  const entry = sessions.get(groupId);
  if (!entry) {
    return;
  }

  entry.count -= 1;
  if (entry.count > 0) {
    return;
  }

  entry.leaveTimer = setTimeout(() => {
    sessions.delete(groupId);
    request.post('leave', { groupId }).catch(() => undefined);
  }, 300);
}

function extractError(error: unknown): {
  type?: string;
  message?: string;
} {
  const data = (
    error as {
      response?: { data?: { type?: string; message?: string } };
    }
  )?.response?.data;

  return { type: data?.type, message: data?.message };
}

function notifyError(error: unknown): void {
  const { type } = extractError(error);

  if (
    type === 'MUSIC_CONTROL_COOLDOWN' ||
    type === 'MUSIC_CONTROL_RATE_LIMITED'
  ) {
    showToasts(Translate.cooldown, 'warning');
    return;
  }

  if (type === 'MUSIC_ROOM_BUSY') {
    showToasts(Translate.roomBusy, 'warning');
    return;
  }

  showErrorToasts(error);
}

export interface MusicRoomController {
  state: MusicRoomState;
  userId: string;
  isOwner: boolean;
  loading: boolean;
  control: (
    action: string,
    data?: Record<string, unknown>
  ) => Promise<MusicRoomState | undefined>;
  refresh: () => Promise<void>;
}

/**
 * 音乐房间状态与动作
 */
export function useMusicRoom(groupId: string): MusicRoomController {
  const socket = useSocketContext();
  const [state, setState] = useState<MusicRoomState>(() =>
    createEmptyRoomState(groupId)
  );
  const [userId, setUserId] = useState('');
  const [loading, setLoading] = useState(true);

  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;
  const revisionRef = useRef(0);
  const sequenceRef = useRef(0);

  /**
   * revision 守卫：丢弃乱序或过期的完整状态
   */
  const applyState = useCallback((input: unknown) => {
    if (!input || typeof input !== 'object') {
      return;
    }

    const payload = input as Partial<MusicRoomState>;
    if (payload.groupId && payload.groupId !== groupIdRef.current) {
      return;
    }

    const revision = Number(payload.revision ?? 0);
    if (revision > 0 && revision < revisionRef.current) {
      return;
    }

    revisionRef.current = revision;
    setState((previous) => ({ ...previous, ...payload } as MusicRoomState));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data } = await request.get('getState', {
        params: { groupId },
      });
      applyState(data);
    } catch (error) {
      notifyError(error);
    }
  }, [groupId, applyState]);

  // 加入 / 离开
  useEffect(() => {
    let active = true;

    revisionRef.current = 0;
    setState(createEmptyRoomState(groupId));
    setLoading(true);
    acquireSession(groupId);

    getJWTUserInfo()
      .then((user) => {
        if (!active) {
          return undefined;
        }

        const id = String(user?._id ?? '');
        setUserId(id);

        return request.post('join', {
          groupId,
          userName: user?.nickname || id,
        });
      })
      .then((response) => {
        if (!active || !response) {
          return;
        }

        applyState(response.data);
      })
      .catch((error) => {
        if (active) {
          notifyError(error);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      releaseSession(groupId);
    };
  }, [groupId, applyState]);

  // 重连后重新同步权威状态
  useEffect(
    () =>
      subscribeReconnect(socket, () => {
        void refresh();
      }),
    [socket, refresh]
  );

  useGlobalSocketEvent<MusicRoomState>(
    MUSIC_SOCKET_EVENTS.stateUpdate,
    (data) => {
      applyState(data);
    }
  );

  useGlobalSocketEvent<MusicProgressPayload>(
    MUSIC_SOCKET_EVENTS.progressSync,
    (data) => {
      if (!data || data.groupId !== groupIdRef.current) {
        return;
      }

      setState((previous) => ({
        ...previous,
        currentTime: Number(data.currentTime) || 0,
        isPlaying: Boolean(data.isPlaying),
      }));
    }
  );

  useGlobalSocketEvent<MusicOwnerChangedPayload>(
    MUSIC_SOCKET_EVENTS.ownerChanged,
    (data) => {
      if (!data || data.groupId !== groupIdRef.current) {
        return;
      }

      setState((previous) => ({ ...previous, ownerId: data.ownerId }));
    }
  );

  const control = useCallback(
    async (action: string, data: Record<string, unknown> = {}) => {
      const sequence = ++sequenceRef.current;

      try {
        const { data: next } = await request.post(action, {
          groupId,
          ...data,
        });

        if (sequence === sequenceRef.current) {
          applyState(next);
        }

        return next as MusicRoomState;
      } catch (error) {
        if (sequence === sequenceRef.current) {
          notifyError(error);
        }

        return undefined;
      }
    },
    [groupId, applyState]
  );

  return {
    state,
    userId,
    isOwner: Boolean(userId) && state.ownerId === userId,
    loading,
    control,
    refresh,
  };
}

export default useMusicRoom;
