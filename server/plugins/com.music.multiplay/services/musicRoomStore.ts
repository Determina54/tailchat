import { randomBytes } from 'crypto';
import type { MusicRoomState } from './musicRoomState';
import { createInitialState, normalizeState } from './musicRoomState';

/**
 * 仅依赖最少的 Redis 能力，便于用假实现做单测
 */
export interface RedisLike {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]>;
}

/**
 * 房间锁等待超时（可重试）
 */
export class MusicRoomLockTimeoutError extends Error {
  public readonly code = 'MUSIC_ROOM_LOCK_TIMEOUT';
  public readonly retryable = true;

  constructor(public readonly groupId: string) {
    super('音乐房间繁忙，请稍后重试');
  }
}

/**
 * 房间状态版本冲突（可重试）
 */
export class MusicRoomConflictError extends Error {
  public readonly code = 'MUSIC_ROOM_CONFLICT';
  public readonly retryable = true;

  constructor(public readonly groupId: string) {
    super('音乐房间状态冲突，请稍后重试');
  }
}

const TIME_SCRIPT = `
-- @op time
local t = redis.call('TIME')
return tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
`;

const READ_SCRIPT = `
-- @op room.read
local raw = redis.call('GET', KEYS[1])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if not raw then
  return { false, tostring(now) }
end
return { raw, tostring(now) }
`;

const CAS_SCRIPT = `
-- @op room.cas
local raw = redis.call('GET', KEYS[1])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if not raw then
  return { 0, tostring(now) }
end
local ok, doc = pcall(cjson.decode, raw)
if not ok or type(doc) ~= 'table' then
  return { 3, tostring(now) }
end
if tostring(doc.revision) ~= ARGV[1] then
  return { 1, tostring(now) }
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return { 2, tostring(now) }
`;

const SEED_SCRIPT = `
-- @op room.seed
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
return tostring(now)
`;

const PRUNE_SCRIPT = `
-- @op active.prune
return redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
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

const LEADER_SCRIPT = `
-- @op leader
local cur = redis.call('GET', KEYS[1])
if not cur then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return 1
end
if cur == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

export interface MusicRoomStoreOptions {
  /**
   * key 前缀，应包含部署命名空间（例如 `TC-plugin:com.music.multiplay:`）
   */
  prefix: string;
  roomTtlMs?: number;
  lockTtlMs?: number;
  lockWaitMs?: number;
  lockRetryMs?: number;
  maxCasAttempts?: number;
}

export interface MutateOptions {
  /**
   * Redis 缺失时的恢复来源（通常是 Mongo 快照）
   */
  restore?: () => Promise<MusicRoomState | null>;
  /**
   * 返回 null 或原对象表示不做修改
   */
  mutate: (
    state: MusicRoomState,
    now: number
  ) => MusicRoomState | null | undefined;
}

export interface MutateResult {
  state: MusicRoomState;
  now: number;
  changed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis 权威房间状态存储
 *
 * - 读：单次 Lua 原子返回 {状态, Redis 时钟}
 * - 写：房间分布式锁 + revision CAS + 有界重试
 * - 活跃房间索引：ZSET，便于广播时扫描而不必查库
 */
export class MusicRoomStore {
  private readonly prefix: string;
  private readonly roomTtlMs: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly maxCasAttempts: number;

  constructor(
    private readonly redis: RedisLike,
    options: MusicRoomStoreOptions
  ) {
    this.prefix = options.prefix;
    this.roomTtlMs = options.roomTtlMs ?? 6 * 60 * 60 * 1000;
    this.lockTtlMs = options.lockTtlMs ?? 3000;
    this.lockWaitMs = options.lockWaitMs ?? 1500;
    this.lockRetryMs = options.lockRetryMs ?? 60;
    this.maxCasAttempts = options.maxCasAttempts ?? 5;
  }

  get roomTtl(): number {
    return this.roomTtlMs;
  }

  roomKey(groupId: string): string {
    return `${this.prefix}room:${groupId}`;
  }

  activeKey(): string {
    return `${this.prefix}activeRooms`;
  }

  lockKey(groupId: string): string {
    return `${this.prefix}lock:${groupId}`;
  }

  leaderKey(): string {
    return `${this.prefix}leader`;
  }

  async now(): Promise<number> {
    const t = (await this.redis.eval(TIME_SCRIPT, 0)) as string;

    return Number(t);
  }

