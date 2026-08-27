/**
 * Song List Manager for Yinyun Web
 * Handles fetching, rendering and interactions for the "Song List" (Playlist) feature.
 */

window.SongListManager = (function () {
    const API_BASE = '/api/v1/player/music';
    let currentState = {
        source: 'tx',
        tagId: '',
        tagName: '全部分类',
        sortId: 'hot',
        sortList: [{ name: '最热', id: 'hot' }], // Default for WY
        page: 1,
        total: 0,
        limit: 30,
        list: [],
        tags: [],
        hotTags: []
    };
    let initialized = false;

    let detailState = {
        id: '',
        source: '',
        info: null,
        list: [],
        page: 1,
        total: 0,
        limit: 30,
        returnTab: 'songlist',
        hostParentId: 'view-songlist',
        isLocal: false,
        playlist: null,
        historyPushed: false,
        historyBaseState: null,
        historyBaseUrl: '',
    };
    let detailCloseTimer = null;
    let detailGeneration = 0;
    let detailClosing = false;

    function pushDetailHistory(detailType, listId) {
        const current = window.history.state;
        if (current?.page === 'songlist-detail'
            && current.detailType === detailType
            && String(current.listId || '') === String(listId || '')) {
            detailState.historyPushed = true;
            return;
        }

        // Keep a copy of the entry that was active before the detail view was
        // opened.  Closing the in-app back button restores this entry with
        // replaceState instead of starting an asynchronous history traversal;
        // Safari can deliver that traversal after a second playlist was
        // already opened, which used to leave the UI and history out of sync.
        const replacingDetail = current?.page === 'songlist-detail';
        if (!replacingDetail) {
            detailState.historyBaseState = current && typeof current === 'object' ? { ...current } : current ?? null;
            detailState.historyBaseUrl = window.location.href;
        }
        window.history.pushState({
            ...(current && typeof current === 'object' ? current : {}),
            page: 'songlist-detail',
            detailType,
            listId: String(listId || ''),
        }, '');
        detailState.historyPushed = true;
    }

    function clearDetailHistoryMarker() {
        detailState.historyPushed = false;
        detailState.historyBaseState = null;
        detailState.historyBaseUrl = '';
    }

    function restoreDetailHistory() {
        if (window.history.state?.page === 'songlist-detail') {
            try {
                window.history.replaceState(
                    detailState.historyBaseState ?? null,
                    '',
                    detailState.historyBaseUrl || window.location.href,
                );
            } catch (error) {
                // A history restoration failure must not prevent the detail
                // view from closing; the next navigation still has a clean
                // in-memory state and can recover normally.
                console.warn('[SongList] 恢复详情历史状态失败:', error);
            }
        }
        clearDetailHistoryMarker();
    }

    function ensureDetailHost(parentId) {
        const detailView = document.getElementById('songlist-detail-view');
        const parent = document.getElementById(parentId);
        if (detailView && parent && detailView.parentElement !== parent) parent.appendChild(detailView);
        detailState.hostParentId = parentId;
        return detailView;
    }

    function isDetailVisible() {
        const detailView = document.getElementById('songlist-detail-view');
        return Boolean(detailView && !detailView.classList.contains('hidden'));
    }

    function resetDetailCloseState() {
        if (detailCloseTimer) {
            clearTimeout(detailCloseTimer);
            detailCloseTimer = null;
        }
        detailClosing = false;
    }

    function notifyDetailContext(open, detailType, listId) {
        if (typeof window.setSongListDetailContext !== 'function') return;
        window.setSongListDetailContext({
            open: Boolean(open),
            type: detailType || '',
            listId: listId == null ? '' : String(listId),
        });
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[char]);
    }

    function imageForSong(song) {
        const value = window.getImgUrl ? window.getImgUrl(song) : (song?.img || song?.picUrl || song?.meta?.picUrl || '');
        return value || '/_player/assets/logo.svg';
    }

    function isRealArtwork(value) {
        return Boolean(value && !/logo\.svg(?:[?#]|$)/i.test(String(value)));
    }

    function playlistArtwork(list, songs = list?.list || []) {
        const explicit = list?.coverUrl || list?.artworkUrl || list?.cover;
        if (isRealArtwork(explicit)) return explicit;
        const selectedId = String(list?.coverSongId || '').trim();
        if (selectedId) {
            const selected = songs.find(song => [song?.id, song?.songmid, song?.songId, song?.hash, song?.copyrightId].filter(Boolean).some(id => String(id) === selectedId));
            const selectedArtwork = imageForSong(selected);
            if (isRealArtwork(selectedArtwork)) return selectedArtwork;
        }
        const fallback = songs.map(imageForSong).find(isRealArtwork);
        return fallback || '/_player/assets/logo.svg';
    }

    // Initialize
    async function init() {
        console.log('[SongList] Initializing...');

        // The shell can reach DOMContentLoaded before the required-login
        // dialog has issued a user token. Avoid a 401 being mistaken for an
        // empty remote playlist; refresh() initializes after login.
        const auth = window.getUserAuthHeaders ? window.getUserAuthHeaders() : {};
        if (!auth['x-user-token']) return;
        initialized = true;

        // 优先从缓存读取
        const cachedSource = localStorage.getItem('songlist-source');
        if (cachedSource) {
            currentState.source = cachedSource;
            const sel = document.getElementById('songlist-source');
            if (sel) sel.value = cachedSource;
        }

        renderSortTabs();
        await loadTags();
        loadList();

        // Bind events that might not be in HTML attributes
        document.addEventListener('click', function (e) {
            const popup = document.getElementById('tag-selector-popup');
            const btn = document.getElementById('tag-selector-btn');
            if (popup && !popup.classList.contains('hidden')) {
                if (!popup.contains(e.target) && !btn.contains(e.target)) {
                    toggleTagSelector(false);
                }
            }
        });
    }

    async function refresh() {
        const auth = window.getUserAuthHeaders ? window.getUserAuthHeaders() : {};
        if (!auth['x-user-token']) return;
        if (!initialized) {
            await init();
            return;
        }
        await loadTags();
        await loadList(1);
    }

    // --- UI Helpers ---

    function toggleTagSelector(force) {
        const popup = document.getElementById('tag-selector-popup');
        const arrow = document.getElementById('tag-arrow');
        const isHidden = popup.classList.contains('hidden');
        const show = force !== undefined ? force : isHidden;

        if (show) {
            popup.classList.remove('hidden');
            setTimeout(() => {
                popup.classList.remove('opacity-0', 'translate-y-2');
                popup.classList.add('opacity-100', 'translate-y-0');
            }, 10);
            arrow.style.transform = 'rotate(180deg)';
            if (currentState.tags.length === 0) loadTags();
        } else {
            popup.classList.add('opacity-0', 'translate-y-2');
            popup.classList.remove('opacity-100', 'translate-y-0');
            arrow.style.transform = 'rotate(0deg)';
            setTimeout(() => popup.classList.add('hidden'), 300);
        }
    }

    function toggleExternalListModal(show) {
        const modal = document.getElementById('external-list-modal');
        const content = document.getElementById('external-list-modal-content');
        if (show) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => {
                content.classList.remove('scale-95', 'opacity-0');
                content.classList.add('scale-100', 'opacity-100');
            }, 10);
            // Default select current source
            document.getElementById('external-list-source').value = currentState.source;
            // Trigger entry check
            window.SongListManager.onExternalSourceChange();
        } else {
            content.classList.remove('scale-100', 'opacity-100');
            content.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                modal.classList.remove('flex');
                modal.classList.add('hidden');
            }, 300);
        }
    }

    function toggleQQInputModal(show) {
        const modal = document.getElementById('qq-input-modal');
        const content = document.getElementById('qq-input-modal-content');
        if (show) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => {
                content.classList.remove('scale-95', 'opacity-0');
                content.classList.add('scale-100', 'opacity-100');
            }, 10);
        } else {
            content.classList.remove('scale-100', 'opacity-100');
            content.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                modal.classList.remove('flex');
                modal.classList.add('hidden');
            }, 300);
        }
    }

    function toggleUserPlaylistModal(show) {
        const modal = document.getElementById('user-playlist-modal');
        const content = document.getElementById('user-playlist-modal-content');
        if (show) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => {
                content.classList.remove('scale-95', 'opacity-0');
                content.classList.add('scale-100', 'opacity-100');
            }, 10);
        } else {
            content.classList.remove('scale-100', 'opacity-100');
            content.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                modal.classList.remove('flex');
                modal.classList.add('hidden');
            }, 300);
        }
    }

    // --- Data Fetching ---

    async function loadTags() {
        const source = currentState.source;
        try {
            const res = await fetch(`${API_BASE}/songList/tags?source=${source}`, {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {},
                cache: 'no-store',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
            currentState.tags = data.tags || [];
            currentState.hotTags = data.hotTags || [];
            currentState.sortList = data.sortList || [];
            if (currentState.sortList.length > 0 && !currentState.sortList.some(opt => String(opt.id) === String(currentState.sortId))) {
                currentState.sortId = currentState.sortList[0].id;
            }
            renderSortTabs();
            renderTags();
        } catch (e) {
            console.error('[SongList] Load tags failed:', e);
        }
    }

    async function loadList(page = 1) {
        currentState.page = page;
        const { source, tagId, sortId } = currentState;
        const container = document.getElementById('songlist-container');

        container.innerHTML = `
            <div class="col-span-full py-20 text-center t-text-muted">
                <i class="fas fa-spinner fa-spin text-4xl mb-4 text-emerald-500"></i>
                <p>正在拉取 ${source.toUpperCase()} 歌单...</p>
            </div>
        `;

        try {
            const url = `${API_BASE}/songList/list?source=${source}&tagId=${encodeURIComponent(tagId)}&sortId=${encodeURIComponent(sortId)}&page=${page}`;
            const res = await fetch(url, {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {},
                cache: 'no-store',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);

            currentState.list = data.list || [];
            currentState.total = data.total || 0;
            currentState.limit = data.limit || 30;

            renderList();
            updatePaginationUI();
        } catch (e) {
            console.error('[SongList] Load list failed:', e);
            container.innerHTML = `<div class="col-span-full py-20 text-center text-red-500">加载失败: ${e.message}</div>`;
        }
    }

    async function loadDetail(id, source, page = 1) {
        if (page === 1) {
            resetDetailCloseState();
            detailGeneration += 1;
            detailClosing = false;
            notifyDetailContext(true, 'network', id);
        }
        const requestGeneration = detailGeneration;
        detailState.id = id;
        detailState.source = source;
        detailState.returnTab = 'songlist';
        detailState.isLocal = false;
        detailState.page = page;
        if (page === 1) pushDetailHistory('network', id);

        const detailView = ensureDetailHost('view-songlist');
        const listContainer = document.getElementById('sl-detail-list');

        if (page === 1) {
            detailView.classList.remove('hidden');
            detailView.classList.remove('pointer-events-none');
            detailView.style.pointerEvents = '';
            document.getElementById('sl-detail-collect')?.classList.remove('hidden');
            setTimeout(() => detailView.classList.remove('translate-x-full'), 10);
            listContainer.innerHTML = '<div class="flex items-center justify-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';

            // Clear old data to prevent flickering
            detailState.info = null;
            detailState.list = [];
            document.getElementById('sl-detail-name').innerText = '正在加载...';
            document.getElementById('sl-detail-title').innerText = '加载中...';
            if (window.setImg) window.setImg('sl-detail-cover', '/_player/assets/logo.svg');
            else document.getElementById('sl-detail-cover').src = '/_player/assets/logo.svg';
            document.getElementById('sl-detail-author').innerText = '';
            document.getElementById('sl-detail-subtitle').innerText = '正在加载歌单详情...';
            const descEl = document.getElementById('sl-detail-desc');
            if (descEl) descEl.innerText = '正在拉取详情，请稍后...';
            const statsEl = document.getElementById('sl-detail-stats');
            if (statsEl) statsEl.innerHTML = '';

            // Reset header collapse state
            const header = document.getElementById('sl-detail-header');
            const icon = document.getElementById('sl-detail-collapse-icon');
            if (header && icon && header.classList.contains('is-collapsed')) {
                header.classList.remove('is-collapsed', 'max-h-0', 'opacity-0', 'py-0', 'border-b-0', 'pointer-events-none');
                header.classList.add('max-h-[1000px]', 'p-4', 'md:p-6', 'border-b');
                icon.style.transform = 'rotate(0deg)';
            }

        }


        try {
            const url = `${API_BASE}/songList/detail?source=${source}&id=${encodeURIComponent(id)}&page=${page}`;
            const res = await fetch(url, {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {},
                cache: 'no-store',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);

            // A slow response from a detail that was already closed (or from a
            // previous playlist) must never repopulate the current detail DOM.
            if (requestGeneration !== detailGeneration
                || String(detailState.id) !== String(id)
                || detailState.source !== source
                || detailState.isLocal) return;

            detailState.info = data.info;

            // Normalize IDs to ensure batch operations work correctly
            const normalizedList = (data.list || []).map((song, idx) => {
                if (!song.id || song.id === 'undefined') {
                    song.id = song.songmid || song.songId || song.hash || song.copyrightId || song.mid || song.mediaMid || `sl_${detailState.id}_${idx}`;
                }
                return song;
            });

            if (page === 1) {
                detailState.list = normalizedList;
            } else {
                detailState.list = [...detailState.list, ...normalizedList];
            }
            detailState.total = data.total;
            window.viewingPlaylist = detailState.list; // Sync with global

            // Initialize Unified Search for this context only on first load
            if (page === 1) {
                window.ListSearch.init('songlist', {
                    renderCallback: () => window.SongListManager.renderDetail(),
                    getList: () => detailState.list
                });
            } else if (window.ListSearch && window.ListSearch.state.active && window.ListSearch.state.id === 'songlist') {
                // If appending more songs while filtering, refresh results
                window.ListSearch.handleSearch();
                return; // handleSearch already calls renderDetail
            }

            renderDetail();
        } catch (e) {
            console.error('[SongList] Load detail failed:', e);
            if (page === 1) {
                listContainer.innerHTML = `<div class="text-center text-red-500 p-10">加载失败: ${e.message}</div>`;
            }
        }
    }

    async function hydrateLocalDetailArtwork(list, listId, requestGeneration = detailGeneration) {
        if (!listId || !window.getUserAuthHeaders) return;
        try {
            const response = await fetch(`/api/v1/playlists/${encodeURIComponent(listId)}`, {
                headers: window.getUserAuthHeaders(),
                cache: 'no-store',
            });
            if (!response.ok) return;
            const payload = await response.json();
            const enrichedItems = payload?.data?.items || payload?.items || [];
            if (!Array.isArray(enrichedItems) || !enrichedItems.length) return;

            // A native playlist snapshot can contain an expired signed cover URL.
            // Refresh each row from the stable playlist API before the detail
            // table renders its <img> tags; ordinary <img> requests cannot carry
            // the x-user-token header themselves.
            const refreshedSongs = detailState.list.map((song, index) => {
                const enriched = enrichedItems[index];
                if (!enriched) return song;
                const artwork = enriched.artworkUrl || enriched.coverUrl || '';
                if (!artwork) {
                    return { ...song, hasCover: enriched.hasCover ?? song.hasCover };
                }
                return {
                    ...song,
                    img: artwork,
                    picUrl: artwork,
                    meta: { ...(song.meta || {}), picUrl: artwork },
                    _artworkUrl: artwork,
                    hasCover: enriched.hasCover ?? song.hasCover,
                    localTrackId: enriched.localTrackId || song.localTrackId,
                };
            });

            if (requestGeneration !== detailGeneration
                || detailState.id !== String(listId)
                || !detailState.isLocal
                || detailClosing
                || !isDetailVisible()) return;
            detailState.list = refreshedSongs;
            detailState.total = refreshedSongs.length;
            detailState.info.img = payload?.data?.artworkUrl || payload.artworkUrl || playlistArtwork(list, refreshedSongs);
            renderDetail();
        } catch (error) {
            console.debug('[SongList] 本地歌单封面刷新失败:', error?.message || error);
        }
    }

    function openLocalDetail(list) {
        if (!list) return;
        resetDetailCloseState();
        // A manual playlist open supersedes any automatic playback-resume
        // navigation that may still be queued from the previous session.
        delete window._pendingResumeListId;
        const songs = Array.isArray(list.list) ? list.list.map((song, index) => ({
            ...song,
            id: song.id || song.songmid || song.songId || song.hash || `local_${list.id}_${index}`,
            name: song.name || song.title || '未知歌曲',
            singer: song.singer || song.artist || '',
            albumName: song.albumName || song.album || '',
            source: song.source || 'local',
        })) : [];
        detailState.id = String(list.id || '');
        detailState.source = 'local';
        detailState.returnTab = 'my-playlists';
        detailState.isLocal = true;
        detailState.playlist = list;
        detailState.page = 1;
        detailState.total = songs.length;
        detailState.list = songs;
        detailGeneration += 1;
        detailClosing = false;
        detailState.info = {
            name: list.name || '未命名歌单',
            author: '音云 · 我的歌单',
            total: songs.length,
            img: playlistArtwork(list, songs),
            desc: list.sourceListId ? '网络歌单导入的本地歌单，可继续在曲库联动中补齐。' : '音云用户歌单。',
        };
        notifyDetailContext(true, 'local', detailState.id);
        // A local playlist detail is a real navigation state.  This makes the
        // iOS swipe-back/Android system back gesture close the detail view in
        // place instead of leaving the SPA (which previously made the account
        // playlists appear to vanish on the next render).
        pushDetailHistory('local', detailState.id);
        if (window.ListSearch) window.ListSearch.resetState();
        switchTab('my-playlists');
        const detailView = ensureDetailHost('view-my-playlists');
        const listContainer = document.getElementById('sl-detail-list');
        if (!detailView || !listContainer) return;
        detailView.classList.remove('hidden');
        detailView.classList.remove('pointer-events-none');
        detailView.style.pointerEvents = '';
        listContainer.innerHTML = '<div class="flex items-center justify-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';
        const collect = document.getElementById('sl-detail-collect');
        if (collect) collect.classList.add('hidden');
        window.viewingPlaylist = detailState.list;
        window.ListSearch?.init('songlist', { renderCallback: () => window.SongListManager.renderDetail(), getList: () => detailState.list });
        renderDetail();
        requestAnimationFrame(() => detailView.classList.remove('translate-x-full'));
        // Render immediately from the local snapshot, then replace stale local
        // cover URLs with fresh signed artwork without blocking navigation.
        void hydrateLocalDetailArtwork(list, detailState.id, detailGeneration);
    }

    // --- Rendering ---
    function renderTags() {
        const container = document.getElementById('tag-container');
        if (!container) return;
        let html = '';
        // Default All Tag
        html += `<div class="mb-6">
            <h4 class="text-xs font-bold t-text-muted uppercase tracking-wider mb-3">默认</h4>
            <div class="flex flex-wrap gap-2">
                <button onclick="window.SongListManager.selectTag('', '全部分类')" 
                    class="px-3 py-1.5 rounded-lg text-sm transition-all ${currentState.tagId === '' ? 'active-option' : 't-bg-main hover:t-bg-track'}">全部分类</button>
            </div>
        </div>`;

        // Hot Tags
        if (currentState.hotTags.length > 0) {
            html += `<div class="mb-6">
                <h4 class="text-xs font-bold t-text-muted uppercase tracking-wider mb-3">热门标签</h4>
                <div class="flex flex-wrap gap-2">
                    ${currentState.hotTags.map(tag => `
                        <button onclick="window.SongListManager.selectTag('${tag.id}', '${tag.name}')" 
                            class="px-3 py-1.5 rounded-lg text-sm transition-all ${currentState.tagId === tag.id ? 'active-option' : 't-bg-main hover:t-bg-track'}">${tag.name}</button>
                    `).join('')}
                </div>
            </div>`;
        }

        // All Categories
        currentState.tags.forEach(cat => {
            html += `<div class="mb-6">
                <h4 class="text-xs font-bold t-text-muted uppercase tracking-wider mb-3">${cat.name}</h4>
                <div class="flex flex-wrap gap-2">
                    ${cat.list.map(tag => `
                        <button onclick="window.SongListManager.selectTag('${tag.id}', '${tag.name}')" 
                            class="px-3 py-1.5 rounded-lg text-sm transition-all ${currentState.tagId === tag.id ? 'active-option' : 't-bg-main hover:t-bg-track'}">${tag.name}</button>
                    `).join('')}
                </div>
            </div>`;
        });

        container.innerHTML = html;
    }

    function renderList() {
        const container = document.getElementById('songlist-container');
        if (currentState.list.length === 0) {
            container.innerHTML = '<div class="col-span-full py-20 text-center t-text-muted">暂无数据</div>';
            return;
        }

        container.innerHTML = currentState.list.map(item => `
            <div class="group cursor-pointer" onclick="window.SongListManager.openDetail('${item.id}', '${currentState.source}')">
                <div class="relative aspect-square overflow-hidden rounded-2xl shadow-md transition-all group-hover:shadow-xl group-hover:-translate-y-1">
                    <img data-src="${item.img || '/_player/assets/logo.svg'}" src="/_player/assets/logo.svg"
                         class="lazy-image w-full h-full object-cover dynamic-logo is-placeholder" 
                         onerror="this.src='/_player/assets/logo.svg'; this.classList.add('is-placeholder');">
                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <div class="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center text-white shadow-lg transform scale-50 group-hover:scale-100 transition-transform duration-300">
                            <i class="fas fa-play ml-1"></i>
                        </div>
                    </div>
                </div>
                <div class="mt-3">
                    <h3 class="text-sm font-bold t-text-main line-clamp-2 leading-snug group-hover:text-emerald-500 transition-colors" title="${item.name}">${item.name}</h3>
                    ${item.author ? `<p class="text-xs t-text-muted mt-1.5 truncate">${item.author}</p>` : ''}
                    ${item.time ? `<p class="text-[11px] text-gray-400 mt-0.5 truncate">${item.time}</p>` : ''}
                    <div class="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400 font-medium">
                        ${item.total ? `<span><i class="fas fa-music text-[10px] mr-1"></i>${item.total}</span>` : ''}
                        ${(item.play_count || item.playCount) ? `<span><i class="fas fa-headphones text-[10px] mr-1"></i>${item.play_count || formatPlayCount(item.playCount)}</span>` : ''}
                    </div>
                </div>
            </div>
        `).join('');

        // Trigger Lazy Load
        if (typeof window.lazyLoadImages === 'function') {
            window.lazyLoadImages();
        }
    }

    function renderSortTabs() {
        const container = document.getElementById('songlist-sort-container');
        if (!container) return;
        const options = currentState.sortList;

        if (options.length === 0) return;

        // If current sortId is not in options, reset to first option
        if (!options.some(opt => String(opt.id) === String(currentState.sortId))) {
            currentState.sortId = options[0].id;
        }

        container.innerHTML = options.map(opt => `
            <button onclick="window.SongListManager.changeSort('${opt.id}')" 
                id="sort-${opt.id}"
                class="px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap flex-shrink-0 ${String(currentState.sortId) === String(opt.id) ? 'active-option' : 't-text-muted hover:t-bg-main'}">${opt.name}</button>
        `).join('');
    }

    function renderDetail() {
        const info = detailState.info;
        if (!info) return;

        const listContainer = document.getElementById('sl-detail-list');

        // Sync with global viewingPlaylist
        window.viewingPlaylist = detailState.list;

        const nameEl = document.getElementById('sl-detail-name');
        if (nameEl) {
            nameEl.innerHTML = window.createMarqueeHtml ? window.createMarqueeHtml(info.name) : info.name;
        }

        const titleEl = document.getElementById('sl-detail-title');
        if (titleEl) {
            titleEl.innerHTML = window.createMarqueeHtml ? window.createMarqueeHtml(info.name) : info.name;
        }

        if (window.setImg) window.setImg('sl-detail-cover', info.img || info.cover || '/_player/assets/logo.svg');
        else document.getElementById('sl-detail-cover').src = info.img || info.cover || '/_player/assets/logo.svg';

        const coverButton = document.getElementById('sl-detail-cover-btn');
        if (coverButton) {
            coverButton.classList.toggle('hidden', !detailState.isLocal);
            coverButton.classList.toggle('flex', detailState.isLocal);
        }

        const authorEl = document.getElementById('sl-detail-author');
        if (authorEl) {
            authorEl.innerHTML = window.createMarqueeHtml ? window.createMarqueeHtml(info.author || '', 'text-emerald-500 font-medium') : (info.author || '');
        }

        // Render stats (time, song count, play count)
        const statsHtml = [];
        const totalSongs = detailState.total || info.total || detailState.list.length;
        statsHtml.push(`<span><i class="fas fa-music text-[10px] mr-1"></i>${totalSongs} 首歌曲</span>`);

        if (info.play_count || info.playCount) {
            statsHtml.push(`<span><i class="fas fa-headphones text-[10px] mr-1"></i>${info.play_count || formatPlayCount(info.playCount)}</span>`);
        }
        if (info.time) {
            statsHtml.push(`<span><i class="far fa-calendar text-[10px] mr-1"></i>${info.time}</span>`);
        }

        const statsEl = document.getElementById('sl-detail-stats');
        if (statsEl) {
            statsEl.innerHTML = statsHtml.join('');
        }

        // Hide the original count element as we merged it into stats
        const countEl = document.getElementById('sl-detail-count');
        if (countEl) countEl.style.display = 'none';

        document.getElementById('sl-detail-subtitle').innerText = `${info.author ? info.author + ' · ' : ''}${totalSongs} 首`;

        const descEl = document.getElementById('sl-detail-desc');
        const descBtn = document.getElementById('sl-detail-desc-btn');
        descEl.innerText = info.desc || '暂无介绍';

        // Reset description styles
        descEl.classList.add('line-clamp-3', 'md:line-clamp-4');
        descEl.dataset.expanded = 'false';
        if (descBtn) {
            descBtn.innerHTML = '展开全部 <i class="fas fa-chevron-down text-[10px] ml-0.5"></i>';
            descBtn.classList.add('hidden');

            // Wait for next frame to check if text overflows
            requestAnimationFrame(() => {
                // If scrollHeight is greater than clientHeight, it means it is truncated
                if (descEl.scrollHeight > descEl.clientHeight) {
                    descBtn.classList.remove('hidden');
                }
            });
        }

        // --- Unified Search & Filtering Logic ---
        const displayList = window.ListSearch.getDisplayList(detailState.list);

        listContainer.innerHTML = displayList.map((obj, displayIdx) => {
            const song = obj.item;
            const index = obj.originalIndex;
            const isSelected = window.selectedItems.has(String(song.id));
            const isMatched = window.ListSearch.isMatched(index);
            const isCurrentMatch = window.ListSearch.isCurrentMatch(index);

            // Highlight Logic: 
            // - Current Match: Strong border and subtle background
            // - Matched: Subtle background
            // - Selected: Theme background (will be defined in CSS)
            let rowClass = 'grid grid-cols-12 gap-4 p-3 rounded-xl hover:t-bg-panel group transition-colors cursor-pointer ';
            if (isCurrentMatch) rowClass += 'search-current ';
            else if (isMatched) rowClass += 'search-match ';
            if (isSelected) rowClass += 'row-selected ring-1 ring-emerald-500/30 ';

            return `
            <div id="sl-row-${index}" class="${rowClass}" data-song-id="${String(song.id)}" 
                 onclick="window.SongListManager.handleRowClick(${index})">
                <div class="col-span-1 sm:col-span-1 text-center text-gray-400 font-mono text-xs flex items-center justify-center">
                    ${window.batchMode ? `
                        <input type="checkbox" 
                               class="batch-checkbox w-4 h-4 text-emerald-600 rounded" 
                               data-song-id="${String(song.id)}"
                               ${isSelected ? 'checked' : ''}
                               onclick="event.stopPropagation(); handleBatchSelect('${String(song.id)}', this.checked);">
                    ` : index + 1}
                </div>
                <!-- Title & Info -->
                <div class="col-span-9 sm:col-span-9 md:col-span-5 lg:col-span-4 flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 md:w-12 md:h-12 flex-shrink-0 relative rounded-lg overflow-hidden shadow-sm border t-border-main group-hover:shadow-md transition-all group-hover:scale-105 duration-300">
                        <img data-src="${window.getImgUrl ? window.getImgUrl(song) : (song.img || song.albumImg || '/_player/assets/logo.svg')}" src="/_player/assets/logo.svg"
                             class="lazy-image w-full h-full object-cover dynamic-logo is-placeholder" 
                             onerror="this.src='/_player/assets/logo.svg'; this.classList.add('is-placeholder');">
                        <div class="absolute inset-0 bg-black/20 hidden group-hover:flex items-center justify-center transition-all">
                            <i class="fas fa-play text-white text-xs"></i>
                        </div>
                    </div>
                    <div class="min-w-0 flex-1 flex flex-col justify-center overflow-hidden">
                        <div class="font-bold text-sm t-text-main group-hover:text-emerald-500 transition-colors">
                            ${window.createMarqueeHtml ? window.createMarqueeHtml(song.name) : `<span class="truncate">${song.name}</span>`}
                        </div>
                        <div class="flex items-center gap-1 mt-0.5 overflow-hidden">
                             ${window.getSourceTag ? window.getSourceTag(song.source || detailState.source) : ''}
                             ${window.getQualityTags ? window.getQualityTags(song) : ''}
                             <div class="md:hidden flex-1 min-w-0">
                                ${window.createMarqueeHtml ? window.createMarqueeHtml(song.singer, 'text-[10px] t-text-muted') : `<span class="text-[10px] t-text-muted truncate">${song.singer}</span>`}
                             </div>
                        </div>
                    </div>
                </div>
                <!-- Artist -->
                <div class="hidden md:flex md:col-span-3 items-center text-xs t-text-muted overflow-hidden">
                    ${window.createMarqueeHtml ? window.createMarqueeHtml(song.singer) : `<span class="truncate">${song.singer}</span>`}
                </div>
                <!-- Album -->
                <div class="hidden lg:flex lg:col-span-2 items-center text-xs t-text-muted truncate">
                    ${song.albumName || '--'}
                </div>
                <!-- Duration -->
                <div class="hidden md:flex md:col-span-2 lg:col-span-1 items-center justify-end text-xs font-mono t-text-muted">
                    ${song.interval || '--:--'}
                </div>
                <!-- Actions -->
                <div class="col-span-2 md:col-span-1 flex items-center justify-end gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="p-1.5 hover:bg-emerald-50 rounded-lg text-emerald-600 transition-colors" 
                            title="播放" 
                            onclick="event.stopPropagation(); window.SongListManager.playSong(${index})">
                        <i class="fas fa-play w-3.5 h-3.5"></i>
                    </button>
                    <button class="p-1.5 hover:bg-blue-50 rounded-lg text-blue-600 transition-colors" 
                            title="下载" 
                            onclick="event.stopPropagation(); downloadSong(${JSON.stringify(song).replace(/"/g, '&quot;')})">
                        <i class="fas fa-download w-3.5 h-3.5"></i>
                    </button>
                </div>
            </div>
        `}).join('');

        // Trigger Lazy Load
        if (typeof window.lazyLoadImages === 'function') {
            window.lazyLoadImages();
        }
        if (typeof window.applyMarqueeChecks === 'function') {
            window.applyMarqueeChecks();
        }
    }

    function updatePaginationUI() {
        document.getElementById('songlist-page-info').innerText = `第 ${currentState.page} 页`;
        document.getElementById('btn-songlist-prev').disabled = currentState.page <= 1;
        // Simplified check for next page, can be improved with total/limit
        document.getElementById('btn-songlist-next').disabled = currentState.list.length < currentState.limit;
    }

    // --- Public Methods ---

    return {
        init,
        refresh,
        selectTag: function (id, name) {
            currentState.tagId = id;
            currentState.tagName = name;
            document.getElementById('current-tag-name').innerText = name;
            toggleTagSelector(false);
            loadList(1);
        },
        changeSource: async function () {
            currentState.source = document.getElementById('songlist-source').value;

            // 保存到缓存
            localStorage.setItem('songlist-source', currentState.source);

            currentState.tagId = '';
            currentState.tagName = '全部分类';
            document.getElementById('current-tag-name').innerText = '全部分类';
            currentState.tags = [];
            currentState.sortList = [];
            currentState.sortId = '';
            renderSortTabs();
            await loadTags();
            loadList(1);
        },
        changeSort: function (sort) {
            currentState.sortId = sort;
            renderSortTabs();
            loadList(1);
        },
        changePage: function (delta) {
            const next = currentState.page + delta;
            if (next < 1) return;
            loadList(next);
            document.getElementById('view-songlist')?.scrollTo({ top: 0, behavior: 'smooth' });
        },
        openDetail: function (id, source) {
            if (window.ListSearch) window.ListSearch.resetState();
            loadDetail(id, source);
        },
        openLocalDetail,
        openCoverPicker: function () {
            if (!detailState.isLocal || !detailState.playlist) {
                window.showToast?.('info', '只有我的歌单可以设置封面');
                return;
            }
            const modal = document.getElementById('playlist-cover-modal');
            const options = document.getElementById('playlist-cover-options');
            if (!modal || !options) return;
            const selectedId = String(detailState.playlist.coverSongId || '');
            const songs = detailState.list || [];
            options.innerHTML = `<button type="button" data-cover-song-id="" class="playlist-cover-option ${selectedId ? '' : 'is-selected'}"><span class="playlist-cover-option-image"><img src="/_player/assets/logo.svg" alt="自动选择"></span><strong>自动选择</strong><small>第一张可用封面</small></button>${songs.map(song => {
                const id = String(song.id || song.songmid || song.songId || song.hash || '');
                const title = song.name || song.title || '未知歌曲';
                const subtitle = [song.singer || song.artist, song.albumName || song.album].filter(Boolean).join(' · ');
                return `<button type="button" data-cover-song-id="${escapeHtml(id)}" class="playlist-cover-option ${selectedId === id ? 'is-selected' : ''}"><span class="playlist-cover-option-image"><img src="${escapeHtml(imageForSong(song))}" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='/_player/assets/logo.svg'"></span><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small title="${escapeHtml(subtitle)}">${escapeHtml(subtitle || '无专辑信息')}</small></button>`;
            }).join('')}`;
            options.querySelectorAll('[data-cover-song-id]').forEach(button => button.addEventListener('click', () => savePlaylistCover(button.dataset.coverSongId || '')));
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        },
        closeCoverPicker: function () {
            const modal = document.getElementById('playlist-cover-modal');
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        },
        isDetailOpen: function () {
            const detailView = document.getElementById('songlist-detail-view');
            return Boolean(detailView && !detailView.classList.contains('hidden'));
        },
        getReturnTab: function () {
            return detailState.returnTab || (detailState.isLocal ? 'my-playlists' : 'songlist');
        },
        closeDetailForTabSwitch: function () {
            this.closeCoverPicker();
            delete window._pendingResumeListId;
            restoreDetailHistory();
            const detailView = document.getElementById('songlist-detail-view');
            if (!detailView) {
                notifyDetailContext(false, detailState.isLocal ? 'local' : 'network', detailState.id);
                return;
            }
            if (detailCloseTimer) {
                clearTimeout(detailCloseTimer);
                detailCloseTimer = null;
            }
            detailClosing = false;
            detailGeneration += 1;
            detailView.classList.add('hidden', 'pointer-events-none');
            detailView.classList.remove('translate-x-full');
            detailView.style.pointerEvents = 'none';
            ensureDetailHost(detailState.hostParentId || (detailState.isLocal ? 'view-my-playlists' : 'view-songlist'));
            notifyDetailContext(false, detailState.isLocal ? 'local' : 'network', detailState.id);
        },
        closeDetail: function (fromPopState = false) {
            this.closeCoverPicker();
            if (detailClosing) return;
            const detailView = document.getElementById('songlist-detail-view');
            if (!detailView) {
                restoreDetailHistory();
                notifyDetailContext(false, detailState.isLocal ? 'local' : 'network', detailState.id);
                return;
            }
            // Physical/browser back has already moved to the base entry.  The
            // in-app button is still on the detail entry; restore it now and
            // never call history.back() from inside the SPA.
            if (!fromPopState) restoreDetailHistory();
            else clearDetailHistoryMarker();
            delete window._pendingResumeListId;
            detailClosing = true;
            detailGeneration += 1;
            detailView.classList.add('translate-x-full', 'pointer-events-none');
            detailView.style.pointerEvents = 'none';
            const returnTab = detailState.returnTab || 'songlist';
            const hostParentId = detailState.hostParentId || (detailState.isLocal ? 'view-my-playlists' : 'view-songlist');
            // Invalidate delayed detail/account refreshes before the closing
            // animation starts.  They must not re-open the old list view.
            notifyDetailContext(false, detailState.isLocal ? 'local' : 'network', detailState.id);
            if (detailCloseTimer) clearTimeout(detailCloseTimer);
            detailCloseTimer = setTimeout(() => {
                detailView.classList.add('hidden');
                detailView.classList.remove('translate-x-full');
                detailView.style.pointerEvents = 'none';
                ensureDetailHost(hostParentId);
                switchTab(returnTab);
                detailClosing = false;
                detailCloseTimer = null;
            }, 300);
        },
        toggleTagSelector,
        playSong: function (index) {
            const song = detailState.list[index];
            if (song && typeof window.updatePlaylist === 'function') {
                const listWithSource = detailState.list.map(s => ({ ...s, source: s.source || detailState.source }));
                const playback = window.WebPlayerState.buildSingleTrackPlayback(
                    listWithSource,
                    index,
                    settings.switchPlaylistOnSongListPlay !== false
                );
                window.updatePlaylist(playback.list, playback.index, 'songlist', true);
            }
        },
        playAll: function () {
            if (detailState.list.length === 0) return;
            if (typeof window.updatePlaylist === 'function') {
                const listWithSource = detailState.list.map(s => ({ ...s, source: s.source || detailState.source }));
                // 播放全部：不加入默认列表 (shouldAddToDefault = false)
                window.updatePlaylist(listWithSource, 0, 'songlist', false);
                this.closeDetail();
            }
        },
        search: async function () {
            const text = document.getElementById('songlist-search-input').value.trim();
            if (!text) {
                loadList(1);
                return;
            }

            const container = document.getElementById('songlist-container');
            container.innerHTML = '<div class="col-span-full py-20 text-center t-text-muted"><i class="fas fa-spinner fa-spin text-4xl mb-4 text-emerald-500"></i><p>正在搜索歌单...</p></div>';

            try {
                const url = `${API_BASE}/songList/search?source=${currentState.source}&text=${encodeURIComponent(text)}&page=1`;
                const res = await fetch(url, {
                    headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {},
                    cache: 'no-store',
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
                currentState.list = data.list || [];
                currentState.total = data.total || 0;
                renderList();
                document.getElementById('songlist-pagination').classList.add('hidden');
            } catch (e) {
                console.error('[SongList] Search failed:', e);
                container.innerHTML = `<div class="col-span-full py-20 text-center text-red-500">搜索失败: ${e.message}</div>`;
            }
        },
        handleRowClick: function (index) {
            if (window.batchMode) {
                const song = detailState.list[index];
                const id = String(song.id);
                const isChecked = !window.selectedItems.has(id);
                window.handleBatchSelect(id, isChecked);
            } else {
                this.playSong(index);
            }
        },
        renderDetail: renderDetail,
        openExternalListModal: function () {
            toggleExternalListModal(true);
        },
        closeExternalListModal: function () {
            toggleExternalListModal(false);
        },
        handleOpenExternalList: function () {
            const source = document.getElementById('external-list-source').value;
            const input = document.getElementById('external-list-input').value.trim();
            if (!input) {
                if (window.showToast) window.showToast('info', '请输入歌单链接或 ID');
                return;
            }
            this.openDetail(input, source);
            this.closeExternalListModal();
            // Clear input for next time
            document.getElementById('external-list-input').value = '';
        },
        getCurrentDetail: function () {
            return {
                id: detailState.id,
                source: detailState.source,
                info: detailState.info,
                list: detailState.list
            };
        },
        onExternalSourceChange: function () {
            const source = document.getElementById('external-list-source').value;
            const entry = document.getElementById('tx-user-playlist-entry');
            if (source === 'tx') {
                entry.classList.remove('hidden');
            } else {
                entry.classList.add('hidden');
            }
        },
        openQQInputModal: function () {
            toggleQQInputModal(true);
        },
        closeQQInputModal: function () {
            toggleQQInputModal(false);
            document.getElementById('qq-input-field').value = '';
        },
        handleQQSubmit: async function () {
            const uid = document.getElementById('qq-input-field').value.trim();
            if (!uid) {
                if (window.showToast) window.showToast('info', '请输入 QQ 号');
                return;
            }
            this.closeQQInputModal();
            this.closeExternalListModal();

            toggleUserPlaylistModal(true);
            const container = document.getElementById('user-playlist-container');
            const title = document.getElementById('user-playlist-title');
            const subtitle = document.getElementById('user-playlist-subtitle');
            const avatarImg = document.getElementById('user-playlist-avatar');

            title.innerText = '拉取 QQ 歌单';
            subtitle.innerText = `正在拉取用户 ${uid} 的歌单...`;
            avatarImg.classList.add('hidden');
            container.innerHTML = '<div class="flex items-center justify-center py-20"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';

            try {
            const res = await fetch(`${API_BASE}/songList/userPlaylist?source=tx&uid=${uid}`, {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {},
                cache: 'no-store',
            });
            const data = await res.json();

            if (!res.ok || data.error) throw new Error(data.error || data.message || `HTTP ${res.status}`);

                title.innerText = `${data.nickname || uid} 的歌单`;
                subtitle.innerText = `共发现 ${data.list.length} 个歌单`;

                if (data.avatar) {
                    avatarImg.src = data.avatar;
                    avatarImg.classList.remove('hidden');
                }

                if (data.list.length === 0) {
                    container.innerHTML = '<div class="text-center py-10 t-text-muted">未找到公开歌单</div>';
                    return;
                }

                container.innerHTML = data.list.map(item => `
                    <div class="flex items-center gap-4 p-3 rounded-xl hover:t-bg-main transition-all cursor-pointer group" 
                         onclick="window.SongListManager.selectUserPlaylist('${item.id}')">
                        <div class="relative flex-shrink-0">
                            <img src="${item.img || '/_player/assets/logo.svg'}" class="w-12 h-12 rounded-lg object-cover shadow-sm group-hover:scale-105 transition-transform">
                        </div>
                        <div class="flex-1 min-w-0">
                            <h4 class="text-sm font-bold t-text-main truncate">${item.name}</h4>
                            <p class="text-xs t-text-muted mt-1 uppercase tracking-tighter">
                                ${item.total || 0} 首 · ${item.play_count || 0} 次播放 · <span class="text-emerald-500/80">tid:${item.id}</span>
                            </p>
                        </div>
                        <i class="fas fa-chevron-right text-gray-300 text-xs transition-transform group-hover:translate-x-1"></i>
                    </div>
                `).join('');
            } catch (e) {
                console.error('[UserPlaylist] Load failed:', e);
                container.innerHTML = `<div class="text-center py-10 text-red-500">加载失败: ${e.message}</div>`;
                subtitle.innerText = '加载失败';
            }
        },
        selectUserPlaylist: function (id) {
            this.openDetail(id, 'tx');
            this.closeUserPlaylistModal();
        },
        closeUserPlaylistModal: function () {
            toggleUserPlaylistModal(false);
        }
    };

    async function savePlaylistCover(coverSongId) {
        if (!detailState.isLocal || !detailState.playlist || !detailState.id) return;
        const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };
        try {
            const response = await fetch(`/api/v1/playlists/${encodeURIComponent(detailState.id)}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ coverSongId: coverSongId || null }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error?.message || '保存歌单封面失败');
            detailState.playlist.coverSongId = coverSongId || undefined;
            if (window.currentListData?.userList) {
                const target = window.currentListData.userList.find(item => String(item.id) === String(detailState.id));
                if (target) {
                    if (coverSongId) target.coverSongId = coverSongId;
                    else delete target.coverSongId;
                    target.artworkUrl = playlistArtwork(target, target.list || detailState.list);
                }
            }
            detailState.info.img = playlistArtwork(detailState.playlist, detailState.list);
            renderDetail();
            window.SongListManager.closeCoverPicker();
            window.showToast?.('success', coverSongId ? '歌单封面已更新' : '已恢复自动选择歌单封面');
            if (typeof window.renderMyPlaylists === 'function') window.renderMyPlaylists(window.currentListData);
        } catch (error) {
            window.showToast?.('error', error.message || '保存歌单封面失败');
        }
    }
})();

