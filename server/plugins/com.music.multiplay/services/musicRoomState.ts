/**
 * 音乐房间状态（纯逻辑，无 IO）
 *
 * NOTICE:
 * - 该文件中的所有函数都是纯函数，便于单测与在多实例间保持一致语义。
 * - Redis 中的权威状态只保存 baseTime + playingSince，不保存被就地累加的 currentTime，
 *   这样读路径永远不会写入，当前播放时间由 currentTimeOf() 按统一时钟推导。
 */

export const ROOM_STATE_VERSION = 1;

/**
 * history 上限
 */
export const HISTORY_LIMIT = 50;

export const DEFAULT_VOLUME = 80;

/**
 * 连续多少次在线检查失败后判定为离线（容忍 disconnecting 与查询的竞态）
 */
export const OFFLINE_GRACE_MISSES = 2;

export interface MultiplayTrack {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  picUrl?: string;
  picId?: string;
  lyricId?: string;
  source?: string;
  lyric?: string;
  tlyric?: string;
  addedBy: string;
  addedAt: number;
}

export interface RoomMember {
  userId: string;
  userName: string;
  joinedAt: number;
  lastSeenAt: number;
  offlineMisses: number;
  muteUntil?: number;
}

export interface MusicRoomState {
  v: number;
  groupId: string;
  revision: number;
  queue: MultiplayTrack[];
  history: MultiplayTrack[];
  currentTrackId?: string;
  currentTrack?: MultiplayTrack;
  baseTime: number;
  isPlaying: boolean;
  playingSince?: number;
  volume: number;
  ownerId?: string;
  members: RoomMember[];
  updatedAt: number;
}

export interface MusicRoomMemberDto {
  userId: string;
  userName: string;
  joinedAt: number;
  muteUntil?: number;
}

export interface MusicRoomDto {
  groupId: string;
  revision: number;
  queue: MultiplayTrack[];
  history: MultiplayTrack[];
  currentTrackId?: string;
  currentTrack?: MultiplayTrack;
  currentTime: number;
  isPlaying: boolean;
  volume: number;
  ownerId?: string;
  members: MusicRoomMemberDto[];
  degraded?: boolean;
}

export function clampVolume(volume: number, fallback = DEFAULT_VOLUME): number {
  if (!Number.isFinite(volume)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(volume)));
}

function normalizeTrack(raw: unknown): MultiplayTrack | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const input = raw as Record<string, unknown>;
  const id = input.id == null ? '' : String(input.id);
  const name = input.name == null ? '' : String(input.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    artist: input.artist == null ? undefined : String(input.artist),
    album: input.album == null ? undefined : String(input.album),
    picUrl: input.picUrl == null ? undefined : String(input.picUrl),
    picId: input.picId == null ? undefined : String(input.picId),
    lyricId: input.lyricId == null ? undefined : String(input.lyricId),
    source: input.source == null ? undefined : String(input.source),
    lyric: input.lyric == null ? undefined : String(input.lyric),
    tlyric: input.tlyric == null ? undefined : String(input.tlyric),
    addedBy: input.addedBy == null ? '' : String(input.addedBy),
    addedAt: Number.isFinite(Number(input.addedAt))
      ? Number(input.addedAt)
      : Date.now(),
  };
}

function normalizeTracks(raw: unknown): MultiplayTrack[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => normalizeTrack(item))
    .filter((item): item is MultiplayTrack => item !== null);
}

function normalizeMember(raw: unknown, now: number): RoomMember | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const input = raw as Record<string, unknown>;
  const userId = input.userId == null ? '' : String(input.userId);
  if (!userId) {
    return null;
  }

  return {
    userId,
    userName: input.userName == null ? userId : String(input.userName),
    joinedAt: Number.isFinite(Number(input.joinedAt))
      ? Number(input.joinedAt)
      : now,
    lastSeenAt: Number.isFinite(Number(input.lastSeenAt))
      ? Number(input.lastSeenAt)
      : now,
    offlineMisses: Number.isFinite(Number(input.offlineMisses))
      ? Math.max(0, Math.floor(Number(input.offlineMisses)))
      : 0,
    muteUntil: Number.isFinite(Number(input.muteUntil))
      ? Number(input.muteUntil)
      : undefined,
  };
}

