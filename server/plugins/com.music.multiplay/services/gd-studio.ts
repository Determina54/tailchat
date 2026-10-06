import got from 'got';
import type { GdCache } from './gdStudioCache';

/**
 * GD Studio 在线音乐 API 代理
 *
 * 官方接口（https://music-api.gdstudio.xyz/api.php）：
 * - search: 顶层数组，字段 id/name/artist(数组)/album/pic_id/url_id/lyric_id/source
 * - url:    { url, br, size }
 * - pic:    { url }
 * - lyric:  { lyric, tlyric? }
 * - 非法 source 返回 400 {"detail":"..."}
 * - 限流：5 分钟内不超过 50 次请求
 *
 * NOTICE: 本文件只负责协议与解析，缓存/单飞/预算在 gdStudioCache.ts 中实现
 */

export type MusicSource = 'netease' | 'joox' | 'bilibili' | 'tencent';

export type MusicPath = 'search' | 'url' | 'lyric' | 'pic';

export const MUSIC_SOURCES: readonly MusicSource[] = [
  'netease',
  'joox',
  'bilibili',
  'tencent',
];

export const DEFAULT_SOURCE: MusicSource = 'netease';

export const DEFAULT_BASE_URL = 'https://music-api.gdstudio.xyz';

export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * path 级 TTL
 */
export const GD_PATH_TTL: Record<MusicPath, number> = {
  search: 10 * 60 * 1000,
  url: 5 * 60 * 1000,
  lyric: 60 * 60 * 1000,
  pic: 60 * 60 * 1000,
};

/**
 * url 剩余 TTL 小于该值时提前刷新
 */
export const URL_REFRESH_THRESHOLD_MS = 30 * 1000;

const BR_OPTIONS = [128, 192, 320, 740, 999];
const PIC_SIZE_OPTIONS = [300, 500];

export class GdStudioError extends Error {
  public readonly code: number;

  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
    public readonly path?: MusicPath,
    codeOverride?: number
  ) {
    super(message);
    this.name = 'GdStudioError';
    // 上游 4xx 保持原状态码，其余一律视为上游不可用
    this.code =
      codeOverride ??
      (typeof status === 'number' && status >= 400 && status < 500
        ? status
        : 503);
  }
}

export class GdStudioResponseError extends GdStudioError {
  constructor(message: string, path: MusicPath, detail?: string) {
    super(`音乐数据解析失败: ${message}`, undefined, detail, path, 502);
    this.name = 'GdStudioResponseError';
  }
}

export interface GdSearchTrack {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  picId?: string;
  lyricId?: string;
  source: MusicSource;
}

export interface GdUrlResult {
  url: string;
  br?: number;
  size?: number;
}

export interface GdLyricResult {
  lyric: string;
  tlyric?: string;
}

export interface GdPicResult {
  url: string;
}

export interface NormalizedMusicParams {
  source: MusicSource;
  params: Record<string, string | number>;
}

function parseSource(raw: unknown): MusicSource {
  const source = raw == null || raw === '' ? DEFAULT_SOURCE : String(raw);
  if (!MUSIC_SOURCES.includes(source as MusicSource)) {
    throw new GdStudioError(
      `不支持的音乐源: ${source}`,
      400,
      `Value of \`source\` is not supported.`
    );
  }

  return source as MusicSource;
}

function pickFromOptions(
  raw: unknown,
  options: number[],
  fallback: number
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return options.includes(value) ? value : fallback;
}

function pickInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function requireId(raw: unknown): string {
  const id = raw == null ? '' : String(raw);
  if (!id) {
    throw new GdStudioError('缺少音乐 id', 400, 'id is required');
  }

  return id;
}

/**
 * 默认参数与 source 白名单校验
 */
export function normalizeMusicParams(
  path: MusicPath,
  input: Record<string, unknown> = {}
): NormalizedMusicParams {
  const source = parseSource(input.source);

  if (path === 'search') {
    return {
      source,
      params: {
        name: input.name == null ? '' : String(input.name),
        count: pickInt(input.count, 20, 1, 100),
        pages: pickInt(input.pages, 1, 1, 1000),
      },
    };
  }

  if (path === 'url') {
    return {
      source,
      params: {
        id: requireId(input.id),
        br: pickFromOptions(input.br, BR_OPTIONS, 320),
      },
    };
  }

  if (path === 'pic') {
    return {
      source,
      params: {
        id: requireId(input.id ?? input.picId),
        size: pickFromOptions(input.size, PIC_SIZE_OPTIONS, 300),
      },
    };
  }

  return {
    source,
    params: {
      id: requireId(input.id ?? input.lyricId),
    },
  };
}

/**
 * 缓存 key（已包含 identifier，见 params）
 *
 * 最终形如 `music:search:netease:count:20:name:hello:pages:1`
 */
export function buildGdCacheKey(
  path: MusicPath,
  source: MusicSource,
  params: Record<string, string | number>
): string {
  return [
    'music',
    path,
    source,
    ...Object.keys(params)
      .sort()
      .map((key) => `${key}:${params[key]}`),
  ].join(':');
}

function normalizeArtist(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const artist = value
      .map((item) => (item == null ? '' : String(item)))
      .filter(Boolean)
      .join(' / ');

    return artist || undefined;
  }

  if (value == null || value === '') {
    return undefined;
  }

  return String(value);
}

function optionalString(value: unknown): string | undefined {
  if (value == null || value === '') {
    return undefined;
  }

  return String(value);
}

/**
 * search: 顶层数组
 */
