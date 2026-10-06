import FakeRedis from './fakeRedis';
import {
  MUSIC_CONTROL_LIMITS,
  MusicControlRateLimiter,
} from '../services/rateLimit';
import type { RateLimitRedisLike } from '../services/rateLimit';

const PREFIX = 'test-plugin:com.music.multiplay:';

function createLimiter(redis: FakeRedis): MusicControlRateLimiter {
  return new MusicControlRateLimiter(
    redis as unknown as RateLimitRedisLike,
    PREFIX
  );
}

describe('MusicControlRateLimiter', () => {
  test('首次控制放行', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);

    const result = await limiter.consume({
      groupId: 'g1',
      userId: 'u1',
      action: 'play',
    });

    expect(result.allowed).toBe(true);
  });

  test('play/pause/seek 有 5 秒冷却且冷却过期后恢复', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);
    const params = { groupId: 'g1', userId: 'u1', action: 'seek' };

    expect((await limiter.consume(params)).allowed).toBe(true);

    const blocked = await limiter.consume(params);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('cooldown');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    redis.advance(5100);
    expect((await limiter.consume(params)).allowed).toBe(true);
  });

  test('next/prev 没有冷却但共享传输窗口', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);

    for (let index = 0; index < 9; index += 1) {
      const result = await limiter.consume({
        groupId: 'g1',
        userId: 'u1',
        action: 'next',
      });
      expect(result.allowed).toBe(true);
    }

    // 传输桶共 10 次/分钟
    const last = await limiter.consume({
      groupId: 'g1',
      userId: 'u1',
      action: 'prev',
    });
    expect(last.allowed).toBe(true);

    const blocked = await limiter.consume({
      groupId: 'g1',
      userId: 'u1',
      action: 'next',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('window');
  });

  test('窗口按分钟滚动', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);
    const params = { groupId: 'g1', userId: 'u1', action: 'next' };

    for (let index = 0; index < 10; index += 1) {
      await limiter.consume(params);
    }
    expect((await limiter.consume(params)).allowed).toBe(false);

    redis.advance(60001);
    expect((await limiter.consume(params)).allowed).toBe(true);
  });

  test('不同用户、不同房间相互隔离', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);

    for (let index = 0; index < 10; index += 1) {
      await limiter.consume({ groupId: 'g1', userId: 'u1', action: 'next' });
    }

    expect(
      (
        await limiter.consume({
          groupId: 'g1',
          userId: 'u2',
          action: 'next',
        })
      ).allowed
    ).toBe(true);

    expect(
      (
        await limiter.consume({
          groupId: 'g2',
          userId: 'u1',
          action: 'next',
        })
      ).allowed
    ).toBe(true);
  });

  test('add 使用独立的 30 次/分钟 桶', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);

    for (let index = 0; index < 10; index += 1) {
      await limiter.consume({ groupId: 'g1', userId: 'u1', action: 'next' });
    }

    // 传输桶已满，但点歌不受影响
    const add = await limiter.consume({
      groupId: 'g1',
      userId: 'u1',
      action: 'add',
    });
    expect(add.allowed).toBe(true);

    for (let index = 0; index < 29; index += 1) {
      await limiter.consume({ groupId: 'g1', userId: 'u1', action: 'add' });
    }
    expect(
      (
        await limiter.consume({
          groupId: 'g1',
          userId: 'u1',
          action: 'add',
        })
      ).allowed
    ).toBe(false);
  });

  test('未配置限流的 action 直接放行', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);

    expect(
      (
        await limiter.consume({
          groupId: 'g1',
          userId: 'u1',
          action: 'join',
        })
      ).allowed
    ).toBe(true);
  });

  test('限流 key 带部署命名空间', async () => {
    const redis = new FakeRedis();
    const limiter = createLimiter(redis);

    await limiter.consume({ groupId: 'g1', userId: 'u1', action: 'volume' });

    expect(await redis.get(`${PREFIX}rate:window:transport:g1:u1`)).toBe('1');
  });

  test('策略表包含全部控制 action', () => {
    for (const action of [
      'play',
      'pause',
      'seek',
      'next',
      'prev',
      'volume',
      'add',
      'remove',
      'clear',
      'mute',
    ]) {
      expect(MUSIC_CONTROL_LIMITS[action]).toBeDefined();
    }
  });
});