// Global proxies for HTML onclick attributes
function toggleTagSelector() { window.SongListManager.toggleTagSelector(); }
function changeSongListSource() { window.SongListManager.changeSource(); }
function changeSongListSort(sort) { window.SongListManager.changeSort(sort); }
function changeSongListPage(delta) { window.SongListManager.changePage(delta); }
function closeSongListDetail() { window.SongListManager.closeDetail(); }
function playAllInSongList() { window.SongListManager.playAll(); }
function handleSongListSearchKeyPress(e) { if (e.key === 'Enter') window.SongListManager.search(); }
function openExternalListModal() { window.SongListManager.openExternalListModal(); }
function closeExternalListModal() { window.SongListManager.closeExternalListModal(); }
function handleOpenExternalList() { window.SongListManager.handleOpenExternalList(); }
function onExternalSourceChange() { window.SongListManager.onExternalSourceChange(); }
function openQQInputModal() { window.SongListManager.openQQInputModal(); }
function closeQQInputModal() { window.SongListManager.closeQQInputModal(); }
function handleQQSubmit() { window.SongListManager.handleQQSubmit(); }
function closeUserPlaylistModal() { window.SongListManager.closeUserPlaylistModal(); }
function openPlaylistCoverPicker() { window.SongListManager.openCoverPicker(); }
function closePlaylistCoverPicker() { window.SongListManager.closeCoverPicker(); }

