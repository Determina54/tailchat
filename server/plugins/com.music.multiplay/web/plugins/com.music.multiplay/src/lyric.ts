/**
 * LRC 歌词解析与高亮（纯函数，便于单测）
 */

export interface LyricLine {
  time: number;
  text: string;
}

const TIME_TAG_PATTERN = /\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g;

/**
 * 解析 LRC
 *
 * - 支持一行多个时间标签
 * - 无时间标签或空文本的行会被跳过
 * - 结果按时间升序
 */
export function parseLrc(input: string): LyricLine[] {
  if (!input || typeof input !== 'string') {
    return [];
  }

  const result: LyricLine[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    TIME_TAG_PATTERN.lastIndex = 0;
    const matches = [...rawLine.matchAll(TIME_TAG_PATTERN)];
    if (matches.length === 0) {
      continue;
    }

    const text = rawLine.replace(TIME_TAG_PATTERN, '').trim();
    if (!text) {
      continue;
    }

    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        continue;
      }

      result.push({ time: minutes * 60 + seconds, text });
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

/**
 * 当前应高亮的歌词行下标（无匹配返回 -1）
 */
export function findActiveLyricIndex(
  lines: LyricLine[],
  currentTime: number
): number {
  let active = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].time <= currentTime) {
      active = index;
    } else {
      break;
    }
  }

  return active;
}

/**
 * 允许的播放时间漂移（秒）
 */
export const DRIFT_THRESHOLD_SECONDS = 1.5;

/**
 * 本地播放时间与服务端权威时间的偏差是否超过阈值
 */
export function shouldResync(
  localTime: number,
  serverTime: number,
  threshold = DRIFT_THRESHOLD_SECONDS
): boolean {
  if (!Number.isFinite(localTime) || !Number.isFinite(serverTime)) {
    return false;
  }

  return Math.abs(localTime - serverTime) > threshold;
}