/**
 * 兼容性归一化：Redis / Mongo 中可能存在的旧结构或脏数据
 */
export function normalizeState(
  raw: unknown,
  groupId: string,
  now: number
): MusicRoomState {
  const input = (raw ?? {}) as Record<string, unknown>;
  const currentTrack = normalizeTrack(input.currentTrack) ?? undefined;
  const currentTrackId = currentTrack
    ? currentTrack.id
    : input.currentTrackId == null
    ? undefined
    : String(input.currentTrackId);

  const isPlaying = Boolean(input.isPlaying) && Boolean(currentTrackId);
  const playingSince = isPlaying && Number.isFinite(Number(input.playingSince))
    ? Number(input.playingSince)
    : undefined;

  return {
    v: ROOM_STATE_VERSION,
    groupId,
    revision: Number.isFinite(Number(input.revision))
      ? Math.max(0, Math.floor(Number(input.revision)))
      : 0,
    queue: normalizeTracks(input.queue),
    history: normalizeTracks(input.history).slice(0, HISTORY_LIMIT),
    currentTrackId,
    currentTrack,
    baseTime: Number.isFinite(Number(input.baseTime))
      ? Math.max(0, Number(input.baseTime))
      : 0,
    isPlaying,
    playingSince,
    volume: clampVolume(Number(input.volume)),
    ownerId:
      input.ownerId == null || input.ownerId === ''
        ? undefined
        : String(input.ownerId),
    members: Array.isArray(input.members)
      ? input.members
          .map((item) => normalizeMember(item, now))
          .filter((item): item is RoomMember => item !== null)
      : [],
    updatedAt: Number.isFinite(Number(input.updatedAt))
      ? Number(input.updatedAt)
      : now,
  };
}

export function createInitialState(
  groupId: string,
  now: number
): MusicRoomState {
  return {
    v: ROOM_STATE_VERSION,
    groupId,
    revision: 0,
    queue: [],
    history: [],
    currentTrackId: undefined,
    currentTrack: undefined,
    baseTime: 0,
    isPlaying: false,
    playingSince: undefined,
    volume: DEFAULT_VOLUME,
    ownerId: undefined,
    members: [],
    updatedAt: now,
  };
}

/**
 * 读出当前播放时间（不修改状态）
 */
export function currentTimeOf(state: MusicRoomState, now: number): number {
  if (state.isPlaying && state.playingSince) {
    return (
      state.baseTime + Math.max(0, (now - state.playingSince) / 1000)
    );
  }

  return state.baseTime;
}

/**
 * 写入前把已经流逝的时间并入 baseTime，并把 playingSince 重新对齐到 now
 */
export function commitElapsed(
  state: MusicRoomState,
  now: number
): MusicRoomState {
  if (!state.isPlaying || !state.playingSince) {
    return state;
  }

  const elapsed = Math.max(0, (now - state.playingSince) / 1000);
  return {
    ...state,
    baseTime: state.baseTime + elapsed,
    playingSince: now,
  };
}

export function toDto(
  state: MusicRoomState,
  now: number,
  degraded = false
): MusicRoomDto {
  return {
    groupId: state.groupId,
    revision: state.revision,
    queue: state.queue,
    history: state.history,
    currentTrackId: state.currentTrackId,
    currentTrack: state.currentTrack,
    currentTime: currentTimeOf(state, now),
    isPlaying: state.isPlaying,
    volume: state.volume,
    ownerId: state.ownerId,
    members: state.members.map((member) => ({
      userId: member.userId,
      userName: member.userName,
      joinedAt: member.joinedAt,
      muteUntil: member.muteUntil,
    })),
    ...(degraded ? { degraded: true } : {}),
  };
}

export function memberIds(state: MusicRoomState): string[] {
  return state.members.map((member) => member.userId);
}

export function findMember(
  state: MusicRoomState,
  userId: string
): RoomMember | undefined {
  return state.members.find((member) => member.userId === userId);
}

