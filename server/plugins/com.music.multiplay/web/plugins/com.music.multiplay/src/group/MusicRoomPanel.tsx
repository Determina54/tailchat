import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGroupPanelContext, showErrorToasts } from '@capital/common';
import { GroupPanelContainer } from '@capital/component';
import { request } from '../request';
import type { MusicSearchResult } from '../types';
import { findActiveLyricIndex, parseLrc } from '../lyric';
import { Translate } from '../translate';
import { useMusicRoom } from './useMusicRoom';
import { useMusicAudio } from './useMusicAudio';
import './index.less';

const PAGE_SIZE = 20;
const SEARCH_THROTTLE_MS = 300;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const total = Math.floor(seconds);
  const minute = Math.floor(total / 60);
  const second = total % 60;

  return `${String(minute).padStart(2, '0')}:${String(second).padStart(
    2,
    '0'
  )}`;
}

interface MusicRoomPanelProps {
  groupId: string;
  panelId: string;
}

const MusicRoomPanelInner: React.FC<MusicRoomPanelProps> = ({
  groupId,
  panelId,
}) => {
  const room = useMusicRoom(groupId);
  const { state, userId, isOwner } = room;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MusicSearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [showTranslation, setShowTranslation] = useState(true);
  const [lyric, setLyric] = useState<{ lyric?: string; tlyric?: string }>({});

  const listRef = useRef<HTMLDivElement>(null);
  const scrollThrottleRef = useRef<ReturnType<typeof setTimeout>>();
  const activeLineRef = useRef<HTMLDivElement>(null);

  const audio = useMusicAudio({
    track: state.currentTrack,
    isPlaying: state.isPlaying,
    serverTime: state.currentTime,
    volume: state.volume,
    onEnded: () => {
      void room.control('next');
    },
  });

  // 歌词按需加载（不在歌单里携带大文本）
  useEffect(() => {
    const track = state.currentTrack;
    if (!track) {
      setLyric({});
      return;
    }

    if (track.lyric || track.tlyric) {
      setLyric({ lyric: track.lyric, tlyric: track.tlyric });
      return;
    }

    let active = true;
    request
      .get('lyric', {
        params: { id: track.lyricId || track.id, source: track.source },
      })
      .then(({ data }) => {
        if (active) {
          setLyric({ lyric: data?.lyric, tlyric: data?.tlyric });
        }
      })
      .catch(() => {
        if (active) {
          setLyric({});
        }
      });

    return () => {
      active = false;
    };
  }, [state.currentTrackId, state.currentTrack?.lyric]);

  const lyrics = useMemo(() => parseLrc(lyric.lyric || ''), [lyric.lyric]);
  const translatedLyrics = useMemo(
    () => parseLrc(lyric.tlyric || ''),
    [lyric.tlyric]
  );
  const activeIndex = findActiveLyricIndex(lyrics, state.currentTime);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView?.({
      block: 'center',
      behavior: 'smooth',
    });
  }, [activeIndex]);

  const runSearch = async (nextPage: number, keyword: string) => {
    if (!keyword.trim() || searching) {
      return;
    }

    setSearching(true);
    try {
      const { data } = await request.get('search', {
        params: { name: keyword, pages: nextPage, count: PAGE_SIZE },
      });
      const list: MusicSearchResult[] = Array.isArray(data) ? data : [];

      setResults((previous) =>
        nextPage === 1 ? list : [...previous, ...list]
      );
      setPage(nextPage);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (error) {
      showErrorToasts(error);
    } finally {
      setSearching(false);
    }
  };

  // 滚动到底部自动加载下一页（300ms throttle）
  const searchRef = useRef(runSearch);
  searchRef.current = runSearch;
  const pageRef = useRef(page);
  pageRef.current = page;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const panel = listRef.current;
    if (!panel) {
      return;
    }

    const onScroll = () => {
      if (scrollThrottleRef.current) {
        return;
      }

      scrollThrottleRef.current = setTimeout(() => {
        scrollThrottleRef.current = undefined;

        if (!hasMoreRef.current) {
          return;
        }

        const nearBottom =
          panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 32;
        if (nearBottom) {
          void searchRef.current(pageRef.current + 1, queryRef.current);
        }
      }, SEARCH_THROTTLE_MS);
    };

    panel.addEventListener('scroll', onScroll);

    return () => {
      panel.removeEventListener('scroll', onScroll);
      if (scrollThrottleRef.current) {
        clearTimeout(scrollThrottleRef.current);
        scrollThrottleRef.current = undefined;
      }
    };
  }, []);

  const addSong = (track: MusicSearchResult) => {
    void room.control('add', { track });
  };

  const currentDuration = audio.duration > 0 ? audio.duration : 0;

  return (
    <GroupPanelContainer groupId={groupId} panelId={panelId}>
      <div className="multiplay-room">
        <header>
          <div className="multiplay-track">
            <strong>{state.currentTrack?.name || Translate.noTrack}</strong>
            <span>{state.currentTrack?.artist}</span>
          </div>
          <div
            className="multiplay-progress"
            title={`${formatTime(audio.localTime)} / ${formatTime(
              currentDuration
            )}`}
          >
            <span>{formatTime(audio.localTime)}</span>
            <input
              type="range"
              min={0}
              max={currentDuration || 0}
              step={0.1}
              value={Math.min(audio.localTime, currentDuration || 0)}
              disabled={currentDuration <= 0}
              onChange={(event) => {
                const time = Number(event.target.value);
                audio.seekLocal(time);
                void room.control('seek', { time });
              }}
            />
            <span>{formatTime(currentDuration)}</span>
          </div>
          <div className="multiplay-controls">
            <button
              onClick={() =>
                void room.control(state.isPlaying ? 'pause' : 'play')
              }
            >
              {state.isPlaying ? Translate.pause : Translate.play}
            </button>
            <button onClick={() => void room.control('prev')}>
              {Translate.prev}
            </button>
            <button onClick={() => void room.control('next')}>
              {Translate.next}
            </button>
          </div>
          <div className="multiplay-volume">
            <span>{Translate.volume}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={state.volume}
              disabled={!isOwner}
              title={isOwner ? Translate.volume : Translate.ownerOnlyVolume}
              onChange={(event) => {
                if (isOwner) {
                  void room.control('volume', {
                    volume: Number(event.target.value),
                  });
                }
              }}
            />
          </div>
        </header>

        {state.degraded ? (
          <div className="multiplay-degraded">{Translate.degraded}</div>
        ) : null}

        <section className="multiplay-content">
          <div className="multiplay-lyrics">
            <div className="multiplay-section-header">
              <span>{Translate.lyrics}</span>
              <label>
                <input
                  type="checkbox"
                  checked={showTranslation}
                  onChange={(event) => setShowTranslation(event.target.checked)}
                />
                {Translate.showTranslation}
              </label>
            </div>
            {lyrics.length === 0 ? (
              <div className="multiplay-empty">{Translate.noLyrics}</div>
            ) : (
              lyrics.map((line, index) => (
                <div
                  key={`${line.time}-${index}`}
                  ref={index === activeIndex ? activeLineRef : undefined}
                  className={index === activeIndex ? 'active' : ''}
                >
                  <div>{line.text}</div>
                  {showTranslation ? (
                    <div className="multiplay-lyric-translation">
                      {translatedLyrics[index]?.text}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <aside>
            <div className="multiplay-search">
              <input
                value={query}
                placeholder={Translate.searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void runSearch(1, query);
                  }
                }}
              />
              <button onClick={() => void runSearch(1, query)}>
                {Translate.search}
              </button>
            </div>

            <div className="multiplay-results" ref={listRef}>
              {results.map((track) => (
                <div className="multiplay-result" key={`${track.source}-${track.id}`}>
                  <span>
                    <strong>{track.name}</strong>
                    {track.artist ? <em>{track.artist}</em> : null}
                  </span>
                  <button onClick={() => addSong(track)}>{Translate.add}</button>
                </div>
              ))}
            </div>

            <div className="multiplay-section-header">
              <span>{Translate.queue}</span>
              {isOwner ? (
                <button onClick={() => void room.control('clear')}>
                  {Translate.clear}
                </button>
              ) : null}
            </div>

            <div className="multiplay-queue">
              {state.queue.length === 0 ? (
                <div className="multiplay-empty">{Translate.emptyQueue}</div>
              ) : (
                state.queue.map((track, index) => (
                  <div className="multiplay-queue-item" key={track.id}>
                    <span>
                      {index + 1}. {track.name}
                    </span>
                    {isOwner ? (
                      <button
                        onClick={() =>
                          void room.control('remove', { trackId: track.id })
                        }
                      >
                        x
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className="multiplay-section-header">
              <span>
                {Translate.members} ({state.members.length})
              </span>
            </div>
            <div className="multiplay-members">
              {state.members.map((member) => (
                <span key={member.userId}>
                  {member.userName || member.userId}
                  {member.userId === state.ownerId ? ` (${Translate.owner})` : ''}
                  {member.userId === userId ? ' *' : ''}
                </span>
              ))}
            </div>
          </aside>
        </section>
      </div>
    </GroupPanelContainer>
  );
};

const MusicRoomPanel: React.FC = () => {
  const panelContext = useGroupPanelContext();

  if (!panelContext) {
    return null;
  }

  return (
    <MusicRoomPanelInner
      groupId={panelContext.groupId}
      panelId={panelContext.panelId}
    />
  );
};

export default MusicRoomPanel;
