import { getLyricsApi } from '@jellyfin/sdk/lib/utils/api/lyrics-api';
import escapeHtml from 'escape-html';

import { AutoScroll } from 'apps/stable/features/lyrics/constants/autoScroll';
import autoFocuser from 'components/autoFocuser';
import { appRouter } from 'components/router/appRouter';
import layoutManager from 'components/layoutManager';
import { playbackManager } from 'components/playback/playbackmanager';
import scrollManager from 'components/scrollManager';
import focusManager from 'components/focusManager';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import keyboardNavigation from 'scripts/keyboardNavigation';
import LibraryMenu from 'scripts/libraryMenu';
import Events from 'utils/events';
import { toApi } from 'utils/jellyfin-apiclient/compat';

import '../styles/lyrics.scss';

let currentPlayer;
let currentItem;

let savedLyrics;
let isDynamicLyric = false;
let autoScroll = AutoScroll.Instant;

let lastPlayerTime = 0;
let lastChangeTime = 0;

function getLyricIndex(time, lyrics) {
    return lyrics.findLastIndex(lyric => lyric.Start <= time);
}

function getCurrentPlayTime() {
    let currentTime = playbackManager.currentTime();
    if (currentTime === undefined) currentTime = 0;
    if (currentTime !== lastPlayerTime) {
        lastPlayerTime = currentTime;
        lastChangeTime = performance.now();
    }
    let elapsed = 0;
    if (!playbackManager.paused()) {
        elapsed = performance.now() - lastChangeTime;
        if (elapsed > 400) elapsed = 400;
    }
    return (lastPlayerTime + elapsed) * 10000;
}

