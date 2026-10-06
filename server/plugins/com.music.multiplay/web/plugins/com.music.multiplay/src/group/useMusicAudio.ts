import { useCallback, useEffect, useRef, useState } from 'react';
import { showToasts } from '@capital/common';
import { request } from '../request';
import type { MusicTrack } from '../types';
import { clampVolume } from '../types';
import { shouldResync } from '../lyric';
import { Translate } from '../translate';

export interface MusicAudioController {
  duration: number;
  localTime: number;
  error?: string;
  seekLocal: (time: number) => void;
  reload: () => void;
}

interface UseMusicAudioOptions {
  track?: MusicTrack;
  isPlaying: boolean;
  serverTime: number;
  volume: number;
  onEnded: () => void;
}

async function attemptPlay(element: HTMLAudioElement): Promise<void> {
  try {
    await element.play();
  } catch {
    showToasts(Translate.autoplayBlocked, 'warning');
  }
}

/**
 * HTML5 Audio 播放控制
 *
 * - url 按需向后端获取，切歌时通过 token 丢弃过期响应
 * - 播放时间以服务端为准，漂移超过阈值才校准
 * - 卸载时清理监听器与音源
 */
export function useMusicAudio(
  options: UseMusicAudioOptions
): MusicAudioController {
  const { track, isPlaying, serverTime, volume } = options;
  const elementRef = useRef<HTMLAudioElement>();
  const [duration, setDuration] = useState(0);
  const [localTime, setLocalTime] = useState(0);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  const requestTokenRef = useRef(0);
  const urlRef = useRef<string>();
  const serverTimeRef = useRef(serverTime);
  serverTimeRef.current = serverTime;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const onEndedRef = useRef(options.onEnded);
  onEndedRef.current = options.onEnded;

  // 音频元素生命周期
  useEffect(() => {
    const element = new Audio();
    element.preload = 'auto';
    elementRef.current = element;

    const handleLoaded = () => {
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    };
    const handleTimeUpdate = () => setLocalTime(element.currentTime);
    const handleEnded = () => onEndedRef.current();
    const handleError = () => setError(Translate.urlFailed);

    element.addEventListener('loadedmetadata', handleLoaded);
    element.addEventListener('durationchange', handleLoaded);
    element.addEventListener('timeupdate', handleTimeUpdate);
    element.addEventListener('ended', handleEnded);
    element.addEventListener('error', handleError);

    return () => {
      element.removeEventListener('loadedmetadata', handleLoaded);
      element.removeEventListener('durationchange', handleLoaded);
      element.removeEventListener('timeupdate', handleTimeUpdate);
      element.removeEventListener('ended', handleEnded);
      element.removeEventListener('error', handleError);
      element.pause();
      element.removeAttribute('src');
      element.load();
      elementRef.current = undefined;
    };
  }, []);

  // 切歌时获取播放地址
  useEffect(() => {
    const element = elementRef.current;
    if (!element || !track) {
      return;
    }

    const token = ++requestTokenRef.current;
    if (element.dataset.trackId === track.id && urlRef.current) {
      return;
    }

    element.dataset.trackId = track.id;
    urlRef.current = undefined;
    setError(undefined);
    setDuration(0);
    setLocalTime(0);

    request
      .get('url', { params: { id: track.id, source: track.source } })
      .then(({ data }) => {
        if (token !== requestTokenRef.current) {
          return;
        }

        const url = typeof data?.url === 'string' ? data.url : undefined;
        if (!url) {
          setError(Translate.urlFailed);
          showToasts(Translate.urlFailed, 'warning');
          return;
        }

        urlRef.current = url;
        element.src = url;
        try {
          element.currentTime = serverTimeRef.current;
        } catch {
          // ignore
        }

        if (isPlayingRef.current) {
          void attemptPlay(element);
        }
      })
      .catch(() => {
        if (token !== requestTokenRef.current) {
          return;
        }

        setError(Translate.urlFailed);
        showToasts(Translate.urlFailed, 'warning');
      });
  }, [track?.id, reloadToken]);

  // 播放 / 暂停
  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    if (isPlaying) {
      if (urlRef.current) {
        void attemptPlay(element);
      }
    } else {
      element.pause();
    }
  }, [isPlaying, track?.id, reloadToken]);

  // 漂移校准
  useEffect(() => {
    const element = elementRef.current;
    if (!element || !urlRef.current || !isPlaying) {
      return;
    }

    if (shouldResync(element.currentTime, serverTime)) {
      element.currentTime = serverTime;
    }
  }, [serverTime, isPlaying]);

  // 音量
  useEffect(() => {
    const element = elementRef.current;
    if (element) {
      element.volume = clampVolume(volume) / 100;
    }
  }, [volume]);

  const seekLocal = useCallback((time: number) => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    try {
      element.currentTime = time;
      setLocalTime(time);
    } catch {
      // ignore
    }
  }, []);

  const reload = useCallback(() => {
    urlRef.current = undefined;
    if (elementRef.current) {
      elementRef.current.dataset.trackId = '';
    }

    setReloadToken((previous) => previous + 1);
  }, []);

  return { duration, localTime, error, seekLocal, reload };
}

export default useMusicAudio;
