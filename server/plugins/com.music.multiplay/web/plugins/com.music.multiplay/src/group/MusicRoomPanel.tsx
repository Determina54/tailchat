import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalSocketEvent, useGroupPanelContext, getJWTUserInfo } from '@capital/common';
import { GroupPanelContainer } from '@capital/component';
import { request } from '../request';
import './index.less';

type Track = {
  id: string;
  name: string;
  artist?: string;
  picUrl?: string;
  addedBy?: string;
};

type RoomState = {
  queue: Track[];
  history: Track[];
  currentTrackId?: string;
  currentTrack?: Track;
  currentTime: number;
  isPlaying: boolean;
  ownerId?: string;
  members: { userId: string; userName: string }[];
};

type SearchResult = Track & { url?: string };

const emptyState: RoomState = {
  queue: [],
  history: [],
  currentTime: 0,
  isPlaying: false,
  members: [],
};

export function parseLrc(input: string): { time: number; text: string }[] {
  const result: { time: number; text: string }[] = [];
  const pattern = /\[(\d{2}):(\d{2}\.\d{2})\]/g;
  for (const line of input.split(/\r?\n/)) {
    const matches = [...line.matchAll(pattern)];
    const text = line.replace(pattern, '').trim();
    for (const match of matches) {
      result.push({
        time: Number(match[1]) * 60 + Number(match[2]),
        text,
      });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

const MusicRoomPanel: React.FC<{ panelInfo?: unknown }> = () => {
  const { groupId, panelId } = useGroupPanelContext();
  const [state, setState] = useState(emptyState);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [audio, setAudio] = useState<HTMLAudioElement>();
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchPanelRef = useRef<HTMLElement>(null);
  const throttleRef = useRef<ReturnType<typeof setTimeout>>();

  const refresh = () =>
    request.get('getState', { params: { groupId } }).then(({ data }) => setState(data));

  useEffect(() => {
    const element = new Audio();
    element.addEventListener('ended', () => {
      request.post('next', { groupId }).catch(() => undefined);
    });
    setAudio(element);
    getJWTUserInfo().then((user) => {
      const currentUserId = String(user._id || '');
      setUserId(currentUserId);
      request
        .post('join', { groupId, userName: user.nickname || currentUserId })
        .then(({ data }) => setState(data));
    });
    return () => {
      element.pause();
      element.src = '';
      request.post('leave', { groupId }).catch(() => undefined);
    };
  }, [groupId]);

  useEffect(() => {
    if (!audio || !state.currentTrack) return;
    const drift = Math.abs(audio.currentTime - state.currentTime);
    if (drift > 1.5) audio.currentTime = state.currentTime;
  }, [audio, state.currentTime]);

  useGlobalSocketEvent<Record<string, unknown>>(
    'notify:plugin:com.music.multiplay.stateUpdate',
    (data) => {
      if (data && data.groupId === groupId) setState(data as unknown as RoomState);
    }
  );

  useGlobalSocketEvent<Record<string, unknown>>(
    'notify:plugin:com.music.multiplay.progressSync',
    (data) => {
      if (data && data.groupId === groupId) {
        setState((previous) => ({
          ...previous,
          currentTime: Number(data.currentTime || 0),
          isPlaying: Boolean(data.isPlaying),
        }));
      }
    }
  );

  useEffect(() => {
    if (!audio || !state.currentTrack) return;
    if (audio.dataset.trackId !== state.currentTrack.id) {
      audio.dataset.trackId = state.currentTrack.id;
      request
        .get('url', { params: { id: state.currentTrack.id } })
        .then(({ data }) => {
          const url = data?.url || data?.data?.url;
          if (typeof url === 'string') {
            audio.src = url;
            audio.currentTime = state.currentTime;
            if (state.isPlaying) audio.play().catch(() => undefined);
          }
        });
    }
    if (state.isPlaying) audio.play().catch(() => undefined);
    else audio.pause();
  }, [audio, state.currentTrackId, state.isPlaying]);

  const lyrics = useMemo(
    () => parseLrc(state.currentTrack?.lyric || ''),
    [state.currentTrack?.lyric]
  );
  const activeLyric = lyrics.reduce<number>(
    (active, lyric, index) => (lyric.time <= state.currentTime ? index : active),
    -1
  );

  const control = (action: string, data: Record<string, unknown> = {}) =>
    request.post(action, { groupId, ...data }).then(({ data: next }) => setState(next));

  const search = () => {
    if (!query.trim()) return;
    setPage(1);
    request
      .get('search', { params: { name: query, pages: 1, count: 20 } })
      .then(({ data }) => setResults(Array.isArray(data) ? data : data?.data || []));
  };

  const loadMore = () => {
    if (!query.trim() || loadingMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    request
      .get('search', { params: { name: query, pages: nextPage, count: 20 } })
      .then(({ data }) => {
        const nextResults = Array.isArray(data) ? data : data?.data || [];
        setResults((current) => [...current, ...nextResults]);
        setPage(nextPage);
      })
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => {
    const panel = searchPanelRef.current;
    if (!panel) return;
    const onScroll = () => {
      if (throttleRef.current) return;
      throttleRef.current = setTimeout(() => {
        throttleRef.current = undefined;
        if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 32) {
          loadMore();
        }
      }, 300);
    };
    panel.addEventListener('scroll', onScroll);
    return () => {
      panel.removeEventListener('scroll', onScroll);
      if (throttleRef.current) clearTimeout(throttleRef.current);
    };
  }, [page, query, loadingMore]);

  const addSong = (track: SearchResult) => control('add', { track });

  return (
    <GroupPanelContainer groupId={groupId} panelId={panelId}>
      <div className="multiplay-room">
        <header>
          <strong>{state.currentTrack?.name || 'Music room'}</strong>
          <span>{state.currentTrack?.artist || 'No track playing'}</span>
          <button onClick={() => control(state.isPlaying ? 'pause' : 'play')}>
            {state.isPlaying ? 'Pause' : 'Play'}
          </button>
          <button onClick={() => control('prev')}>Prev</button>
          <button onClick={() => control('next')}>Next</button>
        </header>
        <input
          type="range"
          min={0}
          max={audio?.duration || 0}
          value={Math.min(state.currentTime, audio?.duration || state.currentTime)}
          onChange={(event) => {
            const time = Number(event.target.value);
            if (audio) audio.currentTime = time;
            control('seek', { time });
          }}
        />
        <section className="multiplay-content">
          <div className="multiplay-lyrics">
            {lyrics.map((line, index) => (
              <div key={`${line.time}-${index}`} className={index === activeLyric ? 'active' : ''}>
                {line.text}
              </div>
            ))}
          </div>
          <aside ref={searchPanelRef}>
            <div>
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && search()} />
              <button onClick={search}>Search</button>
            </div>
            {results.map((track) => (
              <div key={track.id}>
                <span>{track.name} {track.artist}</span>
                <button onClick={() => addSong(track)}>Add</button>
              </div>
            ))}
            <hr />
            {state.queue.map((track, index) => (
              <div key={track.id}>
                <span>{index + 1}. {track.name}</span>
                {state.ownerId === userId && <button onClick={() => control('remove', { trackId: track.id })}>x</button>}
              </div>
            ))}
          </aside>
        </section>
      </div>
    </GroupPanelContainer>
  );
};

export default MusicRoomPanel;
