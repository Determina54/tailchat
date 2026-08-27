import got from 'got';

const DEFAULT_BASE_URL = 'https://music-api.gdstudio.xyz';
const SOURCES = new Set(['netease', 'joox', 'bilibili', 'tencent']);

type MusicPath = 'search' | 'url' | 'lyric' | 'pic';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const refreshLocks = new Map<string, Promise<unknown>>();

const ttlByPath: Record<MusicPath, number> = {
  search: 10 * 60 * 1000,
  url: 5 * 60 * 1000,
  lyric: 60 * 60 * 1000,
  pic: 60 * 60 * 1000,
};

function assertSource(source: string) {
  if (!SOURCES.has(source)) {
    const error = new Error('Unsupported music source');
    (error as Error & { code?: number }).code = 400;
    throw error;
  }
}

function buildKey(path: MusicPath, source: string, params: Record<string, unknown>) {
  return [path, source, ...Object.keys(params).sort().map((key) => `${key}:${params[key]}`)].join(':');
}

async function fetchFromGdStudio(
  path: MusicPath,
  source: string,
  params: Record<string, unknown>
) {
  const response = await got.get(process.env.GD_API_BASE_URL || DEFAULT_BASE_URL, {
    searchParams: {
      types: path,
      source,
      ...params,
    },
    timeout: { request: 5000 },
    responseType: 'json',
    retry: { limit: 1 },
  });
  return response.body;
}

export async function queryGdStudio(
  path: MusicPath,
  source: string,
  params: Record<string, unknown>
) {
  assertSource(source);
  const key = buildKey(path, source, params);
  const now = Date.now();
  const current = cache.get(key);
  const stale = current && current.expiresAt > now ? current.value : undefined;
  const shouldRefresh = !current || path === 'url' && current.expiresAt - now < 30 * 1000;

  if (!shouldRefresh) return stale;

  const existingLock = refreshLocks.get(key);
  if (existingLock) {
    try {
      return await existingLock;
    } catch {
      if (stale !== undefined) return stale;
      throw new Error('Music provider unavailable');
    }
  }

  const refresh = fetchFromGdStudio(path, source, params)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlByPath[path] });
      return value;
    })
    .catch((error) => {
      if (stale !== undefined) return stale;
      throw error;
    })
    .finally(() => refreshLocks.delete(key));

  refreshLocks.set(key, refresh);
  return refresh;
}

export function getMusicParams(path: MusicPath, params: Record<string, unknown>) {
  const source = String(params.source || 'netease');
  if (path === 'search') {
    return {
      source,
      name: String(params.name || ''),
      count: Number(params.count || 20),
      pages: Number(params.pages || 1),
    };
  }
  return {
    source,
    id: String(params.id || ''),
    ...(path === 'url' ? { br: Number(params.br || 320) } : {}),
    ...(path === 'pic' ? { size: Number(params.size || 300) } : {}),
  };
}
