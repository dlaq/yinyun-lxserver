'use strict';

(function exposeWebPlayerState(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.WebPlayerState = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
    function buildSingleTrackPlayback(list, index, useFullList) {
        const source = Array.isArray(list) ? list : [];
        const selected = source[index];
        if (!selected) return { list: [], index: -1 };
        return useFullList === false
            ? { list: [selected], index: 0 }
            : { list: source, index };
    }

    function isSongCollected(listData, songId) {
        if (!listData || !songId) return false;
        if (Array.isArray(listData.loveList) && listData.loveList.some(song => song?.id === songId)) return true;
        return Array.isArray(listData.userList) && listData.userList.some(list => (
            Array.isArray(list?.list) && list.list.some(song => song?.id === songId)
        ));
    }

    function playbackCacheKey(username, song, quality) {
        // IDs overlap between providers; local IDs can also overlap between
        // library owners. Neither private source URLs nor prefetched media
        // may be reused after switching accounts, platforms or quality.
        const identity = [
            String(username || '').trim().toLowerCase(),
            song?.source || '', song?.id || song?.songmid || song?.songId || '',
            song?._localOwner || song?.libraryOwner || '',
            song?.storageLocation || song?._localStorageLocation || '',
            song?.folder || song?._localFolder || '',
            song?.filename || song?._localFilename || '', quality || '',
        ];
        return `lx_url_v2_${identity.map(value => encodeURIComponent(String(value))).join('|')}`;
    }

    return { buildSingleTrackPlayback, isSongCollected, playbackCacheKey };
});