export function isMuted(
  state: MusicRoomState,
  userId: string,
  now: number
): boolean {
  const member = findMember(state, userId);
  return Boolean(member?.muteUntil && member.muteUntil > now);
}

export function isOwner(state: MusicRoomState, userId: string): boolean {
  return Boolean(userId) && state.ownerId === userId;
}

export interface ControlPermissionResult {
  allowed: boolean;
  reason?: 'muted';
}

/**
 * 控制权限判定（群组禁言与房间禁播都视为不可控制）
 */
export function canControl(
  state: MusicRoomState,
  userId: string,
  groupMuteUntilMs: number | undefined,
  now: number
): ControlPermissionResult {
  if (groupMuteUntilMs != null && groupMuteUntilMs > now) {
    return { allowed: false, reason: 'muted' };
  }

  if (isMuted(state, userId, now)) {
    return { allowed: false, reason: 'muted' };
  }

  return { allowed: true };
}

/**
 * 提升最早加入的成员为 owner
 */
export function promoteOwner(state: MusicRoomState): MusicRoomState {
  const nextOwner = state.members
    .slice()
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];

  if (nextOwner?.userId === state.ownerId) {
    return state;
  }

  return { ...state, ownerId: nextOwner?.userId };
}

export function upsertMember(
  state: MusicRoomState,
  member: { userId: string; userName: string },
  now: number
): MusicRoomState {
  const existing = findMember(state, member.userId);

  if (existing) {
    const members = state.members.map((item) =>
      item.userId === member.userId
        ? {
            ...item,
            userName: member.userName || item.userName,
            lastSeenAt: now,
            offlineMisses: 0,
          }
        : item
    );

    return { ...state, members, updatedAt: now };
  }

  const next: MusicRoomState = {
    ...state,
    members: [
      ...state.members,
      {
        userId: member.userId,
        userName: member.userName || member.userId,
        joinedAt: now,
        lastSeenAt: now,
        offlineMisses: 0,
      },
    ],
    updatedAt: now,
  };

  if (!next.ownerId) {
    return { ...next, ownerId: member.userId };
  }

  return next;
}

export function touchMember(
  state: MusicRoomState,
  userId: string,
  now: number
): MusicRoomState {
  const member = findMember(state, userId);
  if (!member) {
    return state;
  }

  return {
    ...state,
    members: state.members.map((item) =>
      item.userId === userId
        ? { ...item, lastSeenAt: now, offlineMisses: 0 }
        : item
    ),
    updatedAt: now,
  };
}

export function removeMember(
  state: MusicRoomState,
  userId: string,
  now: number
): MusicRoomState {
  if (!findMember(state, userId)) {
    return state;
  }

  const next: MusicRoomState = {
    ...state,
    members: state.members.filter((item) => item.userId !== userId),
    updatedAt: now,
  };

  if (next.ownerId === userId) {
    return promoteOwner(next);
  }

  return next;
}

export function setMemberMuteUntil(
  state: MusicRoomState,
  userId: string,
  muteUntil: number | undefined,
  now: number
): MusicRoomState {
  if (!findMember(state, userId)) {
    return state;
  }

  return {
    ...state,
    members: state.members.map((item) =>
      item.userId === userId ? { ...item, muteUntil } : item
    ),
    updatedAt: now,
  };
}

export interface PresenceResult {
  state: MusicRoomState;
  removed: string[];
  ownerChanged: boolean;
  changed: boolean;
}

/**
 * 按在线状态清理成员：连续 OFFLINE_GRACE_MISSES 次离线才移除
 *
 * NOTICE: offlineMisses 的累进也需要写回，否则计数永远无法累计。
 */
