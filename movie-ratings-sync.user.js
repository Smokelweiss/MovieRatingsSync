// ==UserScript==
// @name         Movie Ratings Sync
// @name:ru      Синхронизация Кинооценок
// @namespace    movie-ratings-sync
// @version      1.0
// @description  Sync movie ratings across Kinopoisk, IMDb, Letterboxd and more
// @description:ru Синхронизируйте оценки фильмов между Kinopoisk, IMDb, Letterboxd и другими сервисами
// @author       Smokelweiss
// @match        https://www.kinopoisk.ru/*
// @match        https://www.imdb.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @supportURL   https://github.com/Smokelweiss/MovieRatingsSync/issues
// @license      GPL-3.0
// ==/UserScript==

(function () {
    'use strict';

    // ====================== CONSTANTS ======================

    const SITE = {
        isKP:   location.hostname.includes('kinopoisk.ru'),
        isIMDb: location.hostname.includes('imdb.com'),
    };

    const DELAY = {
        KP_INIT:        280,
        GQL_INIT:       280,
        KP_MIN_FAST:    30,
        KP_MIN_SLOW:    40,
        KP_MAX:         3000,
        GQL_MAX:        3000,
        PAGE_BETWEEN:   60,
        HISTORY_PAGE:   300,
        FACTOR_FAST:    0.70,
        FACTOR_MID:     0.85,
        FACTOR_SLOW:    1.05,
        FACTOR_429:     2.00,
        FACTOR_ERROR:   1.30,
    };

    const CONCURRENCY = {
        INIT:       25,
        MAX:        100,
        STEP_UP:    5,
        STEP_DOWN:  10,
        STREAK_REQ: 5,
    };

    const RETRY = {
        KP_FETCH:         4,
        GQL:              3,
        HISTORY_MAX_PAGES: 100,
    };

    const YEAR_TOLERANCE = 1;

    // ====================== UTILITIES ======================

    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(ms, 1)));

    let _dotsCount = 0;
    const dots = () => { _dotsCount = (_dotsCount + 1) % 3; return '.'.repeat(_dotsCount + 1); };

    async function fetchWithTimeout(url, timeoutMs = 15000, opts = {}) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            return await fetch(url, { ...opts, credentials: 'include', signal: ctrl.signal });
        } catch (err) {
            if (err.name === 'AbortError') console.warn('[kp-imdb] Timeout:', url);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function adjustDelay(target, outcome, responseTimeMs = 0) {
        const { FACTOR_FAST, FACTOR_MID, FACTOR_SLOW, FACTOR_429, FACTOR_ERROR,
                KP_MIN_FAST, KP_MIN_SLOW, KP_MAX } = DELAY;
        switch (outcome) {
            case 'ok':
                if (responseTimeMs < 300)       target.val = Math.max(KP_MIN_FAST, Math.floor(target.val * FACTOR_FAST));
                else if (responseTimeMs < 1000) target.val = Math.max(KP_MIN_SLOW, Math.floor(target.val * FACTOR_MID));
                else                            target.val = Math.min(KP_MAX, Math.floor(target.val * FACTOR_SLOW));
                break;
            case '429':
                target.val = Math.min(KP_MAX, Math.floor(target.val * FACTOR_429));
                break;
            default:
                target.val = Math.min(KP_MAX, Math.floor(target.val * FACTOR_ERROR));
        }
    }

    // ====================== CONCURRENCY PROBE ======================

    function makeProbe(init = CONCURRENCY.INIT) {
        return { concurrency: init, streak: 0 };
    }

    function probeSuccess(p) {
        p.streak++;
        if (p.streak >= CONCURRENCY.STREAK_REQ && p.concurrency < CONCURRENCY.MAX) {
            p.concurrency = Math.min(CONCURRENCY.MAX, p.concurrency + CONCURRENCY.STEP_UP);
            p.streak = 0;
        }
    }

    function probeFail(p) {
        p.concurrency = Math.max(1, p.concurrency - CONCURRENCY.STEP_DOWN);
        p.streak = 0;
    }

    // Два независимых зонда: для KP-фетчей и для GQL-мутаций
    const kpProbe  = makeProbe();
    const gqlProbe = makeProbe();

    // ====================== CSV HELPERS ======================

    function csvEscape(str) {
        return `"${String(str || '').replace(/"/g, '""')}"`;
    }

    function buildCSV(rows) {
        const lines = ['Title,Year,Rating10'];
        for (const row of rows) {
            lines.push(`${csvEscape(row.title)},${row.year || ''},${row.rating || ''}`);
        }
        return lines.join('\n');
    }

    function downloadCSV(csvText, filename) {
        const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8;' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    // ====================== TRANSLITERATION ======================

    const CYR_MAP = {
        'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z',
        'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
        'С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh',
        'Щ':'Shch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
        'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
        'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
        'щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    };

    const hasCyrillic = (s) => /[а-яА-ЯёЁ]/.test(s);
    const toTranslit  = (s) => s.split('').map((c) => CYR_MAP[c] ?? c).join('');

    function normalizeTitle(s) {
        return s.toLowerCase()
            .replace(/[:\-–—.,!?'"«»()\[\]\\\/]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function yearsMatch(a, b) {
        if (!a || !b) return false;
        const ya = parseInt(String(a).match(/^(\d{4})/)?.[1], 10);
        const yb = parseInt(b, 10);
        return !isNaN(ya) && !isNaN(yb) && Math.abs(ya - yb) <= YEAR_TOLERANCE;
    }

    // ====================== KP EXPORT ======================

    function getKPUserId() {
        const urlMatch = location.href.match(/\/user\/(\d+)/);
        if (urlMatch) return urlMatch[1];
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (el) {
                const data = JSON.parse(el.textContent);
                const pp   = data?.props?.pageProps;
                const uid  = pp?.user?.id || pp?.userData?.id
                    || pp?.requestContext?.user?.id || pp?.currentUser?.id;
                if (uid) return String(uid);
            }
        } catch (_) {}
        return null;
    }

    function parseKPListingPage(doc) {
        const results = [];
        const seen    = new Set();

        for (const anchor of doc.querySelectorAll('a[href*="/film/"], a[href*="/series/"]')) {
            const href  = anchor.getAttribute('href') || '';
            const match = href.match(/\/(film|series)\/(\d+)/);
            if (!match || seen.has(match[2])) continue;

            const item     = anchor.closest('[class*="item"]') || anchor.closest('li') || anchor.parentElement;
            const imgAlt   = anchor.querySelector('img')?.alt || '';
            const yearStr  = item?.querySelector('[class*="subtitle"],[class*="year"]')?.textContent || '';
            const ratingEl = item?.querySelector('[class*="value"],[class*="rating"],[class*="score"]');

            seen.add(match[2]);
            results.push({
                kpId:    match[2],
                kpType:  match[1],
                titleRu: imgAlt.split('.')[0].trim() || anchor.textContent.trim(),
                year:    yearStr.match(/\b(19|20)\d{2}\b/)?.[0] || '',
                rating:  ratingEl?.textContent.trim() || '',
                attempts: 0,
            });
        }

        if (results.length === 0) {
            try {
                const nd   = doc.getElementById('__NEXT_DATA__');
                const json = nd ? JSON.parse(nd.textContent) : null;
                const list = json?.props?.pageProps?.data?.items
                    || json?.props?.pageProps?.items || [];
                for (const entry of list) {
                    const id   = entry?.movie?.id || entry?.id;
                    const type = entry?.movie?.__typename?.toLowerCase().includes('series') ? 'series' : 'film';
                    if (!id || seen.has(String(id))) continue;
                    seen.add(String(id));
                    results.push({
                        kpId:    String(id),
                        kpType:  type,
                        titleRu: entry?.movie?.title?.russian || entry?.movie?.title?.original || '',
                        year:    String(entry?.movie?.productionYear || ''),
                        rating:  String(entry?.userVote || ''),
                        attempts: 0,
                    });
                }
            } catch (_) {}
        }

        return results;
    }

    async function fetchDocTimed(url) {
        const t0   = Date.now();
        const resp = await fetchWithTimeout(url, 15000);
        const time = Date.now() - t0;
        if (!resp?.ok) return { doc: null, time };
        const doc  = new DOMParser().parseFromString(await resp.text(), 'text/html');
        return { doc, time };
    }

    async function fetchKPOriginalTitle(item) {
        for (let attempt = 1; attempt <= RETRY.KP_FETCH; attempt++) {
            item.attempts = attempt;
            try {
                const { doc, time } = await fetchDocTimed(
                    `https://www.kinopoisk.ru/${item.kpType}/${item.kpId}/`
                );
                if (!doc) throw new Error('no doc');

                let title = item.titleRu;

                const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
                if (ogTitle) {
                    title = ogTitle.replace(/\s*\(\d{4}.*?\)/, '').trim() || title;
                } else {
                    const origEl = doc.querySelector(
                        '[class*="OriginalTitle"], [class*="originalTitle"], [class*="original-title"]'
                    );
                    if (origEl) title = origEl.textContent.trim() || title;
                }

                adjustDelay(kpDelay, 'ok', time);
                return title;
            } catch (_) {
                adjustDelay(kpDelay, 'error');
                if (attempt < RETRY.KP_FETCH) await sleep(kpDelay.val * 1.5);
            }
        }
        return item.titleRu;
    }

    const kpDelay  = { val: DELAY.KP_INIT };
    const gqlDelay = { val: DELAY.GQL_INIT };

    async function performKPExport(statusEl) {
        const userId = getKPUserId();
        if (!userId) throw new Error('user ID не найден — откройте страницу профиля КП');

        const baseUrl = `https://www.kinopoisk.ru/user/${userId}/movies/voted-watched`;

        setStatus(statusEl, `Загрузка страницы 1${dots()}`);
        const { doc: firstDoc } = await fetchDocTimed(`${baseUrl}/?page=1`);
        if (!firstDoc) throw new Error('Не удалось загрузить листинг КП');

        let totalPages = 1;
        for (const a of firstDoc.querySelectorAll('a[href*="?page="]')) {
            const m = a.href.match(/[?&]page=(\d+)/);
            if (m) totalPages = Math.max(totalPages, +m[1]);
        }

        let allItems = parseKPListingPage(firstDoc);
        for (let page = 2; page <= totalPages; page++) {
            setStatus(statusEl, `Страница ${page}/${totalPages}${dots()}`);
            const { doc } = await fetchDocTimed(`${baseUrl}/?page=${page}`);
            if (doc) allItems = allItems.concat(parseKPListingPage(doc));
            await sleep(DELAY.PAGE_BETWEEN);
        }

        const unique = [...new Map(allItems.map((i) => [i.kpId, i])).values()];

        Object.assign(kpProbe, { concurrency: CONCURRENCY.INIT, streak: 0 });
        kpDelay.val = DELAY.KP_INIT;

        const failedItems = [];
        let processed = 0;

        while (processed < unique.length) {
            const batchSize = kpProbe.concurrency;
            const slice     = unique.slice(processed, processed + batchSize);
            const pending   = slice.filter((it) => !it.titleFinal);

            if (pending.length === 0) { processed += batchSize; continue; }

            setStatus(statusEl, `Экспортируем ${processed + 1}–${Math.min(processed + batchSize, unique.length)}/${unique.length}${dots()}`);

            const results = await Promise.allSettled(pending.map((it) => fetchKPOriginalTitle(it)));

            let anyFail = false;
            for (let j = 0; j < results.length; j++) {
                const res  = results[j];
                const item = pending[j];
                if (res.status === 'fulfilled') {
                    item.titleFinal = res.value;
                    if (item.attempts >= 3) { failedItems.push(item); anyFail = true; }
                } else {
                    failedItems.push(item);
                    anyFail = true;
                }
            }

            processed += batchSize;
            anyFail ? probeFail(kpProbe) : probeSuccess(kpProbe);
            if (processed < unique.length) await sleep(kpDelay.val);
        }

        if (failedItems.length) {
            setStatus(statusEl, `Повтор для ${failedItems.length} фильмов${dots()}`);
            kpDelay.val = Math.max(500, kpDelay.val);
            for (const item of failedItems) {
                setStatus(statusEl, `Retry: ${item.titleRu}${dots()}`);
                item.titleFinal = await fetchKPOriginalTitle(item);
                await sleep(kpDelay.val);
            }
        }

        const rows = unique.map((it) => ({
            title:  it.titleFinal || it.titleRu,
            year:   it.year,
            rating: it.rating,
        }));

        return buildCSV(rows);
    }

    // ====================== IMDB: TITLE MAP ======================

    /** Глобальная карта нормализованных заголовков → { ttId, year } */
    let titleMap = new Map();
    /** Кэш getUserHistory */
    let cachedHistory = null;

    function resetTitleMap() {
        titleMap = new Map();
    }

    function registerTitle(id, titleText, origText, year) {
        const entry   = { ttId: id, year };
        const seenKeys = new Set();

        const add = (raw) => {
            if (!raw) return;
            const key = raw.toLowerCase().trim();
            if (key.length > 1 && !seenKeys.has(key)) {
                seenKeys.add(key);
                titleMap.set(key, entry);
            }
        };

        const addAll = (text) => {
            if (!text) return;
            add(text);
            add(normalizeTitle(text));
            if (hasCyrillic(text)) {
                const tr = toTranslit(text);
                add(tr);
                add(normalizeTitle(tr));
            }
        };

        addAll(titleText);
        if (origText && origText !== titleText) addAll(origText);
    }

    function lookupTitleMap(title, year) {
        const key  = title.toLowerCase().trim();
        const nKey = normalizeTitle(title);
        const trKey = hasCyrillic(title) ? toTranslit(title).toLowerCase().trim() : null;

        for (const k of [key, nKey, trKey]) {
            if (!k) continue;
            const e = titleMap.get(k);
            if (e?.ttId && yearsMatch(e.year, year)) return e.ttId;
        }

        for (const [k2, v] of titleMap) {
            if (normalizeTitle(k2) === nKey && yearsMatch(v.year, year)) return v.ttId;
        }

        if (trKey) {
            const nTr = normalizeTitle(toTranslit(title));
            for (const [k2, v] of titleMap) {
                if (normalizeTitle(k2) === nTr && yearsMatch(v.year, year)) return v.ttId;
            }
        }

        for (const [k2, v] of titleMap) {
            if (!yearsMatch(v.year, year)) continue;
            const nk2 = normalizeTitle(k2);
            if (nk2.includes(nKey) || nKey.includes(nk2)) return v.ttId;
        }

        return null;
    }

    function parseEdgesIntoMap(edges, targetSet) {
        for (const edge of edges) {
            const node = edge?.node?.title || edge?.node;
            const id   = node?.id;
            if (!id?.startsWith('tt')) continue;
            targetSet.add(id);
            registerTitle(id, node?.titleText?.text, node?.originalTitleText?.text, node?.releaseYear?.year);
        }
    }

    // ====================== IMDB: USER DATA ======================

    function getIMDbUserId() {
        try {
            const nd = document.getElementById('__NEXT_DATA__');
            if (nd) {
                const sc = JSON.parse(nd.textContent)?.props?.pageProps?.requestContext?.sidecar?.account;
                if (sc?.userId) return sc.userId;
            }
        } catch (_) {}
        const m = location.href.match(/\/user\/(ur\d+)/i);
        return m ? m[1] : null;
    }

    async function fetchNextData(url) {
        try {
            const resp = await fetchWithTimeout(url, 15000);
            if (!resp?.ok) return null;
            const html  = await resp.text();
            const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            return match ? JSON.parse(match[1]) : null;
        } catch (_) {
            return null;
        }
    }

    async function scanIMDbHistory(userId, statusEl) {
        const rated   = new Set();
        const watched = new Set();

        const scan = async (urlTemplate, label, targetSet) => {
            for (let page = 1; page <= RETRY.HISTORY_MAX_PAGES; page++) {
                setStatus(statusEl, `${label} стр. ${page}${dots()}`);
                const nd     = await fetchNextData(urlTemplate(userId, page));
                if (!nd) break;
                const search = nd?.props?.pageProps?.mainColumnData?.advancedTitleSearch;
                const edges  = search?.edges || [];
                if (!edges.length) break;
                parseEdgesIntoMap(edges, targetSet);
                if (!search?.pageInfo?.hasNextPage) break;
                await sleep(DELAY.HISTORY_PAGE);
            }
        };

        await scan(
            (uid, p) => `https://www.imdb.com/user/${uid}/watchhistory/?my_ratings=exclude&page=${p}`,
            'История просмотров',
            watched
        );
        await scan(
            (uid, p) => `https://www.imdb.com/user/${uid}/ratings/?page=${p}`,
            'Оценки',
            rated
        );

        return { rated, watched };
    }

    async function getUserHistory(statusEl) {
        if (cachedHistory) return cachedHistory;

        setStatus(statusEl, `Определяем профиль IMDb${dots()}`);
        const userId = getIMDbUserId();
        if (!userId) {
            setStatus(statusEl, '❌ IMDb user ID не найден — войдите в аккаунт');
            cachedHistory = { rated: new Set(), watched: new Set() };
            return cachedHistory;
        }

        const { rated, watched } = await scanIMDbHistory(userId, statusEl);
        setStatus(statusEl, `Найдено: ${rated.size} оценок, ${watched.size} просмотров, ${titleMap.size} в карте`);
        cachedHistory = { rated, watched };
        return cachedHistory;
    }

    // ====================== IMDB: GRAPHQL ======================

    const GQL_ENDPOINT = 'https://api.graphql.imdb.com/';

    const GQL_RATE_TITLE = `
        mutation RateTitle($titleId: ID!, $rating: Int!) {
            rateTitle(input: { titleId: $titleId, rating: $rating }) {
                rating { value }
            }
        }`;

    const GQL_ADD_WATCHED = `
        mutation AddWatched($titleId: ID!) {
            addWatchedTitle(titleId: $titleId) { success }
        }`;

    async function gqlWithRetry(query, variables) {
        for (let attempt = 1; attempt <= RETRY.GQL; attempt++) {
            try {
                const resp = await fetchWithTimeout(GQL_ENDPOINT, 10000, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ query, variables }),
                });

                if (!resp) { adjustDelay(gqlDelay, 'error'); continue; }

                if (resp.status === 429) {
                    adjustDelay(gqlDelay, '429');
                    await sleep(gqlDelay.val * 1.5);
                    continue;
                }

                const json = await resp.json().catch(() => ({}));
                adjustDelay(gqlDelay, json?.errors ? '429' : 'ok', 200);
                return json;
            } catch (_) {
                adjustDelay(gqlDelay, 'error');
            }

            if (attempt < RETRY.GQL) await sleep(gqlDelay.val * 1.6);
        }
        return null;
    }

    /**
     * Применяет оценку или отметку «просмотрено» к фильму на IMDb.
     *
     * Режим normal: выставляем рейтинг если есть, иначе помечаем watched.
     *
     * Режим replace:
     *   - Если есть рейтинг — всегда выставляем его (перезаписывает старый).
     *   - Если рейтинга нет — помечаем watched даже если уже есть оценка
     *     (watched приоритетнее существующих оценок в этом режиме).
     *
     * Возвращает 'rated' | 'watched' | null.
     */
    async function applyToIMDb(ttId, rating, ratedSet, watchedSet, mode = 'normal') {
        const hasRating = rating != null && String(rating) !== '' && Number(rating) >= 1 && Number(rating) <= 10;

        if (hasRating) {
            // В обоих режимах выставляем оценку (GraphQL перезапишет старую сам)
            const json = await gqlWithRetry(GQL_RATE_TITLE, { titleId: ttId, rating: Number(rating) });
            if (json?.data?.rateTitle?.rating?.value) {
                ratedSet.add(ttId);
                watchedSet.add(ttId); // оценённое считается и просмотренным
                return 'rated';
            }
            return null;
        } else {
            // Нет рейтинга → помечаем watched
            const json = await gqlWithRetry(GQL_ADD_WATCHED, { titleId: ttId });
            if (json?.data?.addWatchedTitle?.success) {
                watchedSet.add(ttId);
                return 'watched';
            }
            return null;
        }
    }

    /**
     * Проверяет, нужно ли пропустить фильм.
     *
     * normal:   пропускаем если уже оценён ИЛИ (нет рейтинга и уже в watched).
     * replace:  НЕ пропускаем ничего — перезаписываем всё.
     */
    function isAlreadyProcessed(ttId, rating, ratedSet, watchedSet, mode) {
        if (mode === 'replace') return false; // жёсткий импорт всегда идёт вперёд

        if (ratedSet.has(ttId)) return true;
        if (watchedSet.has(ttId) && (rating == null || String(rating) === '')) return true;
        return false;
    }

    // ====================== IMDB: SEARCH FALLBACK ======================

    async function searchIMDbByTitle(title, year) {
        const queries = [title];
        if (hasCyrillic(title)) queries.push(toTranslit(title));

        const titleTypes = ['ft', 'tv'];

        for (const q of queries) {
            for (const ttype of titleTypes) {
                const url  = `https://www.imdb.com/find/?q=${encodeURIComponent(q)}&s=tt&ttype=${ttype}`;
                const resp = await fetchWithTimeout(url, 10000);
                if (!resp?.ok) continue;

                const html  = await resp.text();
                const ttIds = [...new Set([...html.matchAll(/\/title\/(tt\d+)/g)].map((m) => m[1]))];
                if (!ttIds.length) continue;

                if (year) {
                    for (const ttId of ttIds) {
                        const idx   = html.indexOf(ttId);
                        const chunk = html.substring(Math.max(0, idx - 200), idx + 200);
                        if (chunk.includes(String(year))) return ttId;
                    }
                }

                return ttIds[0];
            }
        }

        return null;
    }

    async function resolveIMDbId(title, year, deepSearch = false) {
        const fromMap = lookupTitleMap(title, year);
        if (fromMap) return fromMap;
        if (!deepSearch) return null;
        return searchIMDbByTitle(title, year);
    }

    // ====================== CSV PARSER ======================

    function parseKPCsv(text) {
        const items = [];
        const lines = text.trim().split(/\r?\n/).slice(1);

        for (const rawLine of lines) {
            const line  = rawLine.trim();
            const match = line.match(/^"((?:[^"]|"")*)",(\d{4}),(\d*)$/);
            if (!match) continue;

            let title   = match[1].replace(/""/g, '"').trim();
            const year  = match[2];
            const score = match[3] ? +match[3] : null;

            const origMatch = title.match(/\((.+?),\s*\d{4}(?:-\d{4})?\)$/);
            if (origMatch) {
                title = origMatch[1].trim();
            } else {
                title = title
                    .replace(/,\s*\d{4}(?:-\d{4})?\s*$/, '')
                    .replace(/[«»]/g, '')
                    .trim();
            }

            items.push({ title, year, rating: score });
        }

        return items;
    }

    // ====================== IMPORT PIPELINE ======================

    /**
     * Параллельно резолвит ttId для пачки items.
     * deep=false → только titleMap; deep=true → + HTTP-поиск.
     * Возвращает массив { item, ttId|null } в том же порядке.
     */
    async function resolvePhase(items, statusEl, deep, totalDone, totalAll) {
        Object.assign(kpProbe, { concurrency: CONCURRENCY.INIT, streak: 0 });

        const resolved = new Array(items.length).fill(null).map(() => ({ item: null, ttId: null }));
        let cursor = 0;

        while (cursor < items.length) {
            const batchSize = kpProbe.concurrency;
            const slice     = items.slice(cursor, cursor + batchSize);

            setStatus(statusEl,
                `Поиск ${totalDone + cursor + 1}–${totalDone + Math.min(cursor + batchSize, items.length)}/${totalAll}${dots()}`
            );

            const t0      = Date.now();
            const results = await Promise.allSettled(
                slice.map((item) => resolveIMDbId(item.title, item.year, deep))
            );
            const elapsed = Date.now() - t0;

            let anyFail = false;
            for (let j = 0; j < results.length; j++) {
                const ttId = results[j].status === 'fulfilled' ? results[j].value : null;
                resolved[cursor + j] = { item: slice[j], ttId };
                if (!ttId && deep) anyFail = true; // только при deep search считаем промахи ошибками
            }

            anyFail ? probeFail(kpProbe) : probeSuccess(kpProbe);
            cursor += batchSize;
            if (cursor < items.length) await sleep(Math.max(30, elapsed < 300 ? 30 : 60));
        }

        return resolved;
    }

    /**
     * Параллельно применяет GQL-мутации для пачки resolved-записей.
     * Пропускает уже обработанные (isAlreadyProcessed).
     * Обновляет счётчики и мутирует ratedSet/watchedSet.
     */
    async function applyPhase(resolved, ratedSet, watchedSet, statusEl, mode, totalDone, totalAll) {
        Object.assign(gqlProbe, { concurrency: CONCURRENCY.INIT, streak: 0 });
        gqlDelay.val = DELAY.GQL_INIT;

        let rated = 0, watched = 0, skipped = 0, notFound = 0, failed = 0;
        const missed = [];

        // Предварительная фильтрация: notFound и skip без сетевых запросов
        const toApply = [];
        for (const { item, ttId } of resolved) {
            if (!ttId) {
                notFound++;
                missed.push(item);
                continue;
            }
            if (isAlreadyProcessed(ttId, item.rating, ratedSet, watchedSet, mode)) {
                skipped++;
                continue;
            }
            toApply.push({ item, ttId });
        }

        let cursor = 0;
        while (cursor < toApply.length) {
            const batchSize = gqlProbe.concurrency;
            const slice     = toApply.slice(cursor, cursor + batchSize);
            const doneCount = totalDone + cursor;

            setStatus(statusEl,
                `Импорт ${doneCount + 1}–${doneCount + slice.length}/${totalAll}${dots()}`
            );

            const results = await Promise.allSettled(
                slice.map(({ item, ttId }) => applyToIMDb(ttId, item.rating, ratedSet, watchedSet, mode))
            );

            let anyFail = false;
            for (let j = 0; j < results.length; j++) {
                const { item } = slice[j];
                const result   = results[j].status === 'fulfilled' ? results[j].value : null;
                if (result === 'rated')        rated++;
                else if (result === 'watched') watched++;
                else { failed++; missed.push(item); anyFail = true; }
            }

            anyFail ? probeFail(gqlProbe) : probeSuccess(gqlProbe);
            cursor += batchSize;
            if (cursor < toApply.length) await sleep(gqlDelay.val);
        }

        return { rated, watched, skipped, notFound, failed, missed };
    }

    /**
     * Основной пайплайн: две фазы — resolve (параллельный поиск ttId)
     * и apply (параллельные GQL-мутации).
     *
     * deep=true включает HTTP-поиск в фазе resolve (медленнее, но находит больше).
     */
    async function processItems(items, ratedSet, watchedSet, statusEl, deep = false, mode = 'normal') {
        // Фаза 1: резолвим все ttId параллельно
        setStatus(statusEl, `Фаза 1/2: поиск ID для ${items.length} записей${dots()}`);
        const resolved = await resolvePhase(items, statusEl, deep, 0, items.length);

        // Фаза 2: параллельно шлём GQL-мутации
        setStatus(statusEl, `Фаза 2/2: отправка на IMDb${dots()}`);
        return applyPhase(resolved, ratedSet, watchedSet, statusEl, mode, 0, items.length);
    }

    async function runImport(file, statusEl, mode) {
        const text  = await file.text();
        const items = parseKPCsv(text);

        if (!items.length) {
            setStatus(statusEl, '❌ CSV пуст или не распознан');
            return;
        }

        // Сбрасываем кэш перед каждым импортом чтобы карта пересобралась.
        // При replace — кэшированная история тоже не нужна.
        cachedHistory = null;
        // titleMap НЕ сбрасываем здесь — он наполнится при scanIMDbHistory
        // и останется доступным для resolveIMDbId в processItems.

        if (mode === 'normal') {
            setStatus(statusEl, `Загружено ${items.length} записей. Сканируем историю IMDb${dots()}`);
            const history = await getUserHistory(statusEl);
            const { rated: ratedSet, watched: watchedSet } = history;

            setStatus(statusEl, `Обрабатываем ${items.length} записей${dots()}`);
            const result = await processItems(items, ratedSet, watchedSet, statusEl, false, 'normal');
            renderImportResult(result, statusEl, ratedSet, watchedSet, mode);

        } else {
            // Режим replace:
            // 1. Сканируем историю, чтобы заполнить titleMap → resolveIMDbId работает.
            // 2. Сами сеты ratedSet/watchedSet передаём пустыми —
            //    isAlreadyProcessed(mode='replace') всё равно вернёт false,
            //    поэтому эти сеты служат только для трекинга прогресса.
            setStatus(statusEl, `Загружено ${items.length} записей. Сканируем IMDb для построения карты${dots()}`);

            resetTitleMap(); // чистим перед свежим сканом

            const userId = getIMDbUserId();
            if (userId) {
                // Сканируем только чтобы заполнить titleMap; сами сеты нам не важны
                await scanIMDbHistory(userId, statusEl);
                setStatus(statusEl, `Карта построена (${titleMap.size} записей). Жёсткий импорт…`);
            } else {
                setStatus(statusEl, `❌ IMDb user ID не найден — войдите в аккаунт. Глубокий поиск будет медленнее.`);
            }

            const ratedSet   = new Set();
            const watchedSet = new Set();

            const result = await processItems(items, ratedSet, watchedSet, statusEl, false, 'replace');
            renderImportResult(result, statusEl, ratedSet, watchedSet, mode);
        }
    }

    // ====================== UI HELPERS ======================

    function setStatus(el, text) {
        if (!el) return;
        el.style.display = 'block';
        el.textContent   = text;
    }

    function renderImportResult(result, statusEl, ratedSet, watchedSet, mode) {
        const lbl    = mode === 'replace' ? ' (режим замены)' : '';
        const allOk  = result.notFound === 0 && result.failed === 0;
        const missed = result.missed;

        let html = `
            ✅ <b>Готово${lbl}!</b><br>
            Оценено: <b>${result.rated}</b><br>
            Просмотрено: <b>${result.watched}</b><br>
            Пропущено (уже есть): <b>${result.skipped}</b><br>
            Не найдено на IMDb: <b>${result.notFound}</b><br>
            Ошибок: <b>${result.failed}</b>
        `;

        if (allOk) html += '<br><br>🎉 Все записи импортированы!';

        if (missed.length) {
            downloadCSV(
                buildCSV(missed.map((m) => ({ title: m.title, year: m.year, rating: m.rating }))),
                'imdb_missed.csv'
            );
            html += `<br><br>
                <button id="kp-imdb-retry-btn" class="kp-imdb-btn kp-imdb-btn--retry"
                    title="Глубокий поиск медленнее, но находит больше">
                    🔍 Искать глубже (${missed.length})
                </button>`;
        }

        statusEl.innerHTML = html;

        if (missed.length) {
            setTimeout(() => {
                document.getElementById('kp-imdb-retry-btn')?.addEventListener('click', async () => {
                    setStatus(statusEl, `Глубокий поиск${dots()}`);
                    const r2     = await processItems(missed, ratedSet, watchedSet, statusEl, true, mode);
                    const allOk2 = r2.notFound === 0 && r2.failed === 0;
                    let html2 = `
                        ✅ <b>Глубокий поиск завершён!</b><br>
                        + Оценено: <b>${r2.rated}</b><br>
                        + Просмотрено: <b>${r2.watched}</b><br>
                        Пропущено (уже есть): <b>${r2.skipped}</b><br>
                        Всё ещё не найдено на IMDb: <b>${r2.notFound}</b><br>
                        Ошибок: <b>${r2.failed}</b>
                    `;
                    if (allOk2) html2 += '<br><br>🎉 Все записи импортированы!';
                    statusEl.innerHTML = html2;
                    if (r2.missed.length) {
                        downloadCSV(
                            buildCSV(r2.missed.map((m) => ({ title: m.title, year: m.year, rating: m.rating }))),
                            'imdb_missed_final.csv'
                        );
                    }
                });
            }, 50);
        }
    }

    // ====================== UI ======================

    GM_addStyle(`
        #kp-imdb-wrap {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 8px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        #kp-imdb-status {
            background: rgba(0, 0, 0, 0.93);
            color: #fff;
            padding: 12px 16px;
            border-radius: 8px;
            max-width: 420px;
            display: none;
            font-size: 13.5px;
            line-height: 1.5;
            word-break: break-word;
        }
        .kp-imdb-btn {
            padding: 12px 20px;
            font-weight: bold;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            font-size: 14px;
            transition: opacity 0.15s;
        }
        .kp-imdb-btn:disabled { opacity: 0.5; cursor: default; }
        .kp-imdb-btn--yellow  { background: #f5c518; color: #000; }
        .kp-imdb-btn--red     { background: #e60000; color: #fff; }
        .kp-imdb-btn--retry   {
            padding: 8px 14px;
            font-size: 13px;
            background: #f5c518;
            color: #000;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            font-weight: bold;
        }
        #kp-imdb-btn-group { display: flex; flex-direction: column; gap: 8px; }
    `);

    function buildUI() {
        if (document.getElementById('kp-imdb-wrap')) return;

        const wrap     = document.createElement('div');
        wrap.id        = 'kp-imdb-wrap';

        const statusEl = document.createElement('div');
        statusEl.id    = 'kp-imdb-status';
        wrap.appendChild(statusEl);

        if (SITE.isKP) {
            const btn       = document.createElement('button');
            btn.id          = 'kp-imdb-allinone-btn';
            btn.className   = 'kp-imdb-btn kp-imdb-btn--yellow';
            btn.textContent = '📥 Экспорт оценок в CSV';

            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const csv = await performKPExport(statusEl);
                    if (csv) {
                        downloadCSV(csv, 'kinopoisk_ratings.csv');
                        setStatus(statusEl, '✅ Экспорт завершён! Файл сохранён.');
                    }
                } catch (err) {
                    setStatus(statusEl, '❌ ' + (err.message || String(err)));
                } finally {
                    btn.disabled = false;
                }
            });

            wrap.appendChild(btn);

        } else if (SITE.isIMDb) {
            const fileInput       = document.createElement('input');
            fileInput.type        = 'file';
            fileInput.accept      = '.csv';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);

            let pendingMode = 'normal';

            const btnNormal       = document.createElement('button');
            btnNormal.className   = 'kp-imdb-btn kp-imdb-btn--yellow';
            btnNormal.textContent = '📥 Импортировать';

            const btnReplace      = document.createElement('button');
            btnReplace.className  = 'kp-imdb-btn kp-imdb-btn--red';
            btnReplace.textContent = '🔄 Жёсткий импорт';
            btnReplace.title      = 'Перезапишет существующие оценки и просмотры';

            const setDisabled = (v) => {
                btnNormal.disabled  = v;
                btnReplace.disabled = v;
            };

            btnNormal.addEventListener('click',  () => { pendingMode = 'normal';  fileInput.click(); });
            btnReplace.addEventListener('click', () => { pendingMode = 'replace'; fileInput.click(); });

            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                fileInput.value = '';
                setDisabled(true);
                statusEl.style.display = 'block';
                try {
                    await runImport(file, statusEl, pendingMode);
                } finally {
                    setDisabled(false);
                }
            });

            const btnGroup = document.createElement('div');
            btnGroup.id    = 'kp-imdb-btn-group';
            btnGroup.append(btnNormal, btnReplace);
            wrap.appendChild(btnGroup);
        }

        document.body.appendChild(wrap);
    }

    // ====================== INIT ======================

    function init() {
        if (!SITE.isKP && !SITE.isIMDb) return;
        buildUI();
    }

    init();
    window.addEventListener('popstate',  () => setTimeout(init, 500));
    window.addEventListener('pushstate', () => setTimeout(init, 500));

    const _origPush = history.pushState.bind(history);
    history.pushState = (...args) => { _origPush(...args); setTimeout(init, 500); };

})();
