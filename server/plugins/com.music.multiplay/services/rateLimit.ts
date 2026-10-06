/**
 * 音乐控制操作限流
 *
 * 语义（每用户 / 每房间）：
 * - 传输类（play/pause/seek/next/prev/volume）共享一个 10 次/分钟 的桶
 * - play/pause/seek 额外有 5 秒冷却
 * - 点歌 add 单独 30 次/分钟（避免连续点歌被限流）
 * - 队列管理（remove/clear）与禁播（mute）各自 10 次/分钟
 *
 * 计数与冷却的时间基准均来自 Redis TIME，避免节点时钟偏移。
 */

export interface RateLimitRedisLike {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export interface MusicControlLimit {
  /**
   * 共享桶名：同一桶内的操作共用窗口计数
   */
  bucket: string;
  perMinute: number;
  cooldownMs?: number;
}

export const MUSIC_CONTROL_LIMITS: Record<string, MusicControlLimit> = {
  play: { bucket: 'transport', perMinute: 10, cooldownMs: 5000 },
  pause: { bucket: 'transport', perMinute: 10, cooldownMs: 5000 },
  seek: { bucket: 'transport', perMinute: 10, cooldownMs: 5000 },
  next: { bucket: 'transport', perMinute: 10 },
  prev: { bucket: 'transport', perMinute: 10 },
  volume: { bucket: 'transport', perMinute: 10 },
  add: { bucket: 'add', perMinute: 30 },
  remove: { bucket: 'queue', perMinute: 10 },
  clear: { bucket: 'queue', perMinute: 10 },
  mute: { bucket: 'mute', perMinute: 10 },
};

export interface RateLimitResult {
  allowed: boolean;
  reason?: 'cooldown' | 'window';
  retryAfterMs: number;
}

export class MusicControlUnavailableError extends Error {
  public readonly code = 'MUSIC_CONTROL_UNAVAILABLE';

  constructor(message = '音乐控制服务暂不可用') {
    super(message);
  }
}

const CONSUME_SCRIPT = `
-- @op rate.consume
local cooldownMs = tonumber(ARGV[1])
local perMinute = tonumber(ARGV[2])
if cooldownMs > 0 then
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl and pttl > 0 then
    return { 1, pttl }
  end
end
local count = redis.call('INCR', KEYS[2])
if count == 1 then
  redis.call('PEXPIRE', KEYS[2], 60000)
end
if count > perMinute then
  return { 2, redis.call('PTTL', KEYS[2]) }
end
if cooldownMs > 0 then
  redis.call('SET', KEYS[1], '1', 'PX', cooldownMs)
end
return { 0, 0 }
`;

export interface ConsumeParams {
  groupId: string;
  userId: string;
  action: string;
}

export class MusicControlRateLimiter {
  constructor(
    private readonly redis: RateLimitRedisLike,
    private readonly prefix: string
  ) {}

  static getLimit(action: string): MusicControlLimit | undefined {
    return MUSIC_CONTROL_LIMITS[action];
  }

  private cooldownKey(params: ConsumeParams): string {
    return `${this.prefix}rate:cooldown:${params.groupId}:${params.userId}:${params.action}`;
  }

  private windowKey(params: ConsumeParams, bucket: string): string {
    return `${this.prefix}rate:window:${bucket}:${params.groupId}:${params.userId}`;
  }

  /**
   * 未配置限流的 action 直接放行
   */
  async consume(params: ConsumeParams): Promise<RateLimitResult> {
    const limit = MusicControlRateLimiter.getLimit(params.action);
    if (!limit) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const result = (await this.redis.eval(
      CONSUME_SCRIPT,
      2,
      this.cooldownKey(params),
      this.windowKey(params, limit.bucket),
      String(limit.cooldownMs ?? 0),
      String(limit.perMinute)
    )) as [number, number];

    const code = Number(result?.[0]);
    const retryAfterMs = Number(result?.[1]) || 0;

    if (code === 1) {
      return { allowed: false, reason: 'cooldown', retryAfterMs };
    }

    if (code === 2) {
      return { allowed: false, reason: 'window', retryAfterMs };
    }

    return { allowed: true, retryAfterMs: 0 };
  }
}

export default MusicControlRateLimiter;
