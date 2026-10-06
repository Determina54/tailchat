import FakeRedis from './fakeRedis';
import {
  GdStudioBusyError,
  InProcessGdStudioCache,
  RedisGdStudioCache,
} from '../services/gdStudioCache';
import type { GdCacheRedisLike } from '../services/gdStudioCache';

const PREFIX = 'test-plugin:com.music.multiplay:';

function createRedisCache(
  redis: FakeRedis,
  options: Record<string, number> = {}
): RedisGdStudioCache {
  return new RedisGdStudioCache(redis as unknown as GdCacheRedisLike, {
    prefix: PREFIX,
    lockWaitMs: 1000,
    lockRetryMs: 10,
    lockTtlMs: 2000,
    ...options,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GdStudioCache（Redis 路径）', () => {
  test('命中缓存时不再请求上游', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis);
    const fetcher = jest.fn().mockResolvedValue({ value: 1 });

    const first = await cache.get('music:search:a', { ttlMs: 60000 }, fetcher);
    const second = await cache.get('music:search:a', { ttlMs: 60000 }, fetcher);

    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('单飞：并发 miss 只调用一次上游', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis);
    const fetcher = jest.fn().mockImplementation(async () => {
      await sleep(20);
      return { value: 'shared' };
    });

    const [a, b, c] = await Promise.all([
      cache.get('music:lyric:x', { ttlMs: 60000 }, fetcher),
      cache.get('music:lyric:x', { ttlMs: 60000 }, fetcher),
      cache.get('music:lyric:x', { ttlMs: 60000 }, fetcher),
    ]);

    expect(a).toEqual({ value: 'shared' });
    expect(b).toEqual({ value: 'shared' });
    expect(c).toEqual({ value: 'shared' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('剩余 TTL 低于阈值时会提前刷新', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis);
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ url: 'v1' })
      .mockResolvedValueOnce({ url: 'v2' });

    const first = await cache.get(
      'music:url:x',
      { ttlMs: 1000, refreshThresholdMs: 300 },
      fetcher
    );
    expect(first).toEqual({ url: 'v1' });

    redis.advance(800);
    const second = await cache.get(
      'music:url:x',
      { ttlMs: 1000, refreshThresholdMs: 300 },
      fetcher
    );

    expect(second).toEqual({ url: 'v2' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('刷新失败时保留 stale 数据', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis);
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ url: 'v1' })
      .mockRejectedValueOnce(new Error('upstream down'));

    await cache.get(
      'music:url:stale',
      { ttlMs: 1000, refreshThresholdMs: 500 },
      fetcher
    );

    redis.advance(700);
    const stale = await cache.get(
      'music:url:stale',
      { ttlMs: 1000, refreshThresholdMs: 500 },
      fetcher
    );

    expect(stale).toEqual({ url: 'v1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('失败结果不会被缓存', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis);
    const fetcher = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    await expect(
      cache.get('music:pic:err', { ttlMs: 60000 }, fetcher)
    ).rejects.toThrow('boom');

    const value = await cache.get('music:pic:err', { ttlMs: 60000 }, fetcher);
    expect(value).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('超出滑动窗口预算时抛出 GdStudioBusyError', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis, {
      maxRequestsPerWindow: 1,
      windowMs: 60000,
    });
    const fetcher = jest.fn().mockResolvedValue({ ok: true });

    await cache.get('music:search:1', { ttlMs: 60000 }, fetcher);

    await expect(
      cache.get('music:search:2', { ttlMs: 60000 }, fetcher)
    ).rejects.toBeInstanceOf(GdStudioBusyError);
  });

  test('预算超限但存在 stale 时返回 stale', async () => {
    const redis = new FakeRedis();
    const cache = createRedisCache(redis, {
      maxRequestsPerWindow: 1,
      windowMs: 60000,
    });
    const fetcher = jest.fn().mockResolvedValue({ url: 'v1' });

    await cache.get(
      'music:url:budget',
      { ttlMs: 1000, refreshThresholdMs: 900 },
      fetcher
    );

    redis.advance(500);
    const value = await cache.get(
      'music:url:budget',
      { ttlMs: 1000, refreshThresholdMs: 900 },
      fetcher
    );

    expect(value).toEqual({ url: 'v1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('Redis 读取异常时降级为进程内缓存', async () => {
    const broken = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => undefined,
      eval: async () => {
        throw new Error('redis down');
      },
      del: async () => 0,
      pttl: async () => {
        throw new Error('redis down');
      },
    } as unknown as GdCacheRedisLike;

    const cache = new RedisGdStudioCache(broken, { prefix: PREFIX });
    const fetcher = jest.fn().mockResolvedValue({ ok: true });

    const value = await cache.get('music:search:fb', { ttlMs: 1000 }, fetcher);
    expect(value).toEqual({ ok: true });
  });
});

describe('GdStudioCache（进程内降级实现）', () => {
  test('单飞：并发 miss 只调用一次上游', async () => {
    const cache = new InProcessGdStudioCache({ maxRequestsPerWindow: 50 });
    const fetcher = jest.fn().mockImplementation(async () => {
      await sleep(20);
      return 'value';
    });

    const results = await Promise.all([
      cache.get('k', { ttlMs: 1000 }, fetcher),
      cache.get('k', { ttlMs: 1000 }, fetcher),
      cache.get('k', { ttlMs: 1000 }, fetcher),
    ]);

    expect(results).toEqual(['value', 'value', 'value']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('预算耗尽时抛出 GdStudioBusyError', async () => {
    const cache = new InProcessGdStudioCache({ maxRequestsPerWindow: 1 });
    const fetcher = jest.fn().mockResolvedValue('value');

    await cache.get('a', { ttlMs: 1000 }, fetcher);

    await expect(
      cache.get('b', { ttlMs: 1000 }, fetcher)
    ).rejects.toBeInstanceOf(GdStudioBusyError);
  });

  test('刷新失败时返回 stale', async () => {
    const cache = new InProcessGdStudioCache({ maxRequestsPerWindow: 50 });
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce('v1')
      .mockRejectedValueOnce(new Error('down'));

    await cache.get('k', { ttlMs: 1000, refreshThresholdMs: 500 }, fetcher);
    await sleep(200);

    const value = await cache.get(
      'k',
      { ttlMs: 1000, refreshThresholdMs: 900 },
      fetcher
    );

    expect(value).toBe('v1');
  });
});
