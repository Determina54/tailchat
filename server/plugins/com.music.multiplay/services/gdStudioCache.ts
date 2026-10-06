/**
 * GD Studio 分布式缓存
 *
 * 设计目标：
 * - 多节点共享缓存与单飞锁，避免同一份数据被多个节点重复请求（GD 官方限流 5 分钟 50 次）
 * - url 类数据临近过期时提前刷新（刷新失败保留 stale）
 * - 4xx/5xx 与解析失败不写缓存
 * - Redis 不可用时明确降级为进程内缓存 + 每节点预算，并记录日志
 */

export interface GdCacheRedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  pttl(key: string): Promise<number>;
}

export interface GdCacheLogger {
  warn: (message: string, ...args: unknown[]) => void;
}

export interface GdCacheOptions {
  /**
   * 已包含部署命名空间的 key 前缀（例如 `TC-plugin:com.music.multiplay:`）
   */
  prefix: string;
  /**
   * 抢不到锁时的最长等待时间，应大于单次上游请求耗时
   */
  lockWaitMs?: number;
  lockRetryMs?: number;
  lockTtlMs?: number;
  /**
   * 上游滑动窗口预算
   */
  maxRequestsPerWindow?: number;
  windowMs?: number;
  logger?: GdCacheLogger;
}

export interface GdCacheGetOptions {
  ttlMs: number;
  /**
   * 剩余 TTL 低于该值时视为需要刷新（用于会过期的播放链接）
   */
  refreshThresholdMs?: number;
}

export interface GdCache {
  get<T>(
    cacheKey: string,
    options: GdCacheGetOptions,
    fetcher: () => Promise<T>
  ): Promise<T>;
}

/**
 * 上游预算耗尽
 */
export class GdStudioBusyError extends Error {
  public readonly code = 'MUSIC_PROVIDER_BUSY';

  constructor(message = '音乐服务繁忙，请稍后重试') {
    super(message);
  }
}

const BUDGET_SCRIPT = `
-- @op budget
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return 0
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], windowMs)
return 1
`;

const LOCK_ACQUIRE_SCRIPT = `
-- @op lock.acquire
local ok = redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]), 'NX')
if ok then
  return 1
end
return 0
`;

