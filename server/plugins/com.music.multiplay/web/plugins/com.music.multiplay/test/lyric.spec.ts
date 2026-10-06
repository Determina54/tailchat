import {
  DRIFT_THRESHOLD_SECONDS,
  findActiveLyricIndex,
  parseLrc,
  shouldResync,
} from '../src/lyric';

describe('parseLrc', () => {
  test('解析单个时间标签', () => {
    expect(parseLrc('[00:12.34]hello')).toEqual([{ time: 12.34, text: 'hello' }]);
  });

  test('一行多个时间标签会展开成多行', () => {
    expect(parseLrc('[00:01.00][00:05.50]repeat')).toEqual([
      { time: 1, text: 'repeat' },
      { time: 5.5, text: 'repeat' },
    ]);
  });

  test('忽略无时间标签或空文本的行', () => {
    expect(
      parseLrc(['no tag', '[00:01.00]', '[00:02.00]ok', ''].join('\n'))
    ).toEqual([{ time: 2, text: 'ok' }]);
  });

  test('结果按时间升序', () => {
    expect(parseLrc('[00:03.00]c\n[00:01.00]a\n[00:02.00]b').map((l) => l.text)).toEqual(
      ['a', 'b', 'c']
    );
  });

  test('非字符串输入返回空数组', () => {
    expect(parseLrc(undefined as unknown as string)).toEqual([]);
  });
});

describe('findActiveLyricIndex', () => {
  const lines = parseLrc(
    '[00:00.00]a\n[00:10.00]b\n[00:20.00]c'
  );

  test('没有匹配时返回 -1', () => {
    expect(findActiveLyricIndex([], 5)).toBe(-1);
  });

  test('返回最后一个已到达的行', () => {
    expect(findActiveLyricIndex(lines, 0)).toBe(0);
    expect(findActiveLyricIndex(lines, 9.9)).toBe(0);
    expect(findActiveLyricIndex(lines, 10)).toBe(1);
    expect(findActiveLyricIndex(lines, 100)).toBe(2);
  });
});

describe('shouldResync', () => {
  test('阈值以内不校准', () => {
    expect(shouldResync(10, 11.4)).toBe(false);
    expect(shouldResync(10, 11.5)).toBe(false);
  });

  test('超过阈值需要校准', () => {
    expect(shouldResync(10, 11.6)).toBe(true);
    expect(shouldResync(20, 10)).toBe(true);
  });

  test('非法值不校准', () => {
    expect(shouldResync(NaN, 10)).toBe(false);
    expect(shouldResync(10, NaN)).toBe(false);
  });

  test('默认阈值为 1.5 秒', () => {
    expect(DRIFT_THRESHOLD_SECONDS).toBe(1.5);
  });
});
