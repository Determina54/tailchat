/**
 * 测试用的内存 Redis 假实现
 *
 * 只覆盖本插件实际用到的命令与 Lua 脚本（脚本以 `-- @op <name>` 标记区分）。
 * 它不解释 Lua，而是按脚本标记复刻同样的语义，用于验证调用方的编排逻辑
 * （CAS 重试、锁、单飞、滑动窗口预算等）。
 */

interface Entry {
  value: string;
  expiresAt?: number;
}

export class FakeRedis {
  private readonly strings = new Map<string, Entry>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private clockMs: number;

  constructor(now = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.clockMs = now;
  }

  /** 当前（可控）时间 */
  now(): number {
    return this.clockMs;
  }

  advance(ms: number): void {
    this.clockMs += ms;
  }

  private isAlive(entry: Entry | undefined): entry is Entry {
    if (!entry) {
      return false;
    }

    if (entry.expiresAt != null && entry.expiresAt <= this.clockMs) {
      return false;
    }

    return true;
  }

  private dropIfExpired(key: string): void {
    const entry = this.strings.get(key);
    if (entry && !this.isAlive(entry)) {
      this.strings.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.dropIfExpired(key);
    return this.strings.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const upper = args.map((item) => String(item).toUpperCase());
    const pxIndex = upper.indexOf('PX');
    const ttlMs = pxIndex >= 0 ? Number(args[pxIndex + 1]) : undefined;
    const isNx = upper.includes('NX');

    this.dropIfExpired(key);
    if (isNx && this.strings.has(key)) {
      return null;
    }

    this.strings.set(key, {
      value,
      expiresAt: ttlMs != null ? this.clockMs + ttlMs : undefined,
    });

    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) {
        removed += 1;
      }
      if (this.zsets.delete(key)) {
        removed += 1;
      }
    }

    return removed;
  }

  async pttl(key: string): Promise<number> {
    this.dropIfExpired(key);
    const entry = this.strings.get(key);
    if (!entry) {
      return -2;
    }

    if (entry.expiresAt == null) {
      return -1;
    }

    return Math.max(0, entry.expiresAt - this.clockMs);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.dropIfExpired(key);
    const entry = this.strings.get(key);
    if (!entry) {
      return 0;
    }

    entry.expiresAt = this.clockMs + ms;
    return 1;
  }

  private touchExpiry(key: string, ttlMs: number): void {
    const entry = this.strings.get(key);
    if (entry) {
      entry.expiresAt = this.clockMs + ttlMs;
    }
  }

  private async incr(key: string, ttlMs: number): Promise<number> {
    this.dropIfExpired(key);
    const entry = this.strings.get(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    this.strings.set(key, {
      value: String(next),
      expiresAt:
        entry?.expiresAt != null ? entry.expiresAt : this.clockMs + ttlMs,
    });

    return next;
  }

  async zadd(key: string, score: number, member: string): Promise<unknown> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }

    const existed = set.has(member);
    set.set(member, score);

    return existed ? 0 : 1;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]> {
    const set = this.zsets.get(key);
    if (!set) {
      return [];
    }

    const minValue = min === '-inf' ? -Infinity : Number(min);
    const maxValue = max === '+inf' ? Infinity : Number(max);

    return [...set.entries()]
      .filter(([, score]) => score >= minValue && score <= maxValue)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  private zremrangebyscore(key: string, min: string, max: string): number {
    const set = this.zsets.get(key);
    if (!set) {
      return 0;
    }

    const minValue = min === '-inf' ? -Infinity : Number(min);
    const maxValue = max === '+inf' ? Infinity : Number(max);
    let removed = 0;

    for (const [member, score] of [...set.entries()]) {
      if (score >= minValue && score <= maxValue) {
        set.delete(member);
        removed += 1;
      }
    }

    return removed;
  }

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const op = /-- @op ([\w.]+)/.exec(script)?.[1];
    const keys = args.slice(0, numberOfKeys).map(String);
    const rest = args.slice(numberOfKeys);

    switch (op) {
      case 'time':
        return String(this.clockMs);

      case 'room.read': {
        const raw = await this.get(keys[0]);
        return [raw ?? false, String(this.clockMs)];
      }

      case 'room.cas': {
        const expected = String(rest[0]);
        const payload = String(rest[1]);
        const ttlMs = Number(rest[2]);
        const raw = await this.get(keys[0]);
        if (!raw) {
          return [0, String(this.clockMs)];
        }

        let doc: { revision?: number };
        try {
          doc = JSON.parse(raw);
        } catch {
          return [3, String(this.clockMs)];
        }

        if (String(doc.revision) !== expected) {
          return [1, String(this.clockMs)];
        }

        await this.set(keys[0], payload, 'PX', ttlMs);
        return [2, String(this.clockMs)];
      }

      case 'room.seed': {
        const payload = String(rest[0]);
        const ttlMs = Number(rest[1]);
        await this.set(keys[0], payload, 'PX', ttlMs);
        return String(this.clockMs);
      }

      case 'active.prune':
        return this.zremrangebyscore(keys[0], '-inf', String(rest[0]));

      case 'lock.acquire': {
        const result = await this.set(
          keys[0],
          String(rest[0]),
          'PX',
          Number(rest[1]),
          'NX'
        );
        return result === 'OK' ? 1 : 0;
      }

      case 'lock.release': {
        const current = await this.get(keys[0]);
        if (current === String(rest[0])) {
          await this.del(keys[0]);
          return 1;
        }

        return 0;
      }

      case 'leader': {
        const current = await this.get(keys[0]);
        const ttlMs = Number(rest[1]);
        if (!current) {
          await this.set(keys[0], String(rest[0]), 'PX', ttlMs);
          return 1;
        }

        if (current === String(rest[0])) {
          await this.pexpire(keys[0], ttlMs);
          return 1;
        }

        return 0;
      }

      case 'budget': {
        const windowMs = Number(rest[0]);
        const limit = Number(rest[1]);
        const member = String(rest[2]);
        const key = keys[0];

        this.zremrangebyscore(key, '-inf', String(this.clockMs - windowMs));
        const set = this.zsets.get(key) ?? new Map<string, number>();
        if (set.size >= limit) {
          return 0;
        }

        set.set(member, this.clockMs);
        this.zsets.set(key, set);
        return 1;
      }

      case 'rate.consume': {
        const cooldownMs = Number(rest[0]);
        const perMinute = Number(rest[1]);

        if (cooldownMs > 0) {
          const pttl = await this.pttl(keys[0]);
          if (pttl > 0) {
            return [1, pttl];
          }
        }

        const count = await this.incr(keys[1], 60000);
        if (count > perMinute) {
          return [2, await this.pttl(keys[1])];
        }

        if (cooldownMs > 0) {
          await this.set(keys[0], '1', 'PX', cooldownMs);
        }

        return [0, 0];
      }

      default:
        throw new Error(`FakeRedis 未实现脚本: ${op ?? script.slice(0, 40)}`);
    }
  }
}

export default FakeRedis;