export default function (view) {
    function setPastLyricClassOnLine(line) {
        const lyric = view.querySelector(`#lyricPosition${line}`);
        if (lyric) {
            lyric.classList.remove('futureLyric');
            lyric.classList.add('pastLyric');
        }
    }

    function setFutureLyricClassOnLine(line) {
        const lyric = view.querySelector(`#lyricPosition${line}`);
        if (lyric) {
            lyric.classList.remove('pastLyric');
            lyric.classList.add('futureLyric');
        }
    }

    function setCurrentLyricClassOnLine(line) {
        const lyric = view.querySelector(`#lyricPosition${line}`);
        if (lyric) {
            lyric.classList.remove('pastLyric');
            lyric.classList.remove('futureLyric');
            if (autoScroll !== AutoScroll.NoScroll) {
                scrollManager.scrollToElement(lyric, autoScroll === AutoScroll.Smooth);
                focusManager.focus(lyric);
                autoScroll = AutoScroll.Smooth;
            }
        }
    }

    function updateAllLyricLines(currentLine, lyrics) {
        for (let lyricIndex = 0; lyricIndex < lyrics.length; lyricIndex++) {
            const lineEl = view.querySelector(`#lyricPosition${lyricIndex}`);
            if (lineEl) {
                const cueEls = lineEl.querySelectorAll('.lyricCue');
                if (cueEls.length) {
                    if (lyricIndex < currentLine) {
                        cueEls.forEach(cueEl => {
                            const fg = cueEl.querySelector('.lyricCueForeground');
                            if (fg) fg.style.clipPath = 'inset(-20px -20px -20px -20px)';
                        });
                    } else if (lyricIndex > currentLine) {
                        cueEls.forEach(cueEl => {
                            const fg = cueEl.querySelector('.lyricCueForeground');
                            if (fg) fg.style.clipPath = 'inset(0px 100% 0px 0px)';
                        });
                    }
                }
            }
            if (lyricIndex < currentLine) {
                setPastLyricClassOnLine(lyricIndex);
            } else if (lyricIndex === currentLine) {
                setCurrentLyricClassOnLine(lyricIndex);
            } else if (lyricIndex > currentLine) {
                setFutureLyricClassOnLine(lyricIndex);
            }
        }
    }

    function renderNoLyricMessage() {
        const itemsContainer = view.querySelector('.lyricsContainer');
        if (itemsContainer) {
            const html = `<h1>${globalize.translate('HeaderNoLyrics')}</h1>`;
            itemsContainer.innerHTML = html;
        }
        autoFocuser.autoFocus();
    }

    function renderLyrics(lyrics) {
        const itemsContainer = view.querySelector('.lyricsContainer');
        if (itemsContainer) {
            const primaryAgent = (lyrics && lyrics.length && (lyrics[0].AgentId || lyrics[0].agentId)) || null;
            const hasSecondary = lyrics && lyrics.some(line => {
                const a = line.AgentId || line.agentId;
                return a && a !== primaryAgent;
            });
            if (hasSecondary) {
                itemsContainer.classList.add('hasMultiAgent');
            } else {
                itemsContainer.classList.remove('hasMultiAgent');
            }

            let html = '';
            for (let index = 0; index < lyrics.length; index++) {
                const lyric = lyrics[index];
                const elem = layoutManager.tv ? 'button' : 'div';
                const classes = [];
                if (isDynamicLyric) classes.push('dynamicLyric');
                if (layoutManager.tv) classes.push('listItem', 'show-focus');

                const currentAgent = lyric.AgentId || lyric.agentId;
                if (currentAgent && currentAgent !== primaryAgent) {
                    classes.push('lyricSecondary');
                }

                const lyricTime = typeof lyric.Start !== 'undefined' ? `data-lyrictime="${lyric.Start}"` : '';

                let content = '';
                const cues = lyric.cues || lyric.Cues;
                if (cues && cues.length) {
                    for (let j = 0; j < cues.length; j++) {
                        const c = cues[j];
                        const start = c.start || c.Start;
                        const end = c.end || c.End;
                        const pos = c.position !== undefined ? c.position : c.Position;
                        const endPos = c.endPosition !== undefined ? c.endPosition : c.EndPosition;
                        const rawText = lyric.Text.slice(pos, endPos);
                        const match = rawText.match(/^(\s*)(.*?)(\s*)$/);
                        const leadingSpace = match ? match[1] : '';
                        const coreWord = match ? match[2] : rawText;
                        const trailingSpace = match ? match[3] : '';
                        const word = escapeHtml(coreWord);
                        content += `${leadingSpace}<span class="lyricCue" data-cue-start="${start}" ${end ? `data-cue-end="${end}"` : ''}><span class="lyricCueBackground">${word}</span><span class="lyricCueForeground">${word}</span></span>${trailingSpace}`;
                    }
                } else {
                    content = escapeHtml(lyric.Text);
                }

                const prevLine = index > 0 ? lyrics[index - 1] : null;
                const currentSection = lyric.Section || lyric.section;
                const prevSection = prevLine ? (prevLine.Section || prevLine.section) : null;
                let sectionHeaderHtml = '';
                if (currentSection && currentSection !== prevSection) {
                    sectionHeaderHtml = `<div class="lyricSectionHeader">${escapeHtml(currentSection)}</div>`;
                }

                html += sectionHeaderHtml + `<${elem} class="lyricsLine ${classes.join(' ')}" id="lyricPosition${index}" ${lyricTime}>
    ${content}
</${elem}>`;
            }

            const pref = localStorage.getItem('preferredLyricFormat') || 'ttml';
            const toggleHtml = `<div class="lyricPreferenceToggle">
                <button class="lyricPrefBtn${pref === 'ttml' ? ' active' : ''}" data-format="ttml">TTML (Word-Sync)</button>
                <button class="lyricPrefBtn${pref === 'lrc' ? ' active' : ''}" data-format="lrc">LRC (Line-Sync)</button>
            </div>`;

            itemsContainer.innerHTML = toggleHtml + html;

            const toggleContainer = itemsContainer.querySelector('.lyricPreferenceToggle');
            if (toggleContainer) {
                const btns = toggleContainer.querySelectorAll('.lyricPrefBtn');
                btns.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const format = e.target.getAttribute('data-format');
                        localStorage.setItem('preferredLyricFormat', format);
                        onLoad();
                    });
                });
            }
        }

        if (isDynamicLyric) {
            const lyricLineArray = itemsContainer.querySelectorAll('.lyricsLine');

            lyricLineArray.forEach(element => {
                element.addEventListener('click', () => onLyricClick(element.getAttribute('data-lyrictime')));
            });

            const currentIndex = getLyricIndex(getCurrentPlayTime(), lyrics);
            updateAllLyricLines(currentIndex, savedLyrics);

            if (!window.lyricUpdateLoopStarted) {
                console.log("[Jellyfin Lyrics] Loaded smooth interpolating patch");
                window.lyricUpdateLoopStarted = true;
                const runLoop = () => {
                    if (!document.contains(view)) {
                        window.lyricUpdateLoopStarted = false;
                        return;
                    }
                    requestAnimationFrame(runLoop);
                    if (!savedLyrics || !savedLyrics.length) return;

                    const currentTimeTicks = getCurrentPlayTime();
                    let activeLineIndex = -1;
                    for (let i = 0; i < savedLyrics.length; i++) {
                        if (savedLyrics[i].Start <= currentTimeTicks) {
                            activeLineIndex = i;
                        }
                    }

                    if (activeLineIndex !== -1) {
                        const lineEl = view.querySelector(`#lyricPosition${activeLineIndex}`);
                        if (lineEl) {
                            const cueEls = lineEl.querySelectorAll('.lyricCue');
                            cueEls.forEach(cueEl => {
                                const fg = cueEl.querySelector('.lyricCueForeground');
                                if (fg) {
                                    const cueStart = parseInt(cueEl.getAttribute('data-cue-start'), 10);
                                    const cueEndAttr = cueEl.getAttribute('data-cue-end');
                                    const cueEnd = cueEndAttr ? parseInt(cueEndAttr, 10) : Infinity;

                                     if (currentTimeTicks < cueStart) {
                                         fg.style.clipPath = 'inset(0px 100% 0px 0px)';
                                     } else if (currentTimeTicks >= cueEnd) {
                                         fg.style.clipPath = 'inset(-20px -20px -20px -20px)';
                                     } else {
                                         const totalTicks = cueEnd - cueStart;
                                         const remainingTicks = cueEnd - currentTimeTicks;
                                         const progressPercent = 100 * (1 - (remainingTicks / totalTicks));
                                         fg.style.clipPath = `inset(-20px ${100 - progressPercent}% -20px -20px)`;
                                     }
                                }
                            });
                        }
                    }
                };
                requestAnimationFrame(runLoop);
            }
        }
    }

    function updateLyrics(lyrics) {
        savedLyrics = lyrics;

        isDynamicLyric = Object.prototype.hasOwnProperty.call(lyrics[0], 'Start');

        renderLyrics(savedLyrics);

        autoFocuser.autoFocus(view);
    }

    function getLyrics(serverId, itemId) {
        const apiClient = ServerConnections.getApiClient(serverId);
        const lyricsApi = getLyricsApi(toApi(apiClient));
        const preferredFormat = localStorage.getItem('preferredLyricFormat') || 'ttml';

        return lyricsApi.getLyrics({ itemId, preferredFormat })
            .then(({ data }) => {
                if (!data.Lyrics?.length) {
                    throw new Error('No lyrics returned');
                }
                return data.Lyrics;
            });
    }

    function bindToPlayer(player) {
        if (player === currentPlayer) {
            return;
        }

        releaseCurrentPlayer();

        currentPlayer = player;

        if (!player) {
            return;
        }

        Events.on(player, 'timeupdate', onTimeUpdate);
        Events.on(player, 'playbackstart', onPlaybackStart);
        Events.on(player, 'playbackstop', onPlaybackStop);
    }

    function releaseCurrentPlayer() {
        const player = currentPlayer;

        if (player) {
            Events.off(player, 'timeupdate', onTimeUpdate);
            Events.off(player, 'playbackstart', onPlaybackStart);
            Events.off(player, 'playbackstop', onPlaybackStop);
            currentPlayer = null;
        }
    }

    function onLyricClick(lyricTime) {
        autoScroll = AutoScroll.Smooth;
        playbackManager.seek(lyricTime);
        if (playbackManager.paused()) {
            playbackManager.playPause(currentPlayer);
        }
    }

    function onTimeUpdate() {
        if (isDynamicLyric) {
            const currentIndex = getLyricIndex(getCurrentPlayTime(), savedLyrics);
            updateAllLyricLines(currentIndex, savedLyrics);
        }
    }

    function onPlaybackStart(event, state) {
        if (currentItem.Id !== state.NowPlayingItem.Id) {
            onLoad();
        }
    }

    function onPlaybackStop(_, state) {
        if (!state.NextMediaType) {
            appRouter.goHome();
        }
    }

    function onPlayerChange() {
        const player = playbackManager.getCurrentPlayer();
        bindToPlayer(player);
    }

    function onLoad() {
        savedLyrics = null;
        currentItem = null;
        isDynamicLyric = false;

        LibraryMenu.setTitle(globalize.translate('Lyrics'));

        const player = playbackManager.getCurrentPlayer();

        if (player) {
            bindToPlayer(player);

            const state = playbackManager.getPlayerState(player);
            currentItem = state.NowPlayingItem;

            const serverId = state.NowPlayingItem.ServerId;
            const itemId = state.NowPlayingItem.Id;

            getLyrics(serverId, itemId).then(updateLyrics).catch(renderNoLyricMessage);
        } else {
            appRouter.goHome();
        }
    }

    function onWheelOrTouchMove() {
        autoScroll = AutoScroll.NoScroll;
    }

    function onKeyDown(e) {
        const key = keyboardNavigation.getKeyName(e);
        if (key === 'ArrowUp' || key === 'ArrowDown') {
            autoScroll = AutoScroll.NoScroll;
        }
    }

    view.addEventListener('viewshow', function () {
        Events.on(playbackManager, 'playerchange', onPlayerChange);
        autoScroll = AutoScroll.Instant;
        document.addEventListener('wheel', onWheelOrTouchMove);
        document.addEventListener('touchmove', onWheelOrTouchMove);
        document.addEventListener('keydown', onKeyDown);
        try {
            onLoad();
        } catch {
            appRouter.goHome();
        }
    });

    view.addEventListener('viewbeforehide', function () {
        Events.off(playbackManager, 'playerchange', onPlayerChange);
        document.removeEventListener('wheel', onWheelOrTouchMove);
        document.removeEventListener('touchmove', onWheelOrTouchMove);
        document.removeEventListener('keydown', onKeyDown);
        releaseCurrentPlayer();
    });
}