export function applyPresence(
  state: MusicRoomState,
  online: Record<string, boolean>,
  now: number,
  grace = OFFLINE_GRACE_MISSES
): PresenceResult {
  const removed: string[] = [];
  const members: RoomMember[] = [];
  let changed = false;

  for (const member of state.members) {
    if (online[member.userId] !== false) {
      if (member.offlineMisses !== 0) {
        changed = true;
      }

      members.push(
        member.offlineMisses === 0 ? member : { ...member, offlineMisses: 0 }
      );
      continue;
    }

    const offlineMisses = member.offlineMisses + 1;
    changed = true;

    if (offlineMisses >= grace) {
      removed.push(member.userId);
      continue;
    }

    members.push({ ...member, offlineMisses });
  }

  if (!changed) {
    return { state, removed: [], ownerChanged: false, changed: false };
  }

  const previousOwner = state.ownerId;
  let next: MusicRoomState = { ...state, members, updatedAt: now };
  if (next.ownerId && removed.includes(next.ownerId)) {
    next = promoteOwner(next);
  }

  return {
    state: next,
    removed,
    ownerChanged: previousOwner !== next.ownerId,
    changed: true,
  };
}

/**
 * 追加歌曲；当房间空闲时自动播放第一首
 */
export function addTrack(
  state: MusicRoomState,
  track: Omit<MultiplayTrack, 'addedBy' | 'addedAt'>,
  userId: string,
  now: number
): MusicRoomState {
  const queue = [
    ...state.queue,
    { ...track, addedBy: userId, addedAt: now },
  ];

  if (state.currentTrackId) {
    return { ...state, queue, updatedAt: now };
  }

  const [first, ...rest] = queue;
  return {
    ...state,
    queue: rest,
    currentTrackId: first?.id,
    currentTrack: first,
    baseTime: 0,
    isPlaying: Boolean(first),
    playingSince: first ? now : undefined,
    updatedAt: now,
  };
}

export function removeTrack(
  state: MusicRoomState,
  trackId: string,
  now: number
): MusicRoomState {
  const queue = state.queue.filter((track) => track.id !== trackId);
  if (queue.length === state.queue.length) {
    return state;
  }

  return { ...state, queue, updatedAt: now };
}

export function clearQueue(
  state: MusicRoomState,
  now: number
): MusicRoomState {
  if (state.queue.length === 0) {
    return state;
  }

  return { ...state, queue: [], updatedAt: now };
}

/**
 * 播放下一首；队列为空则进入 idle
 */
export function advanceNext(
  state: MusicRoomState,
  now: number
): MusicRoomState {
  const committed = commitElapsed(state, now);
  const history = committed.currentTrack
    ? [committed.currentTrack, ...committed.history].slice(0, HISTORY_LIMIT)
    : committed.history;
  const [next, ...rest] = committed.queue;

  return {
    ...committed,
    queue: rest,
    history,
    currentTrackId: next?.id,
    currentTrack: next,
    baseTime: 0,
    isPlaying: Boolean(next),
    playingSince: next ? now : undefined,
    updatedAt: now,
  };
}

/**
 * 播放上一首；history 为空时不做任何修改
 */
export function advancePrev(
  state: MusicRoomState,
  now: number
): MusicRoomState {
  const [previous, ...history] = state.history;
  if (!previous) {
    return state;
  }

  const committed = commitElapsed(state, now);
  const queue = committed.currentTrack
    ? [committed.currentTrack, ...committed.queue]
    : committed.queue;

  return {
    ...committed,
    queue,
    history,
    currentTrackId: previous.id,
    currentTrack: previous,
    baseTime: 0,
    isPlaying: true,
    playingSince: now,
    updatedAt: now,
  };
}

export function seek(
  state: MusicRoomState,
  time: number,
  now: number
): MusicRoomState {
  const committed = commitElapsed(state, now);

  return {
    ...committed,
    baseTime: Math.max(0, time),
    playingSince: committed.isPlaying ? now : undefined,
    updatedAt: now,
  };
}

export function setPlaying(
  state: MusicRoomState,
  playing: boolean,
  now: number
): MusicRoomState {
  const committed = commitElapsed(state, now);
  const isPlaying = Boolean(committed.currentTrackId) && playing;

  return {
    ...committed,
    isPlaying,
    playingSince: isPlaying ? now : undefined,
    updatedAt: now,
  };
}

export function setVolume(
  state: MusicRoomState,
  volume: number,
  now: number
): MusicRoomState {
  const nextVolume = clampVolume(volume, state.volume);
  if (nextVolume === state.volume) {
    return state;
  }

  return { ...state, volume: nextVolume, updatedAt: now };
}
