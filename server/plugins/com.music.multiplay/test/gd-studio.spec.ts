import {
  DEFAULT_SOURCE,
  GdStudioClient,
  GdStudioError,
  GdStudioResponseError,
  buildGdCacheKey,
  normalizeMusicParams,
  parseLyricResponse,
  parsePicResponse,
  parseSearchResponse,
  parseUrlResponse,
  toGdStudioError,
} from '../services/gd-studio';
import { InProcessGdStudioCache } from '../services/gdStudioCache';

function createClient(
  request: jest.Mock
): GdStudioClient {
  return new GdStudioClient(
    new InProcessGdStudioCache({ maxRequestsPerWindow: 100 }),
    { request }
  );
}

describe('gd-studio 响应解析', () => {
  test('search 是顶层数组，artist 数组会被拼接', () => {
    const list = parseSearchResponse([
      {
        id: '1',
        name: 'Hello',
        artist: ['Adele', 'Someone'],
        album: 'Hello',
        pic_id: 'p1',
        lyric_id: 'l1',
        source: 'netease',
      },
      { id: '', name: 'bad' },
      null,
    ]);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: '1',
      name: 'Hello',
      artist: 'Adele / Someone',
      album: 'Hello',
      picId: 'p1',
      lyricId: 'l1',
      source: 'netease',
    });
  });

  test('search 非数组时抛出解析错误', () => {
    expect(() => parseSearchResponse({ data: [] })).toThrow(
      GdStudioResponseError
    );
  });

  test('search 出现未支持的 source 时抛出 400', () => {
    expect(() =>
      parseSearchResponse([{ id: '1', name: 'x', source: 'unknown' }])
    ).toThrow(GdStudioError);
  });

  test('url 缺 url 字段时抛出解析错误', () => {
    expect(parseUrlResponse({ url: 'https://a', br: 320 })).toEqual({
      url: 'https://a',
      br: 320,
      size: undefined,
    });
    expect(() => parseUrlResponse({ br: 320 })).toThrow(GdStudioResponseError);
    expect(() => parseUrlResponse('nope')).toThrow(GdStudioResponseError);
  });

  test('lyric 允许没有歌词', () => {
    expect(parseLyricResponse({})).toEqual({
      lyric: '',
      tlyric: undefined,
    });
    expect(parseLyricResponse({ lyric: '[00:01.00]hi', tlyric: '[00:01.00]嗨' })).toEqual({
      lyric: '[00:01.00]hi',
      tlyric: '[00:01.00]嗨',
    });
    expect(() => parseLyricResponse('nope')).toThrow(GdStudioResponseError);
  });

  test('pic 必须有 url', () => {
    expect(parsePicResponse({ url: 'https://img' })).toEqual({
      url: 'https://img',
    });
    expect(() => parsePicResponse({})).toThrow(GdStudioResponseError);
  });
});

