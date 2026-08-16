/* 音云曲库联动管理界面：网络歌单 -> 本地匹配 -> 音云补齐 -> Songloft 同步 */
(function () {
    'use strict';

    const state = {
        token: '',
        username: '',
        importId: '',
        importData: null,
        importRecords: [],
        localPlaylists: [],
        remotePlaylists: [],
        filter: 'all',
        selected: new Set(),
        downloadSelections: new Map(),
        queueSongs: new Map(),
        candidateIndex: -1,
        candidateQueueId: '',
        candidateSource: 'aggregate',
        candidateQuery: '',
        candidateContext: 'import',
        candidateResults: [],
        localCandidate: null,
        previewDragBound: false,
        candidateSearchSerial: 0,
        previewBound: false,
        queueLoading: false,
        panelActive: false,
        timer: null,
    };

    const el = id => document.getElementById(id);
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
    const unwrap = payload => payload?.data ?? payload;

    async function api(path, options = {}) {
        const legacyToken = localStorage.getItem('lx_user_token') || '';
        const legacyUser = localStorage.getItem('lx_sync_user') || '';
        const nativeToken = state.token && state.token !== 'legacy' ? state.token : '';
        if (!nativeToken && !legacyToken && path !== '/api/v1/auth/login') throw new Error('请先登录音云用户');
        const adminPassword = window.app?.password || localStorage.getItem('lx_auth') || '';
        const response = await fetch(path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(nativeToken ? { Authorization: `Bearer ${nativeToken}` } : {}),
                ...(!nativeToken && legacyToken ? { 'X-User-Name': legacyUser, 'X-User-Token': legacyToken } : {}),
                ...(adminPassword ? { 'X-Frontend-Auth': adminPassword } : {}),
                ...(options.headers || {}),
            },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
        return unwrap(payload);
    }

    function setBusy(buttonId, busy, text) {
        const button = el(buttonId);
        if (!button) return;
        if (busy) {
            button.dataset.original = button.innerHTML;
            button.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${escapeHtml(text)}`;
        } else if (button.dataset.original) {
            button.innerHTML = button.dataset.original;
        }
        button.disabled = busy;
    }

    function importRecordLabel(record, playlist) {
        const name = String(playlist?.name || record?.name || record?.sourcePlaylistName || '未命名歌单').trim()
        const source = String(record?.source || '').toUpperCase()
        const count = Number(playlist?.trackCount ?? record?.trackCount ?? 0)
        const date = record?.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
        return `${name} · ${source || '网络'} · ${count} 首${date ? ` · ${date}` : ''}`
    }

    function recordForPlaylistId(playlistId) {
        return state.importRecords.find(record => String(record?.yinyunPlaylistId) === String(playlistId)) || null
    }

    function renderImportHistory(records = state.importRecords) {
        const select = el('integration-import-history')
        const open = el('integration-open-history-btn')
        if (!select) return
        const sorted = [...(records || [])].sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
        const playlists = new Map((state.localPlaylists || []).map(item => [String(item.id), item]))
        const active = playlists.size
            ? sorted.filter(record => playlists.has(String(record?.yinyunPlaylistId)))
            : sorted
        const seenYinyunPlaylists = new Set()
        const visible = active.filter(record => {
            const id = String(record?.yinyunPlaylistId || '')
            if (!id || seenYinyunPlaylists.has(id)) return false
            seenYinyunPlaylists.add(id)
            return true
        })
        state.importRecords = visible
        if (state.importId && !visible.some(record => record.importId === state.importId) && playlists.size) {
            state.importId = ''
            state.importData = null
            el('integration-result-panel')?.classList.add('hidden')
        }
        select.innerHTML = visible.length
            ? `<option value="">选择当前音云歌单</option>${visible.map(record => {
                const playlist = playlists.get(String(record?.yinyunPlaylistId))
                return `<option value="${escapeHtml(record.yinyunPlaylistId)}">${escapeHtml(importRecordLabel(record, playlist))}</option>`
            }).join('')}`
            : '<option value="">暂无当前音云导入歌单</option>'
        const currentRecord = visible.find(record => record.importId === state.importId)
        if (currentRecord) select.value = currentRecord.yinyunPlaylistId
        if (open) open.disabled = !select.value
    }

    function onHistoryChange() {
        const playlistId = el('integration-import-history')?.value || ''
        const record = recordForPlaylistId(playlistId)
        const open = el('integration-open-history-btn')
        if (open) open.disabled = !record
        if (record) state.importId = String(record.importId || '')
    }

    function notifyError(error) {
        console.error('[LibraryIntegration]', error);
        if (typeof showError === 'function') showError(error.message || String(error));
    }

    function updateAuth(connected) {
        const badge = el('integration-auth-state');
        if (!badge) return;
        badge.textContent = connected ? `已连接 · ${state.username}` : '未连接';
        badge.classList.toggle('is-online', connected);
        badge.classList.toggle('is-offline', !connected);
    }

    async function login() {
        const username = el('integration-username')?.value.trim();
        const password = el('integration-password')?.value;
        if (!username || !password) return notifyError(new Error('请输入音云用户名和密码'));
        setBusy('integration-login-btn', true, '连接中');
        try {
            const response = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error?.message || '用户登录失败');
            const data = unwrap(payload);
            state.token = data.accessToken || data.access_token || '';
            if (!state.token) throw new Error('服务器未返回用户令牌');
            state.username = username;
            el('integration-password').value = '';
            state.importId = '';
            state.importData = null;
            updateAuth(true);
            sessionStorage.setItem('yinyun.integration.username', username);
            if (typeof showSuccess === 'function') showSuccess(`已连接用户 ${username}`);
            await refreshAll();
            // 登录按钮位于曲库联动面板内；无论导航事件是否在脚本加载前触发，
            // 登录成功都应明确开启当前面板的轮询。
            setActive(true);
        } catch (error) {
            state.token = '';
            updateAuth(false);
            notifyError(error);
        } finally {
            setBusy('integration-login-btn', false);
        }
    }

    async function loadStatus() {
        const [status, scan, library] = await Promise.all([
            api('/api/v1/integration/songloft/status'),
            api('/api/v1/integration/songloft/scan').catch(error => ({ status: 'unavailable', error: error.message })),
            api('/api/v1/integration/library/status').catch(error => ({ error: error.message })),
        ]);
        el('integration-native-status').textContent = status.available ? '可用' : '不可用';
        el('integration-native-status').className = status.available ? 'is-ok' : 'is-error';
        el('integration-native-detail').textContent = status.available ? '原生 API 已连接' : (status.errorCode || '连接失败');
        el('integration-subsonic-status').textContent = status.subsonicAvailable ? '可用' : '不可用';
        el('integration-subsonic-status').className = status.subsonicAvailable ? 'is-ok' : 'is-error';
        el('integration-subsonic-detail').textContent = status.subsonicAvailable ? 'OpenSubsonic 已连接' : '只读回退不可用';
        const scanStatus = scan.status || (scan.scanning ? 'scanning' : 'unknown');
        const scanLabels = { idle: '空闲', scanning: '扫描中', importing: '导入中', splitting_cue: '处理 CUE', completed: '已完成', failed: '失败', unavailable: '不可用' };
        el('integration-scan-status').textContent = scanLabels[scanStatus] || scanStatus;
        el('integration-scan-status').className = ['idle', 'completed'].includes(scanStatus) ? 'is-ok' : scanStatus === 'failed' ? 'is-error' : '';
        el('integration-scan-detail').textContent = scan.error || (scan.current_file ? `正在处理 ${scan.current_file}` : 'Songloft 扫描状态');
        const yinyunCount = Number(library.yinyunTracks);
        const songloftCount = Number(library.songloftTracks);
        el('integration-yinyun-index-count').textContent = Number.isFinite(yinyunCount) ? yinyunCount.toLocaleString() : '—';
        el('integration-songloft-index-count').textContent = Number.isFinite(songloftCount) ? songloftCount.toLocaleString() : '—';
        el('integration-yinyun-index-detail').textContent = library.error ? library.error : `${(library.locations || []).join(' + ')} · 音频 ${Number(library.yinyunAudioTracks || yinyunCount || 0).toLocaleString()} 首`;
        el('integration-songloft-index-detail').textContent = library.error ? library.error : `${scanLabels[scanStatus] || scanStatus} · 共享目录索引`;
    }

    async function loadImportRecords() {
        const data = await api('/api/v1/integration/playlist/imports')
        if (Array.isArray(data.playlists)) state.localPlaylists = data.playlists
        renderImportHistory(data.records || [])
    }

    async function loadPlaylists() {
        const [local, remote] = await Promise.all([
            api('/api/v1/playlists'),
            api('/api/v1/integration/songloft/playlists'),
        ]);
        state.localPlaylists = Array.isArray(local) ? local : []
        state.remotePlaylists = Array.isArray(remote.playlists) ? remote.playlists : []
        const localSelect = el('integration-yinyun-playlist');
        const remoteSelect = el('integration-songloft-playlist');
        localSelect.innerHTML = '<option value="">选择音云歌单</option>' + local.map(item =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${Number(item.trackCount || 0)} 首</option>`).join('');
        remoteSelect.innerHTML = '<option value="">按同名自动创建/匹配</option>' + (remote.playlists || []).map(item =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${Number(item.song_count || item.songCount || 0)} 首</option>`).join('');
        if (state.importData?.yinyunPlaylistId) localSelect.value = state.importData.yinyunPlaylistId;
        localSelect.onchange = updatePlaylistDeleteButtons;
        remoteSelect.onchange = updatePlaylistDeleteButtons;
        updatePlaylistDeleteButtons();
        renderImportHistory(state.importRecords)
    }

    function queueLabel(status) {
        return ({ waiting: '等待', downloading: '下载中', tagging: '写入元数据', finished: '完成', exists: '已存在', error: '失败', paused: '暂停' })[status] || status;
    }

    function normalizeQueueStatus(value) {
        const raw = String(value || '').toLowerCase();
        return raw === 'queued' || raw === 'pending' ? 'waiting'
            : raw === 'processing' || raw === 'downloading' ? 'downloading'
                : raw === 'success' || raw === 'completed' ? 'finished'
                    : raw === 'failed' ? 'error' : raw || 'waiting';
    }

    async function loadQueue() {
        if (!state.token || state.queueLoading) return;
        state.queueLoading = true;
        try {
            const data = await api('/api/v1/downloads');
            const items = (Array.isArray(data?.items) ? data.items : []).map(item => ({
                ...item,
                status: normalizeQueueStatus(item?.status),
                errorMsg: item?.errorMsg || item?.error || item?.message || '',
            }));
            const updated = el('integration-queue-updated');
            if (updated) updated.textContent = `刚刚刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
            const counts = items.reduce((map, item) => {
                const status = item.status;
                map[status] = (map[status] || 0) + 1;
                return map;
            }, {});
            const active = (counts.waiting || 0) + (counts.downloading || 0) + (counts.tagging || 0);
            el('integration-queue-status').textContent = String(active);
            el('integration-queue-detail').textContent = `总计 ${items.length} · 并发 ${data.concurrency || 0}`;
            ['downloading', 'waiting', 'finished', 'exists', 'error'].forEach(status => {
                const count = el(`integration-queue-${status}`)
                if (count) count.textContent = String(counts[status] || 0)
            })
            // 历史队列默认展示最近任务，同时把失败任务置顶，确保“重试/换源”
            // 不会因为失败任务较旧而只停留在统计数字里。
            const recent = [...items].reverse();
            const failed = recent.filter(item => item.status === 'error');
            const visible = [...failed, ...recent.filter(item => item.status !== 'error')]
                .filter((item, index, list) => list.findIndex(other => String(other.id) === String(item.id)) === index)
                .slice(0, 8);
            state.queueSongs.clear();
            visible.forEach(item => state.queueSongs.set(String(item.id), item));
            const formatTime = value => value ? new Date(Number(value)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
            el('integration-queue-list').innerHTML = visible.length ? visible.map(item => {
                const song = item.songInfo || {};
                const retry = item.status === 'error' ? `<button type="button" class="btn-secondary btn-xs queue-retry-btn" onclick="LibraryIntegration.retryQueueItem('${escapeHtml(item.id)}')">重试</button>` : '';
                const changeSource = item.status === 'error' ? `<button type="button" class="btn-secondary btn-xs queue-source-btn" onclick="LibraryIntegration.openQueueSourcePicker('${escapeHtml(item.id)}')">换源</button>` : '';
                const remove = item.status === 'error' ? `<button type="button" class="btn-secondary btn-xs queue-remove-btn" onclick="LibraryIntegration.removeQueueItem('${escapeHtml(item.id)}')">移除</button>` : '';
                const preview = song.name || song.title ? `<button type="button" class="btn-secondary btn-xs" onclick="LibraryIntegration.previewQueueItem('${escapeHtml(item.id)}')" title="试听此任务"><i class="fas fa-headphones"></i> 试听</button>` : '';
                const playlist = item.playlistName || '未关联歌单';
                const completion = item.completedAt ? `完成 ${formatTime(item.completedAt)}` : item.failedAt ? `失败 ${formatTime(item.failedAt)}` : `状态更新 ${formatTime(item.updatedAt)}`;
                const timeline = `歌单：${playlist} · 加入 ${formatTime(item.queuedAt || item.createdAt)} · ${completion}`;
                return `<div class="queue-row"><div><strong>${escapeHtml(song.name || song.title || '未知歌曲')}</strong><span>${escapeHtml(song.singer || song.artist || '')}</span><small class="queue-task-meta">${escapeHtml(timeline)}</small>${item.status === 'error' && item.errorMsg ? `<small class="queue-error-message">${escapeHtml(item.errorMsg)}</small>` : ''}</div><div class="queue-progress"><span style="width:${Math.max(0, Math.min(100, Number(item.progress || 0)))}%"></span></div><em class="status-${escapeHtml(item.status)}">${escapeHtml(queueLabel(item.status))}</em><div class="queue-actions">${preview}${changeSource}${retry}${remove}</div></div>`;
            }).join('') : '<div class="integration-empty">暂无下载任务</div>';
        } finally {
            state.queueLoading = false;
        }
    }

    function updatePlaylistDeleteButtons() {
        const yinyunId = el('integration-yinyun-playlist')?.value || ''
        const songloftId = el('integration-songloft-playlist')?.value || ''
        const yinyunButton = el('integration-delete-yinyun-btn')
        const songloftButton = el('integration-delete-songloft-btn')
        if (yinyunButton) yinyunButton.disabled = !yinyunId || ['default', 'love'].includes(yinyunId)
        const remote = state.remotePlaylists.find(item => String(item.id) === String(songloftId))
        const readonly = remote?.type === 'radio' || Number(songloftId) <= 2 || (Array.isArray(remote?.labels) && remote.labels.includes('built_in'))
        if (songloftButton) songloftButton.disabled = !songloftId || readonly
    }

    async function deleteYinyunPlaylist() {
        const playlistId = el('integration-yinyun-playlist')?.value || ''
        if (!playlistId || ['default', 'love'].includes(playlistId)) return notifyError(new Error('系统歌单不能删除'))
        const playlist = state.localPlaylists.find(item => String(item.id) === String(playlistId))
        const confirmed = typeof showSelect === 'function'
            ? await showSelect('确认删除音云歌单', `将删除“${playlist?.name || playlistId}”，只删除歌单，不删除音乐文件。继续吗？`)
            : window.confirm(`确认删除音云歌单“${playlist?.name || playlistId}”？只删除歌单，不删除音乐文件。`)
        if (!confirmed) return
        try {
            await api(`/api/v1/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE' })
            if (String(state.importData?.yinyunPlaylistId || '') === String(playlistId)) {
                state.importId = ''
                state.importData = null
                state.selected.clear()
                state.downloadSelections.clear()
                el('integration-result-panel')?.classList.add('hidden')
            }
            await refreshAll()
            if (typeof showSuccess === 'function') showSuccess(`已删除音云歌单“${playlist?.name || playlistId}”；音乐文件未删除`)
        } catch (error) { notifyError(error) }
    }

    async function deleteSongloftPlaylist() {
        const playlistId = el('integration-songloft-playlist')?.value || ''
        if (!playlistId) return notifyError(new Error('请选择要删除的 Songloft 歌单'))
        const selected = [...el('integration-songloft-playlist').selectedOptions][0]
        const confirmed = typeof showSelect === 'function'
            ? await showSelect('确认删除 Songloft 歌单', `将删除“${selected?.textContent || playlistId}”，只删除 Songloft 歌单，不删除音乐文件。继续吗？`)
            : window.confirm(`确认删除 Songloft 歌单“${selected?.textContent || playlistId}”？`)
        if (!confirmed) return
        try {
            await api(`/api/v1/integration/songloft/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE' })
            await loadPlaylists()
            if (typeof showSuccess === 'function') showSuccess('已删除 Songloft 歌单；音乐文件未删除')
        } catch (error) { notifyError(error) }
    }

    async function retryQueueItem(id) {
        if (!id) return
        try { await api('/api/v1/downloads/resume', { method: 'POST', body: JSON.stringify({ id }) }); await loadQueue(); if (typeof showSuccess === 'function') showSuccess('已重新加入下载队列'); }
        catch (error) { notifyError(error) }
    }

    async function removeQueueItem(id) {
        if (!id) return
        try { await api('/api/v1/downloads', { method: 'DELETE', body: JSON.stringify({ id }) }); await loadQueue(); }
        catch (error) { notifyError(error) }
    }

    async function clearQueueHistory() {
        const confirmed = typeof showSelect === 'function'
            ? await showSelect('清除补齐队列历史', '只清除已完成、已存在、失败和暂停的历史任务；下载中和等待中的任务会保留。继续吗？', { danger: true, confirmText: '清除历史' })
            : window.confirm('清除已完成、已存在、失败和暂停的补齐队列历史？')
        if (!confirmed) return
        try {
            await api('/api/v1/downloads', { method: 'DELETE', body: JSON.stringify({ history: true }) })
            await loadQueue()
            if (typeof showSuccess === 'function') showSuccess('补齐队列历史已清除，活动任务已保留')
        } catch (error) { notifyError(error) }
    }

    function previewQueueItem(id) {
        const task = state.queueSongs.get(String(id));
        if (!task) return notifyError(new Error('队列歌曲已刷新，请重新点击试听'));
        return previewCandidate(task.songInfo || task);
    }

    async function importPlaylist() {
        const url = el('integration-playlist-url').value.trim();
        if (!url) return notifyError(new Error('请粘贴网络歌单地址'));
        setBusy('integration-import-btn', true, '处理中…');
        try {
            const data = await api('/api/v1/integration/playlist/import', {
                method: 'POST', body: JSON.stringify({ url, autoDownload: false, reuseExisting: true }),
            });
            state.importId = String(data.importId || '');
            renderImport(data);
            await loadImportRecords();
            await loadPlaylists();
            if (typeof showSuccess === 'function') showSuccess(data.reused ? `已打开已有歌单“${data.name || '未命名'}”，没有创建重复副本` : `已导入 ${data.counts?.total || 0} 首，缺失 ${data.counts?.missing || 0} 首；已保存到导入歌单列表`);
        } catch (error) { notifyError(error); }
        finally { setBusy('integration-import-btn', false); }
    }

    async function openImportById(importId, showMessage = true) {
        importId = String(importId || '').trim();
        if (!importId) return notifyError(new Error('请先从歌单列表选择要打开的歌单'));
        try {
            const data = await api(`/api/v1/integration/playlist/import/${encodeURIComponent(importId)}`);
            state.importId = importId;
            renderImport(data);
            await loadImportRecords();
            await loadPlaylists();
            if (showMessage && typeof showSuccess === 'function') showSuccess(`已打开“${data.name || '导入歌单'}”，重新匹配 ${data.counts?.total || 0} 首歌曲`);
        } catch (error) { notifyError(error); }
    }

    async function openImport() {
        return openImportById(state.importId, false);
    }

    async function openSelectedImport() {
        const playlistId = el('integration-import-history')?.value || ''
        const record = recordForPlaylistId(playlistId)
        if (!record) return notifyError(new Error('请先从下拉列表选择当前音云导入歌单'))
        return openImportById(record.importId)
    }

    function renderImport(data) {
        state.importData = data;
        state.selected.clear();
        state.downloadSelections.clear();
        state.importId = String(data.importId || state.importId || '');
        el('integration-result-panel').classList.remove('hidden');
        el('integration-result-title').textContent = data.name || '匹配结果';
        el('integration-import-meta').textContent = data.source ? `${data.source.toUpperCase()} · ${data.items?.length || 0} 首` : '';
        const counts = data.counts || {};
        el('integration-count-total').textContent = counts.total || 0;
        el('integration-count-missing').textContent = counts.missing || 0;
        el('integration-count-ambiguous').textContent = counts.ambiguous || 0;
        el('integration-count-yinyun').textContent = counts.yinyunMatched ?? counts.localMatched ?? 0;
        el('integration-count-songloft').textContent = counts.songloftMatched ?? 0;
        renderRows();
        el('integration-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function compactCandidate(value, fallbackSource = '') {
        const raw = value || {};
        return {
            id: raw.id ?? raw.songmid ?? raw.songId ?? raw.hash,
            sourceId: raw.sourceId ?? raw.songmid ?? raw.songId ?? raw.hash ?? raw.id,
            source: raw.source || fallbackSource,
            title: raw.title || raw.name || '',
            artist: raw.artist || raw.singer || '',
            album: raw.album || raw.albumName || '',
            duration: raw.duration || raw.interval || 0,
            artworkUrl: raw.artworkUrl || raw.img || raw.picUrl || raw.pic || '',
            relativePath: raw.relativePath || raw.path || raw.filePath || '',
            filename: raw.filename || '',
            streamPath: raw.streamPath || raw.streamUrl || '',
            localTrackId: raw.localTrackId || '',
            isLocal: Boolean(raw.isLocal || raw.folder || raw.storageLocation || raw.localTrackId),
            folder: raw.folder || '',
            storageLocation: raw.storageLocation || '',
            isrc: raw.isrc || '',
            fingerprint: raw.fingerprint || '',
            raw: raw.raw || raw,
        };
    }

    function formatPreviewTime(value) {
        const seconds = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.floor(seconds % 60);
        return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    }

    function updatePreviewProgress() {
        const audio = el('integration-preview-audio');
        const seek = el('integration-preview-seek');
        const bar = el('integration-preview-progress-bar');
        const time = el('integration-preview-time');
        if (!audio) return;
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const percent = duration ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
        if (seek) seek.value = String(percent);
        if (bar) bar.style.width = `${percent}%`;
        if (time) time.textContent = `${formatPreviewTime(current)} / ${formatPreviewTime(duration)}`;
    }

    function setPreviewState(label, className = '') {
        const stateEl = el('integration-preview-state');
        if (!stateEl) return;
        stateEl.textContent = label;
        stateEl.className = `integration-preview-state${className ? ` ${className}` : ''}`;
    }

    function bindPreviewPlayer() {
        if (state.previewBound) return;
        const audio = el('integration-preview-audio');
        const toggle = el('integration-preview-toggle');
        const seek = el('integration-preview-seek');
        if (!audio || !toggle || !seek) return;
        const setToggle = playing => {
            toggle.innerHTML = playing ? '<i class="fas fa-pause"></i><span>暂停</span>' : '<i class="fas fa-play"></i><span>播放</span>';
            toggle.setAttribute('aria-label', playing ? '暂停试听' : '播放试听');
        };
        toggle.addEventListener('click', async () => {
            if (!audio.src) return;
            try {
                if (audio.paused) await audio.play();
                else audio.pause();
            } catch (error) {
                setPreviewState('点击播放', 'is-ready');
                if (typeof showError === 'function') showError('浏览器阻止了自动播放，请再次点击播放');
            }
        });
        seek.addEventListener('input', () => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * Number(seek.value) / 100;
            updatePreviewProgress();
        });
        audio.addEventListener('loadstart', () => setPreviewState('加载中', 'is-loading'));
        audio.addEventListener('progress', () => setPreviewState('缓冲中', 'is-loading'));
        audio.addEventListener('waiting', () => setPreviewState('缓冲中', 'is-loading'));
        audio.addEventListener('loadedmetadata', updatePreviewProgress);
        audio.addEventListener('durationchange', updatePreviewProgress);
        audio.addEventListener('timeupdate', updatePreviewProgress);
        audio.addEventListener('canplay', () => setPreviewState('可播放', 'is-ready'));
        audio.addEventListener('playing', () => { setPreviewState('播放中', 'is-playing'); setToggle(true); });
        audio.addEventListener('pause', () => { if (!audio.ended) setPreviewState('已暂停', 'is-ready'); setToggle(false); });
        audio.addEventListener('ended', () => { setPreviewState('播放结束', ''); setToggle(false); updatePreviewProgress(); });
        audio.addEventListener('error', () => setPreviewState('加载失败', 'is-error'));

        const close = el('integration-preview-close');
        close?.addEventListener('click', () => closePreviewPlayer());

        // The preview player is intentionally independent from the main web
        // player.  Dragging its small handle changes only this floating panel;
        // it never changes the global playlist or advances to another song.
        const panel = el('integration-preview-player');
        const handle = panel?.querySelector('.integration-preview-drag-handle');
        if (panel && handle && !state.previewDragBound) {
            const clampToViewport = () => {
                if (panel.classList.contains('hidden')) return;
                const rect = panel.getBoundingClientRect();
                const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
                const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
                const left = Math.min(maxLeft, Math.max(8, rect.left));
                const top = Math.min(maxTop, Math.max(8, rect.top));
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            };
            let dragging = false;
            let offsetX = 0;
            let offsetY = 0;
            handle.addEventListener('pointerdown', event => {
                dragging = true;
                const rect = panel.getBoundingClientRect();
                offsetX = event.clientX - rect.left;
                offsetY = event.clientY - rect.top;
                panel.style.left = `${rect.left}px`;
                panel.style.top = `${rect.top}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                handle.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            });
            handle.addEventListener('pointermove', event => {
                if (!dragging) return;
                const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
                const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
                panel.style.left = `${Math.min(maxLeft, Math.max(8, event.clientX - offsetX))}px`;
                panel.style.top = `${Math.min(maxTop, Math.max(8, event.clientY - offsetY))}px`;
            });
            const stopDragging = () => { dragging = false; };
            handle.addEventListener('pointerup', stopDragging);
            handle.addEventListener('pointercancel', stopDragging);
            window.addEventListener('resize', clampToViewport, { passive: true });
            state.previewDragBound = true;
        }
        state.previewBound = true;
    }

    function showPreviewPlayer(candidate) {
        bindPreviewPlayer();
        const player = el('integration-preview-player');
        if (player) player.classList.remove('hidden');
        const title = el('integration-preview-title');
        const meta = el('integration-preview-meta');
        if (title) title.textContent = candidate?.title || candidate?.name || '试听歌曲';
        if (meta) meta.textContent = [candidate?.artist || candidate?.singer, candidate?.album || candidate?.albumName, sourceLabel(candidate?.source)].filter(Boolean).join(' · ');
        updatePreviewProgress();
        setPreviewState('准备中', 'is-loading');
    }

    function isLikelyLocalCandidate(candidate) {
        const source = String(candidate?.source || '').toLowerCase();
        return Boolean(candidate?.isLocal || candidate?.folder || candidate?.storageLocation || candidate?.localTrackId)
            || ['local', 'songloft', 'subsonic', 'navidrome', 'musichub'].includes(source);
    }

    function findLocalCandidate(item, preferredProvider = '') {
        const matches = [
            preferredProvider ? item?.[preferredProvider] : null,
            item?.yinyun,
            item?.songloft,
        ].filter(Boolean);
        for (const match of matches) {
            const candidates = [
                ...(Array.isArray(match.candidates) ? match.candidates.map(entry => entry?.track || entry) : []),
                match.candidate,
            ].filter(Boolean);
            const local = candidates.find(isLikelyLocalCandidate);
            if (local) return compactCandidate({ ...local, isLocal: true }, local.source || 'local');
        }
        return null;
    }

    function renderLocalCandidate() {
        const section = el('integration-local-candidate');
        const divider = el('integration-online-candidate-divider');
        const candidate = state.localCandidate;
        if (!section) return;
        if (!candidate) {
            section.classList.add('hidden');
            if (divider) {
                const note = divider.querySelector('small');
                if (note) note.textContent = '本地未找到；采用后下载并加入歌单';
            }
            return;
        }
        section.classList.remove('hidden');
        const cover = el('integration-local-candidate-cover');
        if (cover) cover.src = candidate.artworkUrl || '/_player/assets/logo.svg';
        const title = el('integration-local-candidate-title');
        if (title) title.textContent = candidate.title || '本地歌曲';
        const meta = el('integration-local-candidate-meta');
        if (meta) {
            const path = candidate.relativePath || candidate.filename || '';
            meta.textContent = [candidate.artist, candidate.album, path ? `文件：${path}` : '本地曲库'].filter(Boolean).join(' · ');
        }
        const button = el('integration-local-preview-btn');
        if (button) {
            button.onclick = () => previewCandidate(candidate);
            button.disabled = false;
        }
        if (divider) {
            const note = divider.querySelector('small');
            if (note) note.textContent = '采用在线版本后会下载新文件，完成后删除当前本地文件并同步两端歌单';
        }
    }

    function closePreviewPlayer() {
        const audio = el('integration-preview-audio');
        if (audio) {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        }
        el('integration-preview-player')?.classList.add('hidden');
        el('integration-preview-title') && (el('integration-preview-title').textContent = '未选择试听');
        el('integration-preview-meta') && (el('integration-preview-meta').textContent = '点击候选版本或本地歌曲试听');
        el('integration-preview-seek') && (el('integration-preview-seek').value = '0');
        el('integration-preview-progress-bar') && (el('integration-preview-progress-bar').style.width = '0%');
        el('integration-preview-time') && (el('integration-preview-time').textContent = '00:00 / 00:00');
        setPreviewState('未加载');
    }

    async function previewCandidate(track) {
        const candidate = compactCandidate(track, state.importData?.source || '');
        if (!candidate.source && !candidate.isLocal) return notifyError(new Error('候选歌曲缺少音源'));
        const audio = el('integration-preview-audio');
        if (!audio) return;
        showPreviewPlayer(candidate);
        audio.removeAttribute('src');
        audio.loop = false;
        audio.load();
        try {
            if (isLikelyLocalCandidate(candidate)) {
                // 本地候选优先使用索引返回的真实 track id/path；老记录没有这些字段时，
                // 再用标题、艺术家和专辑逐级查找，绝不把搜索结果第一首当作试听文件。
                let rows = [];
                const localTrackId = candidate.localTrackId || candidate.id;
                if (localTrackId) {
                    const direct = await api(`/api/v1/library/tracks/${encodeURIComponent(localTrackId)}/stream-token`, { method: 'POST' }).catch(() => null);
                    if (direct?.path) {
                        audio.src = direct.path;
                        audio.load();
                        setPreviewState('点击播放', 'is-ready');
                        await audio.play().catch(() => {});
                        return;
                    }
                }
                const queries = [...new Set([`${candidate.title} ${candidate.artist}`, candidate.title].filter(Boolean))];
                for (const query of queries) {
                    const local = await api(`/api/v1/library/tracks?query=${encodeURIComponent(query)}&limit=100`).catch(() => null);
                    rows.push(...(Array.isArray(local?.items) ? local.items : []));
                }
                const relativePath = String(candidate.relativePath || '').replace(/\\/g, '/').replace(/^.*\/music\//i, '').replace(/^\/+/, '').toLowerCase();
                const title = String(candidate.title || '').trim().toLowerCase();
                const artist = String(candidate.artist || '').trim().toLowerCase();
                const album = String(candidate.album || '').trim().toLowerCase();
                const hit = rows.find(row => candidate.localTrackId && String(row.id) === String(candidate.localTrackId))
                    || rows.find(row => relativePath && String(row.filename || row.relativePath || row.path || '').replace(/\\/g, '/').replace(/^.*\/music\//i, '').replace(/^\/+/, '').toLowerCase() === relativePath)
                    || rows.find(row => String(row.title || row.name || '').trim().toLowerCase() === title && String(row.artist || row.singer || '').trim().toLowerCase() === artist && (!album || String(row.album || row.albumName || '').trim().toLowerCase() === album))
                    || rows.find(row => String(row.title || row.name || '').trim().toLowerCase() === title && String(row.artist || row.singer || '').trim().toLowerCase() === artist)
                    || rows.find(row => String(row.title || row.name || '').trim().toLowerCase() === title);
                if (!hit?.id) throw new Error('未找到对应的本地音频文件');
                const stream = await api(`/api/v1/library/tracks/${encodeURIComponent(hit.id)}/stream-token`, { method: 'POST' });
                if (!stream?.path) throw new Error('本地试听地址生成失败');
                audio.src = stream.path;
                audio.load();
                setPreviewState('点击播放', 'is-ready');
                await audio.play().catch(() => {});
                return;
            }
            if (!candidate.sourceId) return notifyError(new Error('候选歌曲缺少歌曲编号'));
            const data = await api('/api/v1/tracks/resolve', {
                method: 'POST',
                body: JSON.stringify({ track: {
                    id: candidate.id,
                    songmid: candidate.sourceId,
                    source: candidate.source,
                    name: candidate.title,
                    singer: candidate.artist,
                    albumName: candidate.album,
                    interval: candidate.duration,
                }, quality: el('integration-quality')?.value || '128k' }),
            });
            if (!data?.url) throw new Error('服务器没有返回试听地址');
            audio.src = data.url;
            audio.load();
            setPreviewState('点击播放', 'is-ready');
            await audio.play().catch(() => {});
        } catch (error) {
            setPreviewState('加载失败', 'is-error');
            notifyError(error);
        }
    }

    function closeCandidatePicker() {
        // The preview player floats above both the admin shell and the player
        // page.  Closing the version dialog must also stop that audio; leaving
        // it alive made the dialog appear closed while the song continued in
        // the background.
        closePreviewPlayer();
        const modal = el('integration-candidate-modal');
        if (modal) modal.classList.add('hidden');
        state.candidateIndex = -1;
        state.candidateQueueId = '';
        state.candidateContext = 'import';
        state.candidateResults = [];
        state.localCandidate = null;
    }

    function selectDownloadCandidate(index, track) {
        const candidate = compactCandidate(track);
        if (state.candidateContext === 'queue' && state.candidateQueueId) {
            return api('/api/v1/downloads/resume', {
                method: 'POST',
                body: JSON.stringify({ id: state.candidateQueueId, songInfo: {
                    id: candidate.id,
                    songmid: candidate.sourceId,
                    source: candidate.source,
                    name: candidate.title,
                    singer: candidate.artist,
                    albumName: candidate.album,
                    interval: candidate.duration,
                } }),
            }).then(async data => {
                closeCandidatePicker();
                await loadQueue();
                if (typeof showSuccess === 'function') showSuccess(data?.sourceChanged ? '已换源并重新加入下载队列' : '已重新加入下载队列');
            }).catch(notifyError);
        }
        const replacingLocal = Boolean(state.localCandidate && isLikelyLocalCandidate(state.localCandidate));
        const selection = { ...candidate, replaceLocal: replacingLocal };
        state.downloadSelections.set(Number(index), selection);
        state.selected.add(Number(index));
        closeCandidatePicker();
        renderRows();
        if (typeof showSuccess === 'function') showSuccess(replacingLocal
            ? `第 ${Number(index) + 1} 首已选择替换版本；下载完成后将删除原文件并同步歌单`
            : `第 ${Number(index) + 1} 首已选择下载版本，可点击手工补齐加入队列`);
    }

    function sourceLabel(source) {
        return ({ aggregate: '聚合', local: '本地曲库', wy: '网易云', tx: 'QQ音乐', kw: '酷我', kg: '酷狗', mg: '咪咕', bd: '百度' })[source] || String(source || '').toUpperCase();
    }

    async function loadCandidateSources() {
        const standard = ['aggregate', 'wy', 'tx', 'kw', 'kg', 'mg', 'bd'];
        try {
            const sources = await api('/api/v1/sources');
            const enabled = new Set(['aggregate']);
            (Array.isArray(sources) ? sources : []).forEach(source => (source.enabledPlatforms || source.supportedPlatforms || []).forEach(platform => enabled.add(String(platform))));
            return standard.filter(source => enabled.has(source));
        } catch { return standard; }
    }

    async function searchCandidates() {
        const list = el('integration-candidate-list');
        const source = state.candidateSource || 'aggregate';
        const queryInput = el('integration-candidate-query-input');
        const query = String(queryInput?.value ?? state.candidateQuery ?? '').trim();
        if (queryInput) queryInput.value = query;
        if (query) state.candidateQuery = query;
        if (!list || !query) {
            if (list) list.innerHTML = '<div class="integration-empty">请输入搜索关键字。</div>';
            return;
        }
        const serial = ++state.candidateSearchSerial;
        const searchButton = el('integration-candidate-search-btn');
        if (searchButton) searchButton.disabled = true;
        el('integration-candidate-query') && (el('integration-candidate-query').textContent = `搜索：${query}`);
        list.innerHTML = '<div class="integration-empty"><i class="fas fa-circle-notch fa-spin"></i> 正在搜索候选版本…</div>';
        const status = el('integration-candidate-source-status');
        if (status) status.textContent = `音源：${sourceLabel(source)}`;
        try {
            const payload = await api(`/api/v1/search?query=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}&type=song&limit=20&page=1`);
            if (serial !== state.candidateSearchSerial) return;
            const results = Array.isArray(payload) ? payload : (payload?.items || payload?.list || []);
            state.candidateResults = results.map(raw => compactCandidate(raw, source));
            if (!state.candidateResults.length) {
                list.innerHTML = '<div class="integration-empty">没有搜索到可用版本，请换一个音源或稍后重试。</div>';
                return;
            }
            list.innerHTML = state.candidateResults.map((candidate, candidateIndex) => {
                const safe = escapeHtml;
                return `<div class="integration-candidate-item"><div><strong>${safe(candidate.title || '未知歌曲')}</strong><small>${safe(sourceLabel(candidate.source))} · ${safe(candidate.artist)} · ${safe(candidate.album || '未知专辑')} · ${safe(String(candidate.duration || ''))}</small></div><div class="integration-candidate-actions"><button type="button" class="btn-secondary btn-xs" data-candidate-index="${candidateIndex}">试听</button><button type="button" class="btn-primary btn-xs" data-select-index="${candidateIndex}">采用</button></div></div>`;
            }).join('');
            [...list.querySelectorAll('[data-candidate-index]')].forEach(button => button.addEventListener('click', () => previewCandidate(state.candidateResults[Number(button.dataset.candidateIndex)])));
            [...list.querySelectorAll('[data-select-index]')].forEach(button => button.addEventListener('click', () => selectDownloadCandidate(state.candidateIndex, state.candidateResults[Number(button.dataset.selectIndex)])));
        } catch (error) {
            if (serial !== state.candidateSearchSerial) return;
            state.candidateResults = [];
            list.innerHTML = `<div class="integration-empty">${escapeHtml(error.message || String(error))}</div>`;
        } finally {
            if (serial === state.candidateSearchSerial && searchButton) searchButton.disabled = false;
        }
    }

    async function openCandidatePicker(index, options = {}) {
        const item = (state.importData?.items || []).find(row => Number(row.index) === Number(index));
        if (!item) return;
        const modal = el('integration-candidate-modal');
        const list = el('integration-candidate-list');
        const localCandidate = options.localCandidate ? compactCandidate({ ...options.localCandidate, isLocal: true }, options.localCandidate.source || 'local') : findLocalCandidate(item, options.provider);
        const query = `${item.source?.title || localCandidate?.title || ''} ${item.source?.artist || localCandidate?.artist || ''}`.trim();
        if (!modal || !list) return;
        state.candidateContext = 'import';
        state.candidateQueueId = '';
        state.candidateIndex = Number(index);
        state.candidateQuery = query;
        state.candidateSource = 'aggregate';
        state.localCandidate = localCandidate;
        modal.classList.remove('hidden');
        el('integration-candidate-title').textContent = item.replaceable || localCandidate ? `试听/替换第 ${Number(index) + 1} 首` : `选择第 ${Number(index) + 1} 首下载版本`;
        el('integration-candidate-query').textContent = `搜索：${query}`;
        const queryInput = el('integration-candidate-query-input');
        if (queryInput) {
            queryInput.value = query;
            queryInput.onkeydown = event => {
                if (event.key === 'Enter') { event.preventDefault(); searchCandidates(); }
            };
        }
        renderLocalCandidate();
        const sourceSelect = el('integration-candidate-source');
        if (sourceSelect) {
            sourceSelect.innerHTML = (await loadCandidateSources()).map(source => `<option value="${escapeHtml(source)}">${escapeHtml(sourceLabel(source))}</option>`).join('');
            sourceSelect.value = 'aggregate';
            sourceSelect.onchange = () => { state.candidateSource = sourceSelect.value; searchCandidates(); };
        }
        // A local file is useful for immediate auditioning, but opening the
        // picker must not unexpectedly fan out to every online provider.  The
        // user can edit the query and press 搜索 when an online replacement is
        // actually needed.  Queue tasks have no local candidate and retain
        // the original convenience of an initial search.
        if (options.previewLocal && localCandidate) await previewCandidate(localCandidate);
        if (!localCandidate) {
            await searchCandidates();
        } else {
            list.innerHTML = '<div class="integration-empty">本地文件已显示。请修改关键字或点击“搜索”加载在线候选版本。</div>';
        }
    }

    async function openQueueSourcePicker(id) {
        const task = state.queueSongs.get(String(id));
        if (!task) return notifyError(new Error('队列任务已刷新，请重新点击换源'));
        const song = task.songInfo || {};
        const query = `${song.name || song.title || ''} ${song.singer || song.artist || ''}`.trim();
        const modal = el('integration-candidate-modal');
        if (!modal || !query) return notifyError(new Error('队列任务缺少可搜索的歌曲信息'));
        state.candidateContext = 'queue';
        state.candidateQueueId = String(id);
        state.candidateIndex = -1;
        state.candidateQuery = query;
        state.candidateSource = 'aggregate';
        state.localCandidate = null;
        modal.classList.remove('hidden');
        el('integration-candidate-title').textContent = '为失败任务选择下载版本';
        el('integration-candidate-query').textContent = `搜索：${query}`;
        const queryInput = el('integration-candidate-query-input');
        if (queryInput) {
            queryInput.value = query;
            queryInput.onkeydown = event => {
                if (event.key === 'Enter') { event.preventDefault(); searchCandidates(); }
            };
        }
        renderLocalCandidate();
        const sourceSelect = el('integration-candidate-source');
        if (sourceSelect) {
            sourceSelect.innerHTML = (await loadCandidateSources()).map(source => `<option value="${escapeHtml(source)}">${escapeHtml(sourceLabel(source))}</option>`).join('');
            sourceSelect.value = 'aggregate';
            sourceSelect.onchange = () => { state.candidateSource = sourceSelect.value; searchCandidates(); };
        }
        await searchCandidates();
    }

    function renderRows() {
        const items = state.importData?.items || [];
        const visible = state.filter === 'all' ? items : items.filter(item => item.status === state.filter);
        const body = el('integration-result-body');
        const statusLabel = status => status === 'matched' ? '已找到' : status === 'missing' ? '未找到' : '需确认';
        const statusCell = (match, label, index, provider, localFallback) => {
            const fallback = !match?.candidate && localFallback ? localFallback : null;
            const effectiveStatus = match?.status || (fallback ? 'matched' : 'missing');
            const title = match?.candidate || fallback;
            return `<div class="integration-source-cell"><span class="match-pill status-${escapeHtml(effectiveStatus)}">${label}: ${statusLabel(effectiveStatus)}${fallback ? '（共享本地文件）' : ''}</span>${title ? `<small>${escapeHtml(title.title || '')} · ${escapeHtml(title.artist || '')}</small><button type="button" class="btn-secondary btn-xs" onclick="LibraryIntegration.previewLocalCandidate(${Number(index)}, '${provider}', 0)">试听</button>` : ''}</div>`;
        };
        body.innerHTML = visible.length ? visible.map(item => {
            const source = item.source || {};
            const checked = state.selected.has(Number(item.index));
            const selected = state.downloadSelections.get(Number(item.index));
            const canSelect = item.downloadable !== false && (item.status === 'missing' || (item.status === 'ambiguous' && Boolean(selected)));
            const decision = item.status === 'matched' ? (item.matchedBy === 'songloft' ? '共享文件已存在，等待音云索引' : '音云已收录') : item.status === 'ambiguous' ? '需要人工确认' : '可加入音云下载';
            const confirmButtons = item.status === 'ambiguous' ? `<div class="integration-confirm-actions">${item.yinyun?.candidate ? `<button type="button" class="btn-secondary btn-xs" onclick="LibraryIntegration.resolveItem(${Number(item.index)}, 'yinyun')" title="使用音云候选">采用音云</button>` : ''}${item.songloft?.candidate ? `<button type="button" class="btn-secondary btn-xs" onclick="LibraryIntegration.resolveItem(${Number(item.index)}, 'songloft')" title="使用 Songloft 候选">采用 Songloft</button>` : ''}</div>` : '';
            const manualButton = item.status !== 'matched' || item.replaceable ? `<button type="button" class="btn-secondary btn-xs" onclick="LibraryIntegration.openCandidatePicker(${Number(item.index)})"><i class="fas fa-headphones"></i> ${selected ? '更换版本' : item.replaceable ? '替换版本' : '选择版本'}</button>` : '';
            const selectionText = selected ? `<small class="integration-match-source">${selected.replaceLocal ? '已选替换：' : '已选：'}${escapeHtml(selected.title)} · ${escapeHtml(selected.artist)}</small>` : '';
            return `<tr><td><input type="checkbox" ${checked ? 'checked' : ''} ${canSelect ? '' : 'disabled'} onchange="LibraryIntegration.toggleItem(${Number(item.index)}, this.checked)"></td><td><strong>${escapeHtml(source.title || '未知歌曲')}</strong><small>${escapeHtml(source.artist || '')}</small></td><td>${escapeHtml(source.album || '—')}</td><td>${statusCell(item.yinyun, '音云', item.index, 'yinyun', item.localCandidate)}</td><td>${statusCell(item.songloft, 'Songloft', item.index, 'songloft', item.localCandidate)}</td><td><span class="match-pill status-${escapeHtml(item.status)}">${escapeHtml(decision)}</span>${item.localCandidate && item.status !== 'matched' ? '<small class="integration-match-source">共享曲库已有本地文件，可试听；索引状态可能正在刷新</small>' : ''}${selectionText}${manualButton}${confirmButtons}</td></tr>`;
        }).join('') : '<tr><td colspan="6" class="integration-empty">当前筛选没有歌曲</td></tr>';
        document.querySelectorAll('[data-integration-filter]').forEach(button => button.classList.toggle('active', button.dataset.integrationFilter === state.filter));
        el('integration-selected-count').textContent = `已选 ${state.selected.size} 首`;
        const selectable = visible.filter(item => item.status === 'missing' && item.downloadable !== false);
        el('integration-select-visible').checked = selectable.length > 0 && selectable.every(item => state.selected.has(Number(item.index)));
    }

    function setFilter(filter) { state.filter = filter; renderRows(); }
    function toggleItem(index, checked) { checked ? state.selected.add(index) : state.selected.delete(index); renderRows(); }
    function toggleVisible(checked) {
        const items = state.importData?.items || [];
        const visible = state.filter === 'all' ? items : items.filter(item => item.status === state.filter);
        visible.filter(item => item.status === 'missing' && item.downloadable !== false).forEach(item => checked ? state.selected.add(Number(item.index)) : state.selected.delete(Number(item.index)));
        renderRows();
    }

    async function complete(mode, indexes = []) {
        if (!state.importId) return notifyError(new Error('请先导入或打开歌单记录'));
        const missing = (state.importData?.items || []).filter(item => item.status === 'missing' && item.downloadable !== false).length;
        const amount = mode === 'all' ? missing : indexes.length;
        if (!amount) return notifyError(new Error(mode === 'all' ? '没有需要补齐的歌曲' : '请先选择缺失歌曲'));
        const confirmed = typeof showSelect !== 'function' || await showSelect('确认加入下载队列', `将 ${amount} 首歌曲按 ${el('integration-quality').value} 音质加入音云下载队列。继续吗？`);
        if (!confirmed) return;
        const buttonId = mode === 'all' ? 'integration-complete-all' : 'integration-complete-selected';
        setBusy(buttonId, true, '提交中');
        try {
            const data = await api('/api/v1/integration/playlist/complete', {
                method: 'POST',
                body: JSON.stringify({ importId: state.importId, mode, indexes, quality: el('integration-quality').value, selections: Object.fromEntries(state.downloadSelections) }),
            });
            const queued = data.download?.queued?.length || 0;
            const skipped = data.download?.skipped?.length || 0;
            if (typeof showSuccess === 'function') showSuccess(`已加入 ${queued} 个任务${skipped ? `，跳过 ${skipped} 首` : ''}`);
            await loadQueue();
            await openImport();
            setActive(state.panelActive);
        } catch (error) { notifyError(error); }
        finally { setBusy(buttonId, false); }
    }

    function completeSelected() { return complete('selected', [...state.selected].sort((a, b) => a - b)); }
    function completeAll() { return complete('all'); }

    async function resolveItem(index, provider) {
        if (!state.importId) return notifyError(new Error('请先导入或打开歌单记录'));
        const label = provider === 'songloft' ? 'Songloft' : '音云';
        try {
            const data = await api('/api/v1/integration/playlist/resolve-item', {
                method: 'POST',
                body: JSON.stringify({ importId: state.importId, index, provider }),
            });
            state.importData = { ...state.importData, items: data.items, counts: data.counts };
            renderImport(state.importData);
            if (typeof showSuccess === 'function') showSuccess(`已确认第 ${Number(index) + 1} 首采用${label}候选；未触发下载`);
        } catch (error) { notifyError(error); }
    }

    function previewLocalCandidate(index, provider, candidateIndex = 0) {
        const item = (state.importData?.items || []).find(row => Number(row.index) === Number(index));
        const match = item?.[provider];
        const candidate = match?.candidates?.[Number(candidateIndex)]?.track || match?.candidate || item?.localCandidate;
        if (!candidate) return notifyError(new Error('当前来源没有可试听的候选'));
        return openCandidatePicker(index, { provider, localCandidate: candidate, previewLocal: true });
    }

    async function triggerScan() {
        try {
            await api('/api/v1/integration/songloft/scan', { method: 'POST', body: JSON.stringify({ reimport: false }) });
            if (typeof showSuccess === 'function') showSuccess('已触发 Songloft 曲库扫描');
            setTimeout(() => loadStatus().catch(console.error), 1000);
        } catch (error) { notifyError(error); }
    }

    async function refreshBothIndexes() {
        await Promise.all([refreshYinyunIndex(), refreshSongloftIndex()]);
    }

    async function refreshYinyunIndex() {
        setBusy('integration-refresh-yinyun-btn', true, '刷新中');
        try {
            const data = await api('/api/v1/integration/library/refresh/yinyun', {
                method: 'POST', body: JSON.stringify({ reimport: false }),
            });
            if (typeof showSuccess === 'function') showSuccess(`音云已索引 ${data.yinyun?.tracks || 0} 首；Songloft 未刷新`);
            await loadStatus();
        } catch (error) { notifyError(error); }
        finally { setBusy('integration-refresh-yinyun-btn', false); }
    }

    async function refreshSongloftIndex() {
        setBusy('integration-refresh-songloft-btn', true, '提交中');
        try {
            await api('/api/v1/integration/library/refresh/songloft', {
                method: 'POST', body: JSON.stringify({ reimport: false }),
            });
            if (typeof showSuccess === 'function') showSuccess('Songloft 曲库扫描已提交；完成后计数会更新');
            await loadStatus();
        } catch (error) { notifyError(error); }
        finally { setBusy('integration-refresh-songloft-btn', false); }
    }

    function updateSyncMode() {
        const direction = el('integration-sync-direction').value;
        const replace = [...el('integration-sync-mode').options].find(option => option.value === 'replace');
        replace.disabled = direction === 'pull';
        if (direction === 'pull' && el('integration-sync-mode').value === 'replace') el('integration-sync-mode').value = 'merge';
    }

    async function syncPlaylist() {
        const yinyunPlaylistId = el('integration-yinyun-playlist').value;
        if (!yinyunPlaylistId) return notifyError(new Error('请选择音云歌单'));
        const body = {
            yinyunPlaylistId,
            direction: el('integration-sync-direction').value,
            mode: el('integration-sync-mode').value,
        };
        const remoteId = el('integration-songloft-playlist').value;
        if (remoteId) body.songloftPlaylistId = Number(remoteId);
        const confirmed = typeof showSelect !== 'function' || await showSelect('确认同步歌单', `方向：${body.direction}\n模式：${body.mode}\n确认继续吗？`);
        if (!confirmed) return;
        setBusy('integration-sync-btn', true, '同步中');
        try {
            const data = await api('/api/v1/integration/playlists/sync', { method: 'POST', body: JSON.stringify(body) });
            const output = el('integration-sync-result');
            output.textContent = JSON.stringify({ playlistResolution: data.playlistResolution, counts: data.counts, push: data.push && { addedIds: data.push.addedIds, removedIds: data.push.removedIds, unmatched: data.push.unmatched?.length }, pull: data.pull && { added: data.pull.added, unmatched: data.pull.unmatched?.length }, conflicts: data.conflicts }, null, 2);
            output.classList.remove('hidden');
            const resolution = data.playlistResolution === 'existing_name' ? '已使用同名 Songloft 歌单' : data.playlistResolution === 'created' ? '已创建 Songloft 歌单' : '已使用指定 Songloft 歌单';
            if (typeof showSuccess === 'function') showSuccess(`歌单同步完成 · ${resolution}`);
            await loadPlaylists();
        } catch (error) { notifyError(error); }
        finally { setBusy('integration-sync-btn', false); }
    }

    async function refreshAll() {
        if (!state.token) return;
        await Promise.allSettled([loadStatus(), loadQueue(), loadPlaylists(), loadImportRecords()]);
        if (state.importId) await openImport().catch(console.error);
    }

    async function refreshStatus() {
        if (!state.token) return notifyError(new Error('请先连接音云用户'));
        setBusy('integration-refresh-status-btn', true, '刷新中');
        try {
            await refreshAll();
            if (typeof showSuccess === 'function') showSuccess('曲库状态、补齐队列和歌单已刷新');
        } catch (error) {
            notifyError(error);
        } finally {
            setBusy('integration-refresh-status-btn', false);
        }
    }

    function startPolling() {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        const panelVisible = state.panelActive || el('view-library-integration')?.classList.contains('active');
        if (!state.token || !panelVisible || document.visibilityState !== 'visible') return;
        state.panelActive = true;
        // 队列统计只在用户停留在曲库联动面板时刷新；4 秒一次足以反映下载状态，
        // 离开面板或切到后台立即停止，避免每个已登录浏览器持续轮询服务器。
        state.timer = setInterval(() => {
            if (state.token && state.panelActive && document.visibilityState === 'visible') loadQueue().catch(console.error);
        }, 4000);
    }

    function stopPolling() {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
    }

    function setActive(active) {
        state.panelActive = Boolean(active) || Boolean(el('view-library-integration')?.classList.contains('active'));
        if (!state.panelActive) {
            stopPolling();
            return;
        }
        if (state.token) startPolling();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.token && state.panelActive) {
            loadQueue().catch(notifyError);
            startPolling();
        } else if (document.visibilityState !== 'visible') stopPolling();
    });

    async function restoreSavedUserSession() {
        const savedUser = String(localStorage.getItem('lx_sync_user') || sessionStorage.getItem('yinyun.integration.username') || '').trim();
        const savedPass = localStorage.getItem('lx_sync_pass') || '';
        if (!savedUser || !savedPass) return false;
        try {
            const response = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: savedUser, password: savedPass }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) return false;
            const data = unwrap(payload);
            if (!data?.accessToken) return false;
            state.token = data.accessToken;
            state.username = savedUser;
            sessionStorage.setItem('yinyun.integration.username', savedUser);
            updateAuth(true);
            return true;
        } catch (error) {
            console.warn('[LibraryIntegration] 恢复保存的音云登录失败:', error);
            return false;
        }
    }

    async function activate() {
        const savedUser = sessionStorage.getItem('yinyun.integration.username');
        const legacyUser = localStorage.getItem('lx_sync_user') || savedUser || '';
        const legacyToken = localStorage.getItem('lx_user_token') || '';
        if (savedUser && el('integration-username')) el('integration-username').value = savedUser;
        if (!state.token && legacyToken) {
            state.token = 'legacy';
            state.username = legacyUser;
            updateAuth(true);
        }
        // The legacy token can be expired while the account password is still
        // present.  Refresh to a native access token before loading playlists;
        // otherwise the badge says “已连接” but both playlist requests are
        // rejected and the selects stay empty.
        if (!state.token || state.token === 'legacy') await restoreSavedUserSession();
        if (state.token) {
            await refreshAll().catch(notifyError);
            setActive(true);
        }
    }

    window.LibraryIntegration = {
        activate, login, refreshAll, refreshStatus, loadQueue, clearQueueHistory, importPlaylist, openSelectedImport,
        onHistoryChange, retryQueueItem, removeQueueItem,
        setFilter, toggleItem, toggleVisible, completeSelected, completeAll,
        triggerScan, refreshBothIndexes, refreshYinyunIndex, refreshSongloftIndex, resolveItem, updateSyncMode, syncPlaylist,
        deleteYinyunPlaylist, deleteSongloftPlaylist, openCandidatePicker, closeCandidatePicker,
        previewCandidate, previewLocalCandidate, previewQueueItem, openQueueSourcePicker, searchCandidates, closePreviewPlayer, setActive,
    };
})();
