import {
  HISTORY_LIMIT,
  addTrack,
  advanceNext,
  advancePrev,
  applyPresence,
  canControl,
  clearQueue,
  commitElapsed,
  createInitialState,
  currentTimeOf,
  isOwner,
  normalizeState,
  removeMember,
  removeTrack,
  seek,
  setMemberMuteUntil,
  setPlaying,
  setVolume,
  toDto,
  upsertMember,
} from '../services/musicRoomState';
import type {
  MusicRoomState,
  MultiplayTrack,
} from '../services/musicRoomState';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const track = (id: string): MultiplayTrack => ({
  id,
  name: `song-${id}`,
  addedBy: 'u1',
  addedAt: T0,
});

function withMembers(
  state: MusicRoomState,
  members: Array<{ userId: string; userName: string; joinedAt: number }>
): MusicRoomState {
  return {
    ...state,
    members: members.map((member) => ({
      ...member,
      lastSeenAt: member.joinedAt,
      offlineMisses: 0,
    })),
  };
}

describe('musicRoomState', () => {
  test('空闲房间添加第一首歌会自动播放', () => {
    const state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);

    expect(state.currentTrackId).toBe('a');
    expect(state.currentTrack?.name).toBe('song-a');
    expect(state.isPlaying).toBe(true);
    expect(state.playingSince).toBe(T0);
    expect(state.queue).toHaveLength(0);
  });

  test('播放中追加歌曲只进入队列', () => {
    const playing = addTrack(
      createInitialState('g1', T0),
      track('a'),
      'u1',
      T0
    );
    const state = addTrack(playing, track('b'), 'u2', T0 + 1000);

    expect(state.currentTrackId).toBe('a');
    expect(state.queue.map((item) => item.id)).toEqual(['b']);
  });

  test('advanceNext 把当前曲目推入 history 并取出队首', () => {
    let state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    state = addTrack(state, track('b'), 'u1', T0 + 1000);

    const next = advanceNext(state, T0 + 2000);

    expect(next.currentTrackId).toBe('b');
    expect(next.queue).toHaveLength(0);
    expect(next.history.map((item) => item.id)).toEqual(['a']);
    expect(next.isPlaying).toBe(true);
  });

  test('队列为空时 advanceNext 进入 idle', () => {
    const state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    const next = advanceNext(state, T0 + 5000);

    expect(next.currentTrackId).toBeUndefined();
    expect(next.currentTrack).toBeUndefined();
    expect(next.isPlaying).toBe(false);
    expect(next.playingSince).toBeUndefined();
    expect(next.history.map((item) => item.id)).toEqual(['a']);
  });

  test('history 上限为 50', () => {
    const base = createInitialState('g1', T0);
    const state: MusicRoomState = {
      ...base,
      currentTrackId: 'cur',
      currentTrack: track('cur'),
      history: Array.from({ length: HISTORY_LIMIT }, (_, index) =>
        track(`h${index}`)
      ),
    };

    const next = advanceNext(state, T0 + 1000);

    expect(next.history).toHaveLength(HISTORY_LIMIT);
    expect(next.history[0].id).toBe('cur');
  });

  test('history 为空时 advancePrev 不做任何修改', () => {
    const state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);

    expect(advancePrev(state, T0 + 1000)).toBe(state);
  });

  test('advancePrev 会回到上一首并把当前曲目放回队首', () => {
    let state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    state = addTrack(state, track('b'), 'u1', T0 + 1000);
    state = advanceNext(state, T0 + 2000);

    const previous = advancePrev(state, T0 + 3000);

    expect(previous.currentTrackId).toBe('a');
    expect(previous.queue.map((item) => item.id)).toEqual(['b']);
    expect(previous.history).toHaveLength(0);
    expect(previous.isPlaying).toBe(true);
  });

  test('removeTrack 只影响队列', () => {
    let state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    state = addTrack(state, track('b'), 'u1', T0 + 1000);

    const next = removeTrack(state, 'b', T0 + 2000);

    expect(next.queue).toHaveLength(0);
    expect(next.currentTrackId).toBe('a');
  });

  test('clearQueue 清空队列但保留当前曲目', () => {
    let state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    state = addTrack(state, track('b'), 'u1', T0 + 1000);

    const next = clearQueue(state, T0 + 2000);

    expect(next.queue).toHaveLength(0);
    expect(next.currentTrackId).toBe('a');
  });

  test('currentTimeOf / commitElapsed 基于 playingSince 推导', () => {
    const state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);

    expect(currentTimeOf(state, T0 + 5000)).toBeCloseTo(5, 5);

    const committed = commitElapsed(state, T0 + 5000);
    expect(committed.baseTime).toBeCloseTo(5, 5);
    expect(committed.playingSince).toBe(T0 + 5000);
    expect(currentTimeOf(committed, T0 + 5000)).toBeCloseTo(5, 5);
  });

  test('setPlaying(false) 会累计已播放时间', () => {
    const state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    const paused = setPlaying(state, false, T0 + 4000);

    expect(paused.isPlaying).toBe(false);
    expect(paused.baseTime).toBeCloseTo(4, 5);
    expect(paused.playingSince).toBeUndefined();
  });

  test('seek 会重置基准时间', () => {
    const state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    const seeked = seek(state, 42, T0 + 2000);

    expect(seeked.baseTime).toBe(42);
    expect(seeked.playingSince).toBe(T0 + 2000);
  });

  test('setVolume 做 0-100 夹取', () => {
    const state = createInitialState('g1', T0);

    expect(setVolume(state, 130, T0).volume).toBe(100);
    expect(setVolume(state, -5, T0).volume).toBe(0);
  });

  test('第一个加入的成员成为 owner', () => {
    const state = upsertMember(
      createInitialState('g1', T0),
      { userId: 'u1', userName: 'A' },
      T0
    );

    expect(state.ownerId).toBe('u1');
    expect(isOwner(state, 'u1')).toBe(true);
    expect(isOwner(state, 'u2')).toBe(false);
  });

  test('owner 离开后提升最早加入的成员', () => {
    let state = upsertMember(createInitialState('g1', T0), { userId: 'u1', userName: 'A' }, T0);
    state = upsertMember(state, { userId: 'u2', userName: 'B' }, T0 + 1000);
    state = upsertMember(state, { userId: 'u3', userName: 'C' }, T0 + 2000);

    const next = removeMember(state, 'u1', T0 + 3000);

    expect(next.ownerId).toBe('u2');
    expect(next.members.map((item) => item.userId)).toEqual(['u2', 'u3']);
  });

  test('applyPresence 连续两次离线才移除并交接 owner', () => {
    let state = upsertMember(createInitialState('g1', T0), { userId: 'u1', userName: 'A' }, T0);
    state = upsertMember(state, { userId: 'u2', userName: 'B' }, T0 + 1000);

    const first = applyPresence(state, { u1: false, u2: true }, T0 + 10000);
    expect(first.removed).toHaveLength(0);
    expect(first.changed).toBe(true);
    expect(first.state.members[0].offlineMisses).toBe(1);

    const second = applyPresence(
      first.state,
      { u1: false, u2: true },
      T0 + 20000
    );
    expect(second.removed).toEqual(['u1']);
    expect(second.ownerChanged).toBe(true);
    expect(second.state.ownerId).toBe('u2');
  });

  test('applyPresence 在全员在线时不做修改', () => {
    const state = upsertMember(
      createInitialState('g1', T0),
      { userId: 'u1', userName: 'A' },
      T0
    );

    const result = applyPresence(state, { u1: true }, T0 + 10000);

    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  test('canControl 同时识别群组禁言与房间禁播', () => {
    let state = addTrack(createInitialState('g1', T0), track('a'), 'u1', T0);
    state = upsertMember(state, { userId: 'u1', userName: 'A' }, T0);
    state = upsertMember(state, { userId: 'u2', userName: 'B' }, T0 + 1);

    expect(canControl(state, 'u2', undefined, T0).allowed).toBe(true);
    expect(canControl(state, 'u2', T0 + 1000, T0).allowed).toBe(false);

    const muted = setMemberMuteUntil(state, 'u2', T0 + 1000, T0);
    expect(canControl(muted, 'u2', undefined, T0).allowed).toBe(false);
    expect(canControl(muted, 'u2', undefined, T0 + 2000).allowed).toBe(true);
  });

  test('normalizeState 兼容旧结构与脏数据', () => {
    const legacy = {
      revision: 3,
      currentTime: 12,
      isPlaying: true,
      queue: [{ id: 'a', name: 'A', addedAt: T0 }],
      members: [{ userId: 'u1', joinedAt: T0 }],
    };

    const state = normalizeState(
      { ...legacy, currentTrack: { id: 'cur', name: 'Cur' } },
      'g1',
      T0
    );

    expect(state.revision).toBe(3);
    expect(state.currentTrackId).toBe('cur');
    expect(state.queue).toHaveLength(1);
    expect(state.members[0].offlineMisses).toBe(0);
    expect(state.history).toHaveLength(0);
  });

  test('toDto 输出推导后的 currentTime 且不泄漏内部字段', () => {
    const state = withMembers(
      addTrack(createInitialState('g1', T0), track('a'), 'u1', T0),
      [{ userId: 'u1', userName: 'A', joinedAt: T0 }]
    );

    const dto = toDto(state, T0 + 3000);

    expect(dto.currentTime).toBeCloseTo(3, 5);
    expect(dto.degraded).toBeUndefined();
    expect(dto.members).toHaveLength(1);
    expect((dto as unknown as Record<string, unknown>).offlineMisses).toBeUndefined();
  });

  test('降级 DTO 会带上 degraded 标记', () => {
    const dto = toDto(createInitialState('g1', T0), T0, true);
    expect(dto.degraded).toBe(true);
  });
});