describe('gd-studio 参数归一化', () => {
  test('search 默认参数', () => {
    const normalized = normalizeMusicParams('search', { name: 'hello' });

    expect(normalized.source).toBe(DEFAULT_SOURCE);
    expect(normalized.params).toEqual({ name: 'hello', count: 20, pages: 1 });
  });

  test('url 默认音质 320，非法值回退', () => {
    expect(normalizeMusicParams('url', { id: '1' }).params).toEqual({
      id: '1',
      br: 320,
    });
    expect(normalizeMusicParams('url', { id: '1', br: 999 }).params.br).toBe(999);
    expect(normalizeMusicParams('url', { id: '1', br: 123 }).params.br).toBe(320);
  });

  test('pic 默认尺寸 300，非法值回退', () => {
    expect(normalizeMusicParams('pic', { id: 'p' }).params).toEqual({
      id: 'p',
      size: 300,
    });
    expect(normalizeMusicParams('pic', { id: 'p', size: 500 }).params.size).toBe(500);
    expect(normalizeMusicParams('pic', { id: 'p', size: 42 }).params.size).toBe(300);
  });

  test('缺少 id 时抛出 400', () => {
    expect(() => normalizeMusicParams('url', {})).toThrow(GdStudioError);

    try {
      normalizeMusicParams('url', {});
    } catch (error) {
      expect((error as GdStudioError).code).toBe(400);
    }
  });

  test('source 白名单', () => {
    expect(normalizeMusicParams('search', { name: 'x', source: 'joox' }).source).toBe(
      'joox'
    );
    expect(() =>
      normalizeMusicParams('search', { name: 'x', source: 'spotify' })
    ).toThrow(GdStudioError);
  });

  test('缓存 key 与参数顺序无关且包含 source', () => {
    const a = buildGdCacheKey('search', 'netease', { name: 'x', count: 20 });
    const b = buildGdCacheKey('search', 'netease', { count: 20, name: 'x' });
    const c = buildGdCacheKey('search', 'joox', { name: 'x', count: 20 });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('gd-studio 错误映射', () => {
  test('got HTTPError 会带出状态码与 detail', () => {
    const error = toGdStudioError(
      {
        response: {
          statusCode: 400,
          body: { detail: 'Value of `source` is not supported.' },
        },
      },
      'search'
    );

    expect(error.code).toBe(400);
    expect(error.detail).toBe('Value of `source` is not supported.');
  });

  test('网络错误映射为 503', () => {
    const error = toGdStudioError({ message: 'ETIMEDOUT' }, 'url');

    expect(error.code).toBe(503);
    expect(error.message).toContain('ETIMEDOUT');
  });

  test('上游 5xx 映射为 503', () => {
    expect(toGdStudioError({ response: { statusCode: 502 } }, 'url').code).toBe(503);
  });
});

describe('GdStudioClient', () => {
  test('search 会做缓存并使用默认参数', async () => {
    const request = jest.fn().mockResolvedValue([
      { id: '1', name: 'Hello', artist: ['Adele'], source: 'netease' },
    ]);
    const client = createClient(request);

    const first = await client.search({ name: 'hello' });
    const second = await client.search({ name: 'hello' });

    expect(first).toEqual(second);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('search', 'netease', {
      name: 'hello',
      count: 20,
      pages: 1,
    });
  });

  test('不同分页使用不同缓存条目', async () => {
    const request = jest.fn().mockResolvedValue([]);
    const client = createClient(request);

    await client.search({ name: 'hello', pages: 1 });
    await client.search({ name: 'hello', pages: 2 });

    expect(request).toHaveBeenCalledTimes(2);
  });

  test('url / lyric / pic 走各自的解析器', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ url: 'https://a.mp3', br: 320 })
      .mockResolvedValueOnce({ lyric: '[00:01.00]hi', tlyric: '[00:01.00]嗨' })
      .mockResolvedValueOnce({ url: 'https://img' });
    const client = createClient(request);

    await expect(client.url({ id: '1' })).resolves.toEqual({
      url: 'https://a.mp3',
      br: 320,
      size: undefined,
    });
    await expect(client.lyric({ id: '1' })).resolves.toEqual({
      lyric: '[00:01.00]hi',
      tlyric: '[00:01.00]嗨',
    });
    await expect(client.pic({ id: '1' })).resolves.toEqual({
      url: 'https://img',
    });
  });

  test('解析失败不会污染缓存', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ url: 'https://a.mp3' });
    const client = createClient(request);

    await expect(client.url({ id: '1' })).rejects.toThrow(GdStudioResponseError);
    await expect(client.url({ id: '1' })).resolves.toMatchObject({
      url: 'https://a.mp3',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('非法 source 在请求前直接失败', async () => {
    const request = jest.fn();
    const client = createClient(request);

    await expect(
      client.search({ name: 'x', source: 'spotify' })
    ).rejects.toThrow(GdStudioError);
    expect(request).not.toHaveBeenCalled();
  });
});
