import { TcBroker } from 'tailchat-server-sdk';
import MultiplayService from '../services/multiplay.service';
import FakeRedis from './fakeRedis';

/**
 * 服务级集成测试
 *
 * 需要可用的 MongoDB（模型适配器在 broker.start() 时连接）。
 * 没有 MONGO_URL 时整组跳过，避免误报。
 */
const describeMongo = process.env.MONGO_URL ? describe : describe.skip;

const MUTE_MS = 5 * 60 * 1000;

describeMongo('MultiplayService（需要 MONGO_URL）', () => {
  const fakeRedis = new FakeRedis();
  const groups = new Map<string, unknown>();
  let permissions: string[] = [];
  let online = true;
  let broker: any;
  let listcastNotify: jest.Mock;

  const contextCallMockFn = (actionName: string, params: any) => {
    switch (actionName) {
      case 'group.getGroupInfo':
        return Promise.resolve(groups.get(params.groupId) ?? null);
      case 'group.getUserAllPermissions':
        return Promise.resolve(permissions);
      case 'group.muteGroupMember':
        return Promise.resolve();
      case 'gateway.checkUserOnline':
        return Promise.resolve(
          (params.userIds as string[]).map(() => online)
        );
      case 'gateway.notify':
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  };

  const setGroup = (
    groupId: string,
    members: Array<{ userId: string; muteUntil?: Date }>
  ) => {
    groups.set(groupId, {
      _id: groupId,
      name: groupId,
      members: members.map((member) => ({
        ...member,
        nickname: member.userId,
      })),
    });
  };

  const call = (
    action: string,
    params: Record<string, unknown>,
    userId: string
  ): Promise<any> =>
    broker.call(`plugin:com.music.multiplay.${action}`, params, {
      meta: { userId },
    });

  let seq = 0;
  const uniqueGroup = () => `group-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    // 只在真正执行时才创建 broker：onInit 会校验 MONGO_URL
    broker = new TcBroker({ logger: false } as never);
    const contextCallMock = jest.fn(contextCallMockFn);

    broker.ContextFactory = class extends broker.ContextFactory {
      call = contextCallMock;
    };

    const service = broker.createService(MultiplayService);
    listcastNotify = jest.fn();
    service.listcastNotify = listcastNotify;
    service.unicastNotify = jest.fn();
    service.roomcastNotify = jest.fn();

    // 注入可控的 Redis 客户端（服务通过 broker.cacher.client 读取）
    broker.cacher = {
      client: fakeRedis,
      prefix: 'TC-',
      init: () => undefined,
      get: async () => undefined,
      set: async () => undefined,
      del: async () => undefined,
      clean: async () => undefined,
      close: async () => undefined,
    };

    await broker.start();
  });

  afterAll(async () => {
    if (broker) {
      await broker.stop();
    }
  });

  beforeEach(() => {
    permissions = [];
    online = true;
  });

  test('非群成员访问返回 403', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }]);

    await expect(
      call('getState', { groupId }, 'u2')
    ).rejects.toMatchObject({ code: 403 });
  });

  test('群组不存在时返回 403', async () => {
    await expect(
      call('getState', { groupId: uniqueGroup() }, 'u1')
    ).rejects.toMatchObject({ code: 403 });
  });

  test('join 后成员可见且第一个成员成为 owner', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    const first = await call('join', { groupId, userName: 'A' }, 'u1');
    expect(first.ownerId).toBe('u1');
    expect(first.members.map((member: any) => member.userId)).toEqual(['u1']);

    const second = await call('join', { groupId, userName: 'B' }, 'u2');
    expect(second.ownerId).toBe('u1');
    expect(second.members).toHaveLength(2);
  });

  test('owner 显式 leave 后提升最早加入的剩余成员', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');
    await call('join', { groupId }, 'u3');

    const state = await call('leave', { groupId }, 'u1');

    expect(state.ownerId).toBe('u2');
    expect(state.members.map((member: any) => member.userId)).toEqual([
      'u2',
      'u3',
    ]);
  });

  test('非 owner 不能 remove / clear', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');
    await call('add', { groupId, track: { id: 't1', name: 'T1' } }, 'u1');

    await expect(
      call('remove', { groupId, trackId: 't1' }, 'u2')
    ).rejects.toMatchObject({ code: 403 });

    await expect(call('clear', { groupId }, 'u2')).rejects.toMatchObject({
      code: 403,
    });
  });

  test('普通成员可以播放控制，队列会自动播放第一首', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');

    const added = await call(
      'add',
      { groupId, track: { id: 't1', name: 'T1' } },
      'u2'
    );
    expect(added.currentTrackId).toBe('t1');
    expect(added.isPlaying).toBe(true);

    const paused = await call('pause', { groupId }, 'u2');
    expect(paused.isPlaying).toBe(false);

    const played = await call('play', { groupId }, 'u2');
    expect(played.isPlaying).toBe(true);

    const seeked = await call('seek', { groupId, time: 30 }, 'u2');
    expect(seeked.currentTime).toBeGreaterThanOrEqual(30);

    const next = await call('next', { groupId }, 'u2');
    expect(next.currentTrackId).toBeUndefined();
    expect(next.history.map((track: any) => track.id)).toEqual(['t1']);

    const prev = await call('prev', { groupId }, 'u2');
    expect(prev.currentTrackId).toBe('t1');
  });

  test('owner 可以修改房间音量，非 owner 返回 403', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');

    const updated = await call('volume', { groupId, volume: 35 }, 'u1');
    expect(updated.volume).toBe(35);

    await expect(
      call('volume', { groupId, volume: 50 }, 'u2')
    ).rejects.toMatchObject({ code: 403 });
  });

  test('被禁播成员不能执行音乐控制', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');
    await call('add', { groupId, track: { id: 't1', name: 'T1' } }, 'u1');

    const room = await call('mute', { groupId, memberId: 'u2' }, 'u1');
    const muted = (room.members as any[]).find(
      (member) => member.userId === 'u2'
    );
    expect(muted.muteUntil).toBeGreaterThan(fakeRedis.now());

    await expect(call('pause', { groupId }, 'u2')).rejects.toMatchObject({
      code: 403,
    });
  });

  test('群组禁言同样阻止音乐控制', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [
      { userId: 'u1' },
      { userId: 'u2', muteUntil: new Date(fakeRedis.now() + MUTE_MS) },
    ]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');
    await call('add', { groupId, track: { id: 't1', name: 'T1' } }, 'u1');

    await expect(call('pause', { groupId }, 'u2')).rejects.toMatchObject({
      code: 403,
    });
  });

  test('无 manageUser 权限不能 mute', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');

    permissions = [];
    await expect(
      call('mute', { groupId, memberId: 'u2' }, 'u1')
    ).rejects.toMatchObject({ code: 403 });
  });

  test('拥有 manageUser 权限可以 mute', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }, { userId: 'u2' }]);

    await call('join', { groupId }, 'u1');
    await call('join', { groupId }, 'u2');

    permissions = ['core.manageUser'];
    await expect(
      call('mute', { groupId, memberId: 'u2' }, 'u1')
    ).resolves.toBeDefined();
  });

  test('play/pause/seek 有 5 秒冷却', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }]);

    await call('join', { groupId }, 'u1');
    await call('add', { groupId, track: { id: 't1', name: 'T1' } }, 'u1');

    await expect(call('pause', { groupId }, 'u1')).resolves.toBeDefined();

    await expect(call('play', { groupId }, 'u1')).rejects.toMatchObject({
      code: 429,
      type: 'MUSIC_CONTROL_COOLDOWN',
    });
  });

  test('非法 seek 时间返回表单错误', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }]);

    await call('join', { groupId }, 'u1');

    await expect(
      call('seek', { groupId, time: -1 }, 'u1')
    ).rejects.toMatchObject({ code: 442 });
  });

  test('add 会校验歌曲信息', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }]);

    await call('join', { groupId }, 'u1');

    await expect(
      call('add', { groupId, track: { name: 'no id' } }, 'u1')
    ).rejects.toBeDefined();
  });

  test('非法 source 的歌曲无法加入队列', async () => {
    const groupId = uniqueGroup();
    setGroup(groupId, [{ userId: 'u1' }]);

    await call('join', { groupId }, 'u1');

    await expect(
      call(
        'add',
        { groupId, track: { id: 't1', name: 'T1', source: 'spotify' } },
        'u1'
      )
    ).rejects.toMatchObject({ code: 442 });
  });
});
