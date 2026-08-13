/* 音云曲库联动管理界面：网络歌单 -> 本地匹配 -> 音云补齐 -> Songloft 同步 */
(function () {
    'use strict';

    const state = {
        token: '',
        username: '',
        importId: '',
        importData: null,
        filter: 'all',
        selected: new Set(),
        timer: null,
    };

    const el = id => document.getElementById(id);
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
    const unwrap = payload => payload?.data ?? payload;

    async function api(path, options = {}) {
        if (!state.token && path !== '/api/v1/auth/login') throw new Error('请先连接音云用户');
        const adminPassword = window.app?.password || localStorage.getItem('lx_auth') || '';
        const response = await fetch(path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
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

    function notifyError(error) {
        console.error('[LibraryIntegration]', error);
        if (typeof showError === 'function') showError(error.message || String(error));
    }

    function updateAuth(connected) {
        const badge = el('integration-auth-state');
        badge.textContent = connected ? `已连接 · ${state.username}` : '未连接';
        badge.classList.toggle('is-online', connected);
        badge.classList.toggle('is-offline', !connected);
    }

    async function login() {
        const username = el('integration-username').value.trim();
        const password = el('integration-password').value;
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
            updateAuth(true);
            sessionStorage.setItem('yinyun.integration.username', username);
            if (typeof showSuccess === 'function') showSuccess(`已连接用户 ${username}`);
            await refreshAll();
            startPolling();
        } catch (error) {
            state.token = '';
            updateAuth(false);
            notifyError(error);
        } finally {
            setBusy('integration-login-btn', false);
        }
    }

    async function loadStatus() {
        const [status, scan] = await Promise.all([
            api('/api/v1/integration/songloft/status'),
            api('/api/v1/integration/songloft/scan').catch(error => ({ status: 'unavailable', error: error.message })),
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
    }

    async function loadPlaylists() {
        const [local, remote] = await Promise.all([
            api('/api/v1/playlists'),
            api('/api/v1/integration/songloft/playlists'),
        ]);
        const localSelect = el('integration-yinyun-playlist');
        const remoteSelect = el('integration-songloft-playlist');
        localSelect.innerHTML = '<option value="">选择音云歌单</option>' + local.map(item =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${Number(item.trackCount || 0)} 首</option>`).join('');
        remoteSelect.innerHTML = '<option value="">按同名自动创建/匹配</option>' + (remote.playlists || []).map(item =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${Number(item.song_count || item.songCount || 0)} 首</option>`).join('');
        if (state.importData?.yinyunPlaylistId) localSelect.value = state.importData.yinyunPlaylistId;
    }

    function queueLabel(status) {
        return ({ waiting: '等待', downloading: '下载中', tagging: '写入元数据', finished: '完成', exists: '已存在', error: '失败', paused: '暂停' })[status] || status;
    }

    async function loadQueue() {
        if (!state.token) return;
        const data = await api('/api/v1/downloads');
        const items = data.items || [];
        const counts = items.reduce((map, item) => ((map[item.status] = (map[item.status] || 0) + 1), map), {});
        const active = (counts.waiting || 0) + (counts.downloading || 0) + (counts.tagging || 0);
        el('integration-queue-status').textContent = String(active);
        el('integration-queue-detail').textContent = `总计 ${items.length} · 并发 ${data.concurrency || 0}`;
        el('integration-queue-summary').innerHTML = ['downloading', 'waiting', 'finished', 'exists', 'error'].map(status =>
            `<div class="queue-chip status-${status}"><strong>${counts[status] || 0}</strong><span>${queueLabel(status)}</span></div>`).join('');
        const visible = [...items].reverse().slice(0, 8);
        el('integration-queue-list').innerHTML = visible.length ? visible.map(item => {
            const song = item.songInfo || {};
            return `<div class="queue-row"><div><strong>${escapeHtml(song.name || song.title || '未知歌曲')}</strong><span>${escapeHtml(song.singer || song.artist || '')}</span></div><div class="queue-progress"><span style="width:${Math.max(0, Math.min(100, Number(item.progress || 0)))}%"></span></div><em class="status-${escapeHtml(item.status)}">${escapeHtml(queueLabel(item.status))}</em></div>`;
        }).join('') : '<div class="integration-empty">暂无下载任务</div>';
    }

    async function importPlaylist() {
        const url = el('integration-playlist-url').value.trim();
        if (!url) return notifyError(new Error('请粘贴网络歌单地址'));
        setBusy('integration-import-btn', true, '解析与匹配中');
        try {
            const data = await api('/api/v1/integration/playlist/import', {
                method: 'POST', body: JSON.stringify({ url, autoDownload: false }),
            });
            state.importId = data.importId;
            el('integration-import-id').value = data.importId;
            sessionStorage.setItem(`yinyun.integration.import.${state.username}`, data.importId);
            renderImport(data);
            await loadPlaylists();
            if (typeof showSuccess === 'function') showSuccess(`已导入 ${data.counts?.total || 0} 首，缺失 ${data.counts?.missing || 0} 首`);
        } catch (error) { notifyError(error); }
        finally { setBusy('integration-import-btn', false); }
    }

    async function openImport() {
        const importId = el('integration-import-id').value.trim();
        if (!importId) return notifyError(new Error('请输入导入记录 ID'));
        setBusy('integration-open-import-btn', true, '读取中');
        try {
            const data = await api(`/api/v1/integration/playlist/import/${encodeURIComponent(importId)}`);
            state.importId = importId;
            sessionStorage.setItem(`yinyun.integration.import.${state.username}`, importId);
            renderImport(data);
            await loadPlaylists();
            if (typeof showSuccess === 'function') showSuccess(`已打开记录，重新匹配 ${data.counts?.total || 0} 首歌曲`);
        } catch (error) { notifyError(error); }
        finally { setBusy('integration-open-import-btn', false); }
    }

    function renderImport(data) {
        state.importData = data;
        state.selected.clear();
        el('integration-result-panel').classList.remove('hidden');
        el('integration-result-title').textContent = data.name || '匹配结果';
        el('integration-import-meta').textContent = data.importId || state.importId;
        const counts = data.counts || {};
        el('integration-count-total').textContent = counts.total || 0;
        el('integration-count-matched').textContent = counts.localMatched || 0;
        el('integration-count-missing').textContent = counts.missing || 0;
        el('integration-count-ambiguous').textContent = counts.ambiguous || 0;
        el('integration-count-yinyun').textContent = counts.yinyunMatched ?? counts.localMatched ?? 0;
        el('integration-count-songloft').textContent = counts.songloftMatched ?? 0;
        renderRows();
        el('integration-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderRows() {
        const items = state.importData?.items || [];
        const visible = state.filter === 'all' ? items : items.filter(item => item.status === state.filter);
        const body = el('integration-result-body');
        const statusLabel = status => status === 'matched' ? '已找到' : status === 'missing' ? '未找到' : '需确认';
        const statusCell = (match, label) => `<div class="integration-source-cell"><span class="match-pill status-${escapeHtml(match?.status || 'missing')}">${label}: ${statusLabel(match?.status)}</span>${match?.candidate ? `<small>${escapeHtml(match.candidate.title || '')} · ${escapeHtml(match.candidate.artist || '')}</small>` : ''}</div>`;
        body.innerHTML = visible.length ? visible.map(item => {
            const source = item.source || {};
            const checked = state.selected.has(Number(item.index));
            const canSelect = item.status === 'missing' && item.downloadable !== false;
            const decision = item.status === 'matched' ? (item.matchedBy === 'songloft' ? '共享文件已存在，等待音云索引' : '音云已收录') : item.status === 'ambiguous' ? '需要人工确认' : '可加入音云下载';
            return `<tr><td><input type="checkbox" ${checked ? 'checked' : ''} ${canSelect ? '' : 'disabled'} onchange="LibraryIntegration.toggleItem(${Number(item.index)}, this.checked)"></td><td><strong>${escapeHtml(source.title || '未知歌曲')}</strong><small>${escapeHtml(source.artist || '')}</small></td><td>${escapeHtml(source.album || '—')}</td><td>${statusCell(item.yinyun, '音云')}</td><td>${statusCell(item.songloft, 'Songloft')}</td><td><span class="match-pill status-${escapeHtml(item.status)}">${escapeHtml(decision)}</span></td></tr>`;
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
        const missing = state.importData?.counts?.missing || 0;
        const amount = mode === 'all' ? missing : indexes.length;
        if (!amount) return notifyError(new Error(mode === 'all' ? '没有需要补齐的歌曲' : '请先选择缺失歌曲'));
        const confirmed = typeof showSelect !== 'function' || await showSelect('确认加入下载队列', `将 ${amount} 首歌曲按 ${el('integration-quality').value} 音质加入音云下载队列。继续吗？`);
        if (!confirmed) return;
        const buttonId = mode === 'all' ? 'integration-complete-all' : 'integration-complete-selected';
        setBusy(buttonId, true, '提交中');
        try {
            const data = await api('/api/v1/integration/playlist/complete', {
                method: 'POST',
                body: JSON.stringify({ importId: state.importId, mode, indexes, quality: el('integration-quality').value }),
            });
            const queued = data.download?.queued?.length || 0;
            const skipped = data.download?.skipped?.length || 0;
            if (typeof showSuccess === 'function') showSuccess(`已加入 ${queued} 个任务${skipped ? `，跳过 ${skipped} 首` : ''}`);
            await loadQueue();
        } catch (error) { notifyError(error); }
        finally { setBusy(buttonId, false); }
    }

    function completeSelected() { return complete('selected', [...state.selected].sort((a, b) => a - b)); }
    function completeAll() { return complete('all'); }

    async function triggerScan() {
        try {
            await api('/api/v1/integration/songloft/scan', { method: 'POST', body: JSON.stringify({ reimport: false }) });
            if (typeof showSuccess === 'function') showSuccess('已触发 Songloft 曲库扫描');
            setTimeout(() => loadStatus().catch(console.error), 1000);
        } catch (error) { notifyError(error); }
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
        await Promise.allSettled([loadStatus(), loadQueue(), loadPlaylists()]);
        if (state.importId) await openImport().catch(console.error);
    }

    function startPolling() {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => {
            if (state.token && document.getElementById('view-library-integration')?.classList.contains('active')) {
                loadQueue().catch(console.error);
            }
        }, 5000);
    }

    function activate() {
        const savedUser = sessionStorage.getItem('yinyun.integration.username');
        if (savedUser) el('integration-username').value = savedUser;
        if (state.token) {
            refreshAll().catch(notifyError);
            startPolling();
        }
    }

    window.LibraryIntegration = {
        activate, login, refreshAll, loadQueue, importPlaylist, openImport,
        setFilter, toggleItem, toggleVisible, completeSelected, completeAll,
        triggerScan, updateSyncMode, syncPlaylist,
    };
})();
