import FakeRedis from './fakeRedis';
import {
  MusicRoomLockTimeoutError,
  MusicRoomStore,
} from '../services/musicRoomStore';
import type { RedisLike } from '../services/musicRoomStore';
import {
  createInitialState,
  upsertMember,
} from '../services/musicRoomState';
import type { MusicRoomState } from '../services/musicRoomState';

const PREFIX = 'test-plugin:com.music.multiplay:';
const GROUP = 'g1';

function createStore(
  redis: RedisLike,
  options: Record<string, any> = {}
): MusicRoomStore {
  return new MusicRoomStore(redis, { prefix: PREFIX, ...options });
}

/**
 * 在第一次 CAS 之前偷偷改动存储中的 revision，用于制造 CAS 冲突
 */
class ConflictOnceRedis extends FakeRedis {
  private injected = false;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const op = /-- @op ([\w.]+)/.exec(script)?.[1];

    if (op === 'room.cas' && !this.injected) {
      this.injected = true;
      const key = String(args[0]);
      const raw = await super.get(key);
      if (raw) {
        const doc = JSON.parse(String(raw)) as { revision: number };
        await super.set(
          key,
          JSON.stringify({ ...doc, revision: doc.revision + 100 }),
          'PX',
          60000
        );
      }
    }

    return super.eval(script, numberOfKeys, ...args);
  }
}

describe('MusicRoomStore（内存假 Redis）', () => {
  test('seed 后可按 Redis 时钟读回状态', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const state = createInitialState(GROUP, redis.now());

    const now = await store.seedRoom(GROUP, state);
    const loaded = await store.readRoom(GROUP);

    expect(await store.now()).toBe(now);
    expect(loaded.state?.groupId).toBe(GROUP);
    expect(loaded.state?.revision).toBe(0);
  });

  test('房间缺失时回调 restore 从 Mongo 恢复并写入 Redis', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const restored = upsertMember(
      createInitialState(GROUP, redis.now()),
      { userId: 'u1', userName: 'A' },
      redis.now()
    );

    const result = await store.mutate(GROUP, {
      restore: async () => ({ ...restored, revision: 7 }),
      mutate: () => null,
    });

    expect(result.state.revision).toBe(7);
    expect(result.state.ownerId).toBe('u1');

    const loaded = await store.readRoom(GROUP);
    expect(loaded.state?.revision).toBe(7);
  });

  test('mutate 会递增 revision 并写入 Redis', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);

    const first = await store.mutate(GROUP, {
      mutate: (state, now) =>
        upsertMember(state, { userId: 'u1', userName: 'A' }, now),
    });

    expect(first.changed).toBe(true);
    expect(first.state.revision).toBe(1);
    expect(first.state.ownerId).toBe('u1');

    const second = await store.mutate(GROUP, {
      mutate: (state, now) =>
        upsertMember(state, { userId: 'u2', userName: 'B' }, now),
    });

    expect(second.state.revision).toBe(2);
    expect(second.state.members).toHaveLength(2);
  });

  test('并发 mutate 不会丢更新', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);

    await Promise.all([
      store.mutate(GROUP, {
        mutate: (state, now) =>
          upsertMember(state, { userId: 'a', userName: 'A' }, now),
      }),
      store.mutate(GROUP, {
        mutate: (state, now) =>
          upsertMember(state, { userId: 'b', userName: 'B' }, now),
      }),
      store.mutate(GROUP, {
        mutate: (state, now) =>
          upsertMember(state, { userId: 'c', userName: 'C' }, now),
      }),
    ]);

    const loaded = await store.readRoom(GROUP);
    expect(loaded.state?.members.map((item) => item.userId).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(loaded.state?.revision).toBe(3);
  });

  test('revision 冲突会重读重放', async () => {
    const redis = new ConflictOnceRedis();
    const store = createStore(redis);

    const result = await store.mutate(GROUP, {
      mutate: (state, now) =>
        upsertMember(state, { userId: 'u1', userName: 'A' }, now),
    });

    expect(result.changed).toBe(true);
    expect(result.state.members.map((item) => item.userId)).toEqual(['u1']);
    // 注入的 revision(+100) + 本次修改(+1)
    expect(result.state.revision).toBe(101);
  });

  test('锁被占用时超时报 MusicRoomLockTimeoutError', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis, { lockWaitMs: 0, lockRetryMs: 1 });
    await redis.set(store.lockKey(GROUP), 'other-node', 'PX', 60000);

    await expect(
      store.mutate(GROUP, { mutate: () => null })
    ).rejects.toBeInstanceOf(MusicRoomLockTimeoutError);
  });

  test('异常时不会残留锁', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);

    await expect(
      store.mutate(GROUP, {
        mutate: () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');

    expect(await redis.get(store.lockKey(GROUP))).toBeNull();
  });

  test('活跃房间索引会按 TTL 修剪过期房间', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis, { roomTtlMs: 1000 });

    await store.touchActive('g1', redis.now());
    redis.advance(500);
    await store.touchActive('g2', redis.now());

    expect(await store.listActive(redis.now())).toEqual(['g1', 'g2']);

    redis.advance(600);
    expect(await store.listActive(redis.now())).toEqual(['g2']);
  });

  test('写房间会带上 TTL', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis, { roomTtlMs: 5000 });

    await store.mutate(GROUP, { mutate: () => null });

    const pttl = await redis.pttl(store.roomKey(GROUP));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(5000);
  });

  test('广播租约同一节点可续期，其他节点无法抢占', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);

    expect(await store.acquireLeader('node-a', 6000)).toBe(true);
    expect(await store.acquireLeader('node-a', 6000)).toBe(true);
    expect(await store.acquireLeader('node-b', 6000)).toBe(false);

    redis.advance(7000);
    expect(await store.acquireLeader('node-b', 6000)).toBe(true);
  });

  test('损坏的房间数据按缺失处理并重建', async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    await redis.set(store.roomKey(GROUP), '{not-json', 'PX', 60000);

    const result = await store.mutate(GROUP, {
      mutate: (state, now) =>
        upsertMember(state, { userId: 'u1', userName: 'A' }, now),
    });

    expect(result.state.members).toHaveLength(1);
    const loaded = await store.readRoom(GROUP);
    expect(loaded.state?.members).toHaveLength(1);
  });
});

const describeRedis = process.env.REDIS_URL ? describe : describe.skip;

describeRedis('MusicRoomStore（真实 Redis，需要 REDIS_URL）', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RedisClient = require('ioredis');
  let redis: InstanceType<typeof RedisClient>;
  let store: MusicRoomStore;
  const groupId = `test-${Date.now()}`;

  beforeAll(async () => {
    redis = new RedisClient(process.env.REDIS_URL);
    await redis.ping();
    store = createStore(redis as unknown as RedisLike, { prefix: PREFIX });
  });

  afterAll(async () => {
    await redis.del(store.roomKey(groupId), store.activeKey(), store.lockKey(groupId));
    await redis.quit();
  });

  test('真实 Redis 上并发 mutate 不丢更新', async () => {
    await Promise.all([
      store.mutate(groupId, {
        mutate: (state, now) =>
          upsertMember(state, { userId: 'a', userName: 'A' }, now),
      }),
      store.mutate(groupId, {
        mutate: (state, now) =>
          upsertMember(state, { userId: 'b', userName: 'B' }, now),
      }),
    ]);

    const loaded = (await store.readRoom(groupId)).state as MusicRoomState;
    expect(loaded.members.map((item) => item.userId).sort()).toEqual(['a', 'b']);
  });
});