const LOCK_RELEASE_SCRIPT = `
-- @op lock.release
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface CacheRecord<T = unknown> {
  value: T;
  at: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParse<T>(raw: string | null): CacheRecord<T> | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as CacheRecord<T>;
    if (parsed && typeof parsed === 'object' && 'value' in parsed) {
      return parsed;
    }
  } catch {
    // ignore
  }

  return undefined;
}

/**
 * 基于 Redis 的共享缓存 + 单飞锁 + 滑动窗口预算
 */
export class RedisGdStudioCache implements GdCache {
  private readonly prefix: string;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly lockTtlMs: number;
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  private readonly logger?: GdCacheLogger;
  private readonly fallback: InProcessGdStudioCache;
  private lastWarnAt = 0;

  constructor(
    private readonly redis: GdCacheRedisLike,
    options: GdCacheOptions
  ) {
    this.prefix = options.prefix;
    this.lockWaitMs = options.lockWaitMs ?? 6000;
    this.lockRetryMs = options.lockRetryMs ?? 150;
    this.lockTtlMs = options.lockTtlMs ?? 8000;
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 50;
    this.windowMs = options.windowMs ?? 5 * 60 * 1000;
    this.logger = options.logger;
    // Redis 运行期故障时 fail-open 到进程内实现
    this.fallback = new InProcessGdStudioCache({
      maxRequestsPerWindow: this.maxRequestsPerWindow,
      windowMs: this.windowMs,
      logger: options.logger,
    });
  }

  private warnThrottled(message: string, error?: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60 * 1000) {
      return;
    }

    this.lastWarnAt = now;
    this.logger?.warn(`[music:gd-cache] ${message}`, error);
  }

  private cacheKey(cacheKey: string): string {
    return `${this.prefix}${cacheKey}`;
  }

  private lockKey(cacheKey: string): string {
    return `${this.prefix}music-lock:${cacheKey}`;
  }

  private budgetKey(): string {
    return `${this.prefix}gd:budget`;
  }

  private async acquireLock(key: string, token: string): Promise<boolean> {
    const result = await this.redis.eval(
      LOCK_ACQUIRE_SCRIPT,
      1,
      key,
      token,
      String(this.lockTtlMs)
    );

    return Number(result) === 1;
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token);
  }

  private async consumeBudget(token: string): Promise<boolean> {
    const result = await this.redis.eval(
      BUDGET_SCRIPT,
      1,
      this.budgetKey(),
      String(this.windowMs),
      String(this.maxRequestsPerWindow),
      token
    );

    return Number(result) === 1;
  }

  private async readRecord<T>(
    key: string
  ): Promise<{ record?: CacheRecord<T>; pttl: number }> {
    const values = await Promise.all([
      this.redis.get(key),
      this.redis.pttl(key),
    ]);

    return { record: safeParse<T>(values[0]), pttl: values[1] };
  }

  async get<T>(
    cacheKey: string,
    options: GdCacheGetOptions,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const key = this.cacheKey(cacheKey);
    const lockKey = this.lockKey(cacheKey);

    let stale: T | undefined;
    let needRefresh = true;

    try {
      const { record, pttl } = await this.readRecord<T>(key);
      if (record) {
        stale = record.value;
        const nearExpiry =
          options.refreshThresholdMs != null &&
          pttl >= 0 &&
          pttl < options.refreshThresholdMs;
        needRefresh = nearExpiry;
      }

      if (record && !needRefresh) {
        return record.value;
      }
    } catch (error) {
      // Redis 读失败：降级为进程内实现
      this.warnThrottled('Redis 读取失败，降级为进程内缓存', error);
      return await this.fallback.get(cacheKey, options, fetcher);
    }

    const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
    const deadline = Date.now() + this.lockWaitMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let locked = false;
      try {
        locked = await this.acquireLock(lockKey, token);
      } catch (error) {
        this.warnThrottled('Redis 加锁失败，降级为进程内缓存', error);
        return await this.fallback.get(cacheKey, options, fetcher);
      }

      if (locked) {
        let budgetOk: boolean;
        try {
          budgetOk = await this.consumeBudget(token);
        } catch (error) {
          this.warnThrottled('Redis 预算检查失败，降级为进程内缓存', error);
          await this.releaseLock(lockKey, token).catch(() => undefined);
          return await this.fallback.get(cacheKey, options, fetcher);
        }

        try {
          if (!budgetOk) {
            if (stale !== undefined) {
              return stale;
            }

            throw new GdStudioBusyError();
          }

          const value = await fetcher();
          const record: CacheRecord<T> = { value, at: Date.now() };
          await this.redis
            .set(key, JSON.stringify(record), 'PX', options.ttlMs)
            .catch((error) => {
              this.warnThrottled('写入缓存失败', error);
            });
          return value;
        } catch (error) {
          if (stale !== undefined) {
            this.warnThrottled('刷新失败，返回 stale 数据', error);
            return stale;
          }

          throw error;
        } finally {
          await this.releaseLock(lockKey, token).catch(() => undefined);
        }
      }

      if (Date.now() >= deadline) {
        break;
      }

      await sleep(this.lockRetryMs);

      try {
        const { record } = await this.readRecord<T>(key);
        if (record) {
          return record.value;
        }
      } catch {
        break;
      }
    }

    if (stale !== undefined) {
      return stale;
    }

    // 锁竞争超时且无 stale：直接请求一次，仍受预算约束
    let budgetOk: boolean;
    try {
      budgetOk = await this.consumeBudget(`${token}-fallback`);
    } catch (error) {
      this.warnThrottled('Redis 预算检查失败，降级为进程内缓存', error);
      return await this.fallback.get(cacheKey, options, fetcher);
    }

    if (!budgetOk) {
      throw new GdStudioBusyError();
    }

    const value = await fetcher();
    await this.redis
      .set(
        key,
        JSON.stringify({ value, at: Date.now() } as CacheRecord<T>),
        'PX',
        options.ttlMs
      )
      .catch(() => undefined);

    return value;
  }
}

/**
 * Redis 不可用时的进程内降级实现
 */
export class InProcessGdStudioCache implements GdCache {
  private readonly cache = new Map<string, { record: CacheRecord; expiresAt: number }>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly budget: number[] = [];
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  private readonly logger?: GdCacheLogger;
  private lastWarnAt = 0;

  constructor(options: Pick<GdCacheOptions, 'maxRequestsPerWindow' | 'windowMs' | 'logger'>) {
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 50;
    this.windowMs = options.windowMs ?? 5 * 60 * 1000;
    this.logger = options.logger;
  }

  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60 * 1000) {
      return;
    }

    this.lastWarnAt = now;
    this.logger?.warn(`[music:gd-cache:in-process] ${message}`);
  }

  private consumeBudget(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.budget.length > 0 && this.budget[0] <= cutoff) {
      this.budget.shift();
    }

    if (this.budget.length >= this.maxRequestsPerWindow) {
      return false;
    }

    this.budget.push(now);
    return true;
  }

  async get<T>(
    cacheKey: string,
    options: GdCacheGetOptions,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const entry = this.cache.get(cacheKey);
    const now = Date.now();
    const fresh =
      entry && entry.expiresAt > now
        ? (entry.record as CacheRecord<T>)
        : undefined;
    const nearExpiry =
      entry &&
      options.refreshThresholdMs != null &&
      entry.expiresAt - now < options.refreshThresholdMs;

    if (fresh && !nearExpiry) {
      return fresh.value;
    }

    const existing = this.locks.get(cacheKey);
    if (existing) {
      try {
        return (await existing) as T;
      } catch (error) {
        if (fresh) {
          return fresh.value;
        }

        throw error;
      }
    }

    const task = (async () => {
      if (!this.consumeBudget()) {
        if (fresh) {
          return fresh.value;
        }

        throw new GdStudioBusyError();
      }

      const value = await fetcher();
      this.cache.set(cacheKey, {
        record: { value, at: now },
        expiresAt: Date.now() + options.ttlMs,
      });
      return value;
    })()
      .catch((error) => {
        if (fresh) {
          this.warnThrottled('刷新失败，返回 stale 数据');
          return fresh.value as T;
        }

        throw error;
      })
      .finally(() => {
        this.locks.delete(cacheKey);
      });

    this.locks.set(cacheKey, task);
    return await task;
  }
}

/**
 * 根据 Redis 可用性创建缓存实现
 */
export function createGdStudioCache(
  redis: GdCacheRedisLike | null,
  options: GdCacheOptions
): GdCache {
  if (redis) {
    return new RedisGdStudioCache(redis, options);
  }

  options.logger?.warn(
    '[music:gd-cache] Redis 不可用，降级为进程内缓存与每节点预算'
  );

  return new InProcessGdStudioCache(options);
}

export default createGdStudioCache;