export function parseSearchResponse(body: unknown): GdSearchTrack[] {
  if (!Array.isArray(body)) {
    throw new GdStudioResponseError(
      'search 响应不是数组',
      'search',
      JSON.stringify(body)?.slice(0, 200)
    );
  }

  return body
    .map((item): GdSearchTrack | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const input = item as Record<string, unknown>;
      const id = optionalString(input.id);
      const name = optionalString(input.name);
      if (!id || !name) {
        return null;
      }

      return {
        id,
        name,
        artist: normalizeArtist(input.artist),
        album: optionalString(input.album),
        picId: optionalString(input.pic_id ?? input.picId),
        lyricId: optionalString(input.lyric_id ?? input.lyricId),
        source: parseSource(input.source),
      };
    })
    .filter((item): item is GdSearchTrack => item !== null);
}

export function parseUrlResponse(body: unknown): GdUrlResult {
  if (!body || typeof body !== 'object') {
    throw new GdStudioResponseError(
      'url 响应不是对象',
      'url',
      JSON.stringify(body)?.slice(0, 200)
    );
  }

  const input = body as Record<string, unknown>;
  const url = optionalString(input.url);
  if (!url) {
    throw new GdStudioResponseError('url 响应缺少 url 字段', 'url');
  }

  return {
    url,
    br: Number.isFinite(Number(input.br)) ? Number(input.br) : undefined,
    size: Number.isFinite(Number(input.size)) ? Number(input.size) : undefined,
  };
}

/**
 * lyric: 无歌词的曲目属于正常情况，不视为错误
 */
export function parseLyricResponse(body: unknown): GdLyricResult {
  if (body == null || typeof body !== 'object') {
    throw new GdStudioResponseError(
      'lyric 响应不是对象',
      'lyric',
      JSON.stringify(body)?.slice(0, 200)
    );
  }

  const input = body as Record<string, unknown>;

  return {
    lyric: input.lyric == null ? '' : String(input.lyric),
    tlyric: optionalString(input.tlyric),
  };
}

export function parsePicResponse(body: unknown): GdPicResult {
  if (!body || typeof body !== 'object') {
    throw new GdStudioResponseError(
      'pic 响应不是对象',
      'pic',
      JSON.stringify(body)?.slice(0, 200)
    );
  }

  const input = body as Record<string, unknown>;
  const url = optionalString(input.url);
  if (!url) {
    throw new GdStudioResponseError('pic 响应缺少 url 字段', 'pic');
  }

  return { url };
}

function extractDetail(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body.slice(0, 300);
  }

  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as Record<string, unknown>).detail;
    return typeof detail === 'string' ? detail : JSON.stringify(detail);
  }

  return undefined;
}

/**
 * 把 got / 网络错误统一转换为 GdStudioError
 */
export function toGdStudioError(
  error: unknown,
  path: MusicPath
): GdStudioError {
  if (error instanceof GdStudioError) {
    return error;
  }

  const candidate = error as {
    response?: { statusCode?: number; body?: unknown };
    message?: string;
  };

  const status = candidate?.response?.statusCode;
  if (typeof status === 'number') {
    return new GdStudioError(
      `音乐服务请求失败(${status})`,
      status,
      extractDetail(candidate.response?.body),
      path
    );
  }

  return new GdStudioError(
    candidate?.message
      ? `音乐服务请求失败: ${candidate.message}`
      : '音乐服务请求失败',
    undefined,
    undefined,
    path
  );
}

export type GdStudioRequestFn = (
  path: MusicPath,
  source: MusicSource,
  params: Record<string, string | number>
) => Promise<unknown>;

export interface GdStudioClientOptions {
  /**
   * 可注入的请求实现，便于测试
   */
  request?: GdStudioRequestFn;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * 带缓存与解析的音乐服务客户端
 */
export class GdStudioClient {
  private readonly request: GdStudioRequestFn;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly cache: GdCache,
    options: GdStudioClientOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.request =
      options.request ??
      ((path, source, params) => this.defaultRequest(path, source, params));
  }

  private async defaultRequest(
    path: MusicPath,
    source: MusicSource,
    params: Record<string, string | number>
  ): Promise<unknown> {
    try {
      const response = await got.get(`${this.baseUrl}/api.php`, {
        searchParams: {
          types: path,
          source,
          ...params,
        },
        timeout: { request: this.timeoutMs },
        responseType: 'json',
        retry: { limit: 1 },
      });

      return response.body;
    } catch (error) {
      throw toGdStudioError(error, path);
    }
  }

  private async query<T>(
    path: MusicPath,
    input: Record<string, unknown>,
    parse: (body: unknown) => T
  ): Promise<T> {
    const { source, params } = normalizeMusicParams(path, input);
    const cacheKey = buildGdCacheKey(path, source, params);

    return await this.cache.get(
      cacheKey,
      {
        ttlMs: GD_PATH_TTL[path],
        refreshThresholdMs:
          path === 'url' ? URL_REFRESH_THRESHOLD_MS : undefined,
      },
      async () => parse(await this.request(path, source, params))
    );
  }

  search(input: Record<string, unknown>): Promise<GdSearchTrack[]> {
    return this.query('search', input, parseSearchResponse);
  }

  url(input: Record<string, unknown>): Promise<GdUrlResult> {
    return this.query('url', input, parseUrlResponse);
  }

  lyric(input: Record<string, unknown>): Promise<GdLyricResult> {
    return this.query('lyric', input, parseLyricResponse);
  }

  pic(input: Record<string, unknown>): Promise<GdPicResult> {
    return this.query('pic', input, parsePicResponse);
  }
}

export default GdStudioClient;