function toggleSongListDesc() {
    const descEl = document.getElementById('sl-detail-desc');
    const descBtn = document.getElementById('sl-detail-desc-btn');
    if (!descEl || !descBtn) return;

    const isExpanded = descEl.dataset.expanded === 'true';
    if (isExpanded) {
        descEl.classList.add('line-clamp-3', 'md:line-clamp-4');
        descEl.dataset.expanded = 'false';
        descBtn.innerHTML = '展开全部 <i class="fas fa-chevron-down text-[10px] ml-0.5"></i>';
    } else {
        descEl.classList.remove('line-clamp-3', 'md:line-clamp-4');
        descEl.dataset.expanded = 'true';
        descBtn.innerHTML = '收起 <i class="fas fa-chevron-up text-[10px] ml-0.5"></i>';
    }
}

// Helper for formatting large numbers
function formatPlayCount(count) {
    if (!count) return '0';
    if (count > 100000000) return (count / 100000000).toFixed(1) + '亿';
    if (count > 10000) return (count / 10000).toFixed(1) + '万';
    return count;
}

/**
 * Toggle the visibility of the song list detail header (cover, description, etc.)
 * to allow more space for the song list itself.
 */
function toggleSlDetailHeader() {
    const header = document.getElementById('sl-detail-header');
    const icon = document.getElementById('sl-detail-collapse-icon');
    if (!header || !icon) return;

    const isCollapsed = header.classList.contains('is-collapsed');

    if (isCollapsed) {
        // Restore
        header.classList.remove('is-collapsed', 'max-h-0', 'opacity-0', 'py-0', 'border-b-0', 'pointer-events-none');
        header.classList.add('max-h-[1000px]', 'p-4', 'md:p-6', 'border-b');
        icon.style.transform = 'rotate(0deg)';
    } else {
        // Collapse
        header.classList.remove('max-h-[1000px]', 'p-4', 'md:p-6', 'border-b');
        header.classList.add('is-collapsed', 'max-h-0', 'opacity-0', 'py-0', 'border-b-0', 'pointer-events-none');
        icon.style.transform = 'rotate(180deg)';
    }
}