  async readRoom(
    groupId: string
  ): Promise<{ state: MusicRoomState | null; now: number }> {
    const result = (await this.redis.eval(
      READ_SCRIPT,
      1,
      this.roomKey(groupId)
    )) as [string | false | null, string];

    const now = Number(result?.[1]);
    const raw = result?.[0];
    if (!raw) {
      return { state: null, now: Number.isFinite(now) ? now : Date.now() };
    }

    try {
      const parsed = JSON.parse(String(raw));
      return { state: normalizeState(parsed, groupId, now), now };
    } catch {
      return { state: null, now: Number.isFinite(now) ? now : Date.now() };
    }
  }

  /**
   * 强制写入（用于从 Mongo 恢复），不校验 revision
   */
  async seedRoom(groupId: string, state: MusicRoomState): Promise<number> {
    const nowRaw = (await this.redis.eval(
      SEED_SCRIPT,
      1,
      this.roomKey(groupId),
      JSON.stringify(state),
      String(this.roomTtlMs)
    )) as string;

    const now = Number(nowRaw);
    await this.touchActive(groupId, Number.isFinite(now) ? now : Date.now());

    return Number.isFinite(now) ? now : Date.now();
  }

  private async casWrite(
    groupId: string,
    state: MusicRoomState,
    expectedRevision: number
  ): Promise<{
    ok: boolean;
    conflict: boolean;
    missing: boolean;
    corrupt: boolean;
    now: number;
  }> {
    const result = (await this.redis.eval(
      CAS_SCRIPT,
      1,
      this.roomKey(groupId),
      String(expectedRevision),
      JSON.stringify(state),
      String(this.roomTtlMs)
    )) as [number, string];

    const code = Number(result?.[0]);
    return {
      ok: code === 2,
      conflict: code === 1,
      missing: code === 0,
      corrupt: code === 3,
      now: Number(result?.[1]),
    };
  }

  async touchActive(groupId: string, now: number): Promise<void> {
    await this.redis.zadd(this.activeKey(), now, groupId);
    await this.redis.eval(
      PRUNE_SCRIPT,
      1,
      this.activeKey(),
      String(now - this.roomTtlMs)
    );
  }

  async listActive(now: number): Promise<string[]> {
    return await this.redis.zrangebyscore(
      this.activeKey(),
      now - this.roomTtlMs,
      '+inf'
    );
  }

  /**
   * 获取/续期广播租约
   */
  async acquireLeader(nodeId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(
      LEADER_SCRIPT,
      1,
      this.leaderKey(),
      nodeId,
      String(ttlMs)
    );

    return Number(result) === 1;
  }

  private async acquireLock(
    groupId: string,
    token: string
  ): Promise<boolean> {
    const result = await this.redis.eval(
      LOCK_ACQUIRE_SCRIPT,
      1,
      this.lockKey(groupId),
      token,
      String(this.lockTtlMs)
    );

    return Number(result) === 1;
  }

  private async releaseLock(groupId: string, token: string): Promise<void> {
    await this.redis.eval(
      LOCK_RELEASE_SCRIPT,
      1,
      this.lockKey(groupId),
      token
    );
  }

  private async withRoomLock<T>(
    groupId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + this.lockWaitMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (await this.acquireLock(groupId, token)) {
        break;
      }

      if (Date.now() >= deadline) {
        throw new MusicRoomLockTimeoutError(groupId);
      }

      await sleep(this.lockRetryMs);
    }

    try {
      return await fn();
    } finally {
      await this.releaseLock(groupId, token);
    }
  }

  /**
   * 房间状态的条件更新入口
   *
   * mutate 在锁内执行，写入使用 revision CAS；冲突时重读重放。
   */
  async mutate(
    groupId: string,
    options: MutateOptions
  ): Promise<MutateResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      try {
        const result = await this.withRoomLock(groupId, async () => {
          const loaded = await this.readRoom(groupId);
          let state = loaded.state;
          let now = loaded.now;

          if (!state) {
            const restored = options.restore ? await options.restore() : null;
            state = restored
              ? normalizeState(restored, groupId, now)
              : createInitialState(groupId, now);
            now = await this.seedRoom(groupId, state);
          }

          const next = options.mutate(state, now);
          if (!next || next === state) {
            return { state, now, changed: false };
          }

          const written: MusicRoomState = {
            ...next,
            revision: state.revision + 1,
            updatedAt: now,
          };
          const writeResult = await this.casWrite(
            groupId,
            written,
            state.revision
          );

          if (writeResult.ok) {
            await this.touchActive(groupId, writeResult.now);
            return { state: written, now: writeResult.now, changed: true };
          }

          throw new MusicRoomConflictError(groupId);
        });

        return result;
      } catch (error) {
        lastError = error;
        if (
          error instanceof MusicRoomConflictError && // 仅在冲突时重试
          attempt < this.maxCasAttempts - 1
        ) {
          await sleep(this.lockRetryMs);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new MusicRoomConflictError(groupId);
  }
}

export default MusicRoomStore;
