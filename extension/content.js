(function () {
    'use strict';

    // ====================== CONSTANTS ======================

    const SITE = {
        isKP: location.hostname.includes('kinopoisk.ru'),
        isIMDb: location.hostname.includes('imdb.com'),
        isLB: location.hostname.includes('letterboxd.com'),
    };

    const DELAY = {
        KP_INIT: 100, GQL_INIT: 50,
        KP_MIN_FAST: 10, KP_MIN_SLOW: 20, KP_MAX: 3000, GQL_MAX: 3000,
        PAGE_BETWEEN: 30, HISTORY_PAGE: 300,
        F_FAST: 0.70, F_MID: 0.85, F_SLOW: 1.05, F_429: 2.00, F_ERR: 1.30,
    };

    const CONCURRENCY = { INIT: 20, MAX: 200, UP: 10, DOWN: 5, STREAK: 3 };
    const PLATFORM_MAX = { kp: 50, kpGql: 50, imdb: 200, lb: 50 };
    const RETRY = { FETCH: 4, GQL: 3, PAGES: 100 };
    const YEAR_TOL = 1;
    const KP_GQL = 'https://graphql.kinopoisk.ru/graphql/';

    // ====================== UTILITIES ======================

    const sleep = ms => new Promise(r => setTimeout(r, Math.max(ms, 1)));

    let _dots = 0;
    const dots = () => { _dots = (_dots + 1) % 3; return '.'.repeat(_dots + 1); };

    // --- Memoization Cache (LRU-style, max 500 entries) ---
    const memo = (fn, maxSize = 500) => {
        const cache = new Map();
        return (...args) => {
            const key = JSON.stringify(args);
            if (cache.has(key)) return cache.get(key);
            const val = fn(...args);
            if (cache.size >= maxSize) cache.delete(cache.keys().next().value);
            cache.set(key, val);
            return val;
        };
    };

    async function fetchT(url, timeout = 15000, opts = {}) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
            return await fetch(url, { ...opts, credentials: 'include', signal: ctrl.signal });
        } catch (e) {
            if (e.name === 'AbortError') console.warn('[mrs] Timeout:', url);
            return null;
        } finally {
            clearTimeout(t);
        }
    }

    // --- In-flight Request Deduplication ---
    const inflight = new Map();
    const dedupeFetch = (key, fn) => {
        if (inflight.has(key)) return inflight.get(key);
        const p = fn().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    };

    // --- Streaming Concurrency (asyncPool pattern) ---
    // Runs async functions with max concurrency, starts new ones as soon as any completes
    async function asyncPool(concurrency, items, worker) {
        const results = new Array(items.length);
        let index = 0;
        const executing = new Set();

        async function next() {
            while (index < items.length) {
                const i = index++;
                const promise = worker(items[i], i).then(
                    r => ({ status: 'fulfilled', value: r }),
                    e => ({ status: 'rejected', reason: e })
                );
                results[i] = promise;
                executing.add(promise);
                try {
                    await promise;
                } finally {
                    executing.delete(promise);
                }
                if (executing.size >= concurrency) {
                    await Promise.race(executing);
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
        await Promise.all(workers);
        return await Promise.all(results);
    }

    function adjDelay(d, outcome, rt = 0) {
        const { F_FAST, F_MID, F_SLOW, F_429, F_ERR, KP_MIN_FAST, KP_MIN_SLOW, KP_MAX } = DELAY;
        if (outcome === 'ok') {
            d.val = rt < 300 ? Math.max(KP_MIN_FAST, Math.floor(d.val * F_FAST))
                : rt < 1000 ? Math.max(KP_MIN_SLOW, Math.floor(d.val * F_MID))
                    : Math.min(KP_MAX, Math.floor(d.val * F_SLOW));
        } else {
            d.val = Math.min(KP_MAX, Math.floor(d.val * (outcome === '429' ? F_429 : F_ERR)));
        }
    }

    // --- Adaptive Concurrency v2: Latency-Gradient (TCP Vegas/Netflix style) ---
    // Tracks minLatency vs currentLatency ratio to detect queueing
    function makeProbe(init = CONCURRENCY.INIT, maxC = CONCURRENCY.MAX) {
        return { c: init, minLatency: Infinity, window: [], windowSize: 10, maxC };
    }

    function probeOk(p, latency) {
        p.window.push(latency);
        if (p.window.length > p.windowSize) p.window.shift();
        p.minLatency = Math.min(p.minLatency, latency);

        const avgLatency = p.window.reduce((a, b) => a + b, 0) / p.window.length;
        const gradient = p.minLatency / avgLatency;
        const max = p.maxC || CONCURRENCY.MAX;

        if (gradient > 0.95 && p.c < max) {
            p.c = Math.min(max, p.c + CONCURRENCY.UP);
        } else if (gradient < 0.85 && p.c > 1) {
            p.c = Math.max(1, p.c - CONCURRENCY.DOWN);
        }
    }

    function probeFail(p) { p.c = Math.max(1, p.c - CONCURRENCY.DOWN); }

    const kpProbe = makeProbe(20, PLATFORM_MAX.kp);
    const kpGqlProbe = makeProbe(20, PLATFORM_MAX.kpGql);
    const gqlProbe = makeProbe(20, PLATFORM_MAX.imdb);
    const lbProbe = makeProbe(20, PLATFORM_MAX.lb);
    const kpDelay = { val: DELAY.KP_INIT }, gqlDelay = { val: DELAY.GQL_INIT }, lbDelay = { val: 50 };

    const setStatus = (el, text) => { if (!el) return; el.style.display = 'block'; el.textContent = text; };

    // ====================== CSV ======================

    const csvEsc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;

    function buildCSV(rows) {
        const first = rows[0] || {};
        const ext = first === rows[0] && (first.src || first.kpId !== undefined || first.ttId !== undefined || first.lbSlug !== undefined || first.titleRu !== undefined || first.titleOrig !== undefined);

        if (ext) {
            const hasDates = rows.some(r => r.watchedDate);
            const hdr = hasDates
                ? 'TitleRu,TitleOrig,Type,KpId,TtId,LbSlug,YearStart,YearEnd,Rating10,Genres,WatchedDate'
                : 'TitleRu,TitleOrig,Type,KpId,TtId,LbSlug,YearStart,YearEnd,Rating10,Genres';
            const lines = [hdr, ...rows.map(r => {
                const ratingVal = r.rating == null ? '' : r.rating;
                const base = [
                    csvEsc(r.titleRu ?? ''),
                    csvEsc(r.titleOrig ?? r.title ?? ''),
                    r.type ?? '',
                    r.kpId ?? '',
                    r.ttId ?? '',
                    r.lbSlug ?? '',
                    r.year ?? r.yearStart ?? '',
                    r.yearEnd ?? '',
                    ratingVal,
                    csvEsc(r.genres ?? ''),
                ].join(',');
                return hasDates ? `${base},${r.watchedDate ?? ''}` : base;
            })];
            return lines.join('\n');
        }

        const hasDates = rows.some(r => r.watchedDate);
        const hdr = hasDates ? 'Title,Year,Rating10,WatchedDate' : 'Title,Year,Rating10';
        const lines = [hdr, ...rows.map(r =>
            hasDates
                ? `${csvEsc(r.title)},${r.year ?? ''},${r.rating ?? ''},${r.watchedDate ?? ''}`
                : `${csvEsc(r.title)},${r.year ?? ''},${r.rating ?? ''}`
        )];
        return lines.join('\n');
    }

    function downloadCSV(csv, name) {
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })),
            download: name,
        });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    function splitCsvLine(line) {
        const cells = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                cells.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        cells.push(current);
        return cells;
    }

    function parseCSVExtended(lines) {
        const header = splitCsvLine(lines[0]).map(h => h.toLowerCase().trim());
        const result = [];
        const skipped = [];
        for (let i = 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (!l) continue;
            const cells = splitCsvLine(l);
            if (cells.length < Math.min(3, header.length)) { skipped.push(l); continue; }
            const row = {};
            header.forEach((h, idx) => row[h] = cells[idx] ?? '');
            const unq = s => (s || '').replace(/""/g, '"');
            const titleRu = unq(row.titleru);
            const titleOrig = unq(row.titleorig);
            const cleanRu = cleanTitle(titleRu);
            const cleanOrig = cleanTitle(titleOrig);
            const rawRating = (row.rating10 === 'w' || row.rating10 === '') ? null : +row.rating10;
            result.push({
                titleRu: cleanRu || titleRu,
                titleOrig: cleanOrig || titleOrig,
                title: cleanOrig || cleanRu || titleOrig || titleRu,
                type: (row.type || '').trim(),
                kpId: (row.kpid || '').trim(),
                ttId: (row.ttid || '').trim(),
                lbSlug: (row.lbslug || '').trim(),
                year: (row.yearstart || row.year || '').trim(),
                yearStart: (row.yearstart || row.year || '').trim(),
                yearEnd: (row.yearend || '').trim(),
                rating: Number.isNaN(rawRating) ? null : rawRating,
                genres: unq(row.genres),
                watchedDate: (row.watcheddate || '').trim(),
                src: (row.src || '').trim(),
            });
        }
        if (skipped.length) console.warn(`[mrs] CSV: ${skipped.length} строк не распознано:`, skipped.slice(0, 10));
        return result;
    }

    function parseCSV(text) {
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) return [];
        const hdrLine = lines[0].toLowerCase();

        if (/titleru|kpid|titleorig|ttid|lbslug/.test(hdrLine)) {
            return parseCSVExtended(lines);
        }

        const hasDates = hdrLine.includes('watcheddate');
        const RE_DATE = /^"((?:[^"]|"")*)",\s*(\d{4})?\s*,\s*(\d*|w)\s*,\s*"?(\d{4}-\d{2}-\d{2})?"?\s*$/;
        const RE_PLAIN = /^"((?:[^"]|"")*)",\s*(\d{4})?\s*,\s*(\d*|w)\s*$/;

        const skipped = [];
        const result = lines.slice(1).flatMap(line => {
            const l = line.trim();
            if (!l) return [];
            const m = hasDates ? l.match(RE_DATE) : l.match(RE_PLAIN);
            if (!m) { skipped.push(l); return []; }
            const title = cleanTitle(m[1].replace(/""/g, '"').trim());
            const rawRating = (m[3] === 'w' || m[3] === '') ? null : +m[3];
            return [{ title, year: m[2] ?? '', rating: rawRating, ...(hasDates && { watchedDate: m[4] ?? '' }) }];
        });
        if (skipped.length) console.warn(`[mrs] CSV: ${skipped.length} строк не распознано:`, skipped.slice(0, 10));
        return result;
    }

    // ====================== TITLE HELPERS ======================

    const CYR = {
        'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo', 'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    };

    const hasCyr = memo(s => /[а-яА-ЯёЁ]/.test(s));
    const translit = memo(s => s.split('').map(c => CYR[c] ?? c).join(''));
    const normTitle = memo(s => s.toLowerCase().replace(/[\-–—.,!?'"«»()\[\]\\\/]/g, ' ').replace(/\s+/g, ' ').trim());
    const cleanTitle = memo(t => {
        const m = t.match(/\((.+?),\s*\d{4}(?:-\d{4})?\)$/);
        return m ? m[1].trim() : t.replace(/,\s*\d{4}(?:-\d{4})?\s*$/, '').replace(/[«»]/g, '').trim();
    });
    const yearsMatch = memo((a, b) => {
        const ya = parseInt(String(a).match(/^(\d{4})/)?.[1], 10), yb = parseInt(b, 10);
        return !isNaN(ya) && !isNaN(yb) && Math.abs(ya - yb) <= YEAR_TOL;
    });

    // ====================== KP MODULE ======================

    function getKPUserId() {
        const m = location.href.match(/\/user\/(\d+)/);
        if (m) return m[1];
        try {
            const d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? 'null');
            const pp = d?.props?.pageProps;
            return String(pp?.user?.id ?? pp?.userData?.id ?? pp?.requestContext?.user?.id ?? pp?.currentUser?.id ?? '') || null;
        } catch { return null; }
    }

    function parseKPSSRJson(doc) {
        const scripts = doc.querySelectorAll('script[data-tid]');
        let ssrText = null;
        for (const s of scripts) {
            const txt = s.textContent || '';
            if (txt.includes('window.Ya.__ssr_initial_data')) { ssrText = txt; break; }
        }
        if (!ssrText) return null;
        const prefix = 'window.Ya.__ssr_initial_data = ';
        const startIdx = ssrText.indexOf(prefix);
        if (startIdx === -1) return null;
        const jsonStart = startIdx + prefix.length;
        const scriptEndIdx = ssrText.indexOf('</script>', jsonStart);
        const boundary = scriptEndIdx === -1 ? ssrText.length : scriptEndIdx;
        let jsonText = ssrText.substring(jsonStart, boundary).trim();
        while (jsonText && /[\s;]/.test(jsonText.slice(-1))) jsonText = jsonText.slice(0, -1);
        try { return JSON.parse(jsonText); } catch (e1) {
            const positions = [];
            let depth = 0, inStr = false;
            for (let i = jsonStart; i < jsonStart + jsonText.length; i++) {
                const ch = ssrText[i];
                if (ch === '\\' && inStr) { i++; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) positions.push(i + 1); }
            }
            for (const pos of positions.reverse()) {
                try { return JSON.parse(ssrText.substring(jsonStart, pos)); } catch (_) { continue; }
            }
            console.warn('[mrs] KP SSR parse failed with both methods:', e1.message);
            return null;
        }
    }

    function extractMoviesFromSSR(ssr) {
        const state = ssr?.apolloState;
        if (!state) return null;
        const findReactions = (obj, depth = 0) => {
            if (!obj || typeof obj !== 'object' || depth > 4) return null;
            if (Array.isArray(obj)) return null;
            for (const key of Object.keys(obj)) {
                if (key.includes('movieReactions') && obj[key]?.items?.length) {
                    return obj[key];
                }
            }
            if (depth < 4) {
                for (const key of Object.keys(obj)) {
                    const val = obj[key];
                    if (val && typeof val === 'object' && !Array.isArray(val)) {
                        const found = findReactions(val, depth + 1);
                        if (found) return found;
                    }
                }
            }
            return null;
        };
        const reactionsObj = findReactions(state);
        if (!reactionsObj) return null;
        const items = reactionsObj.items || [];
        const results = [];
        for (const item of items) {
            if (item?.__typename !== 'UserMovieReactions') continue;
            const movieRef = item.movie?.__ref;
            if (!movieRef) continue;
            const movie = state[movieRef];
            if (!movie || !movie.id) continue;
            const type = movie.__typename || 'Film';
            const isSeries = type !== 'Film';
            let yearStart = '', yearEnd = '';
            if (isSeries && movie.releaseYears?.[0]) {
                yearStart = String(movie.releaseYears[0].start ?? '');
                yearEnd = String(movie.releaseYears[0].end ?? '');
            } else if (movie.productionYear) {
                yearStart = String(movie.productionYear);
            }
            let rating = null, watched = false;
            const reactionsEntry = Object.entries(item).find(([k]) => k.startsWith('reactions'));
            const reactions = reactionsEntry ? reactionsEntry[1] : [];
            for (const r of reactions) {
                if (!r) continue;
                const rObj = r.__ref ? state[r.__ref] : r;
                if (!rObj) continue;
                if (rObj.__typename === 'Vote' && rObj.value != null) rating = rObj.value;
                else if (rObj.__typename === 'Watched') watched = true;
            }
            let genres = '';
            if (movie.genres?.length) {
                genres = movie.genres.map(g => {
                    if (!g) return null;
                    const gObj = g.__ref ? state[g.__ref] : g;
                    return gObj?.name || null;
                }).filter(Boolean).join(', ');
            }
            results.push({
                titleRu: movie.title?.russian || '',
                titleOrig: movie.title?.original || '',
                type: isSeries ? 'TvSeries' : 'Film',
                kpId: String(movie.id),
                yearStart, yearEnd,
                rating, watched,
                genres,
            });
        }
        return results;
    }

    function parseKPListingPage(doc) {
        const ssr = parseKPSSRJson(doc);
        if (ssr) {
            const movies = extractMoviesFromSSR(ssr);
            if (movies && movies.length > 0) return movies;
        }

        const results = [], seen = new Set();
        for (const item of doc.querySelectorAll('[class*="styles_item"]')) {
            const link = item.querySelector('a[href*="/film/"], a[href*="/series/"]');
            if (!link) continue;
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/(film|series)\/(\d+)/);
            if (!match || seen.has(match[2])) continue;
            seen.add(match[2]);
            const titleEl = item.querySelector('[class*="styles_title"] span');
            const subtitleEl = item.querySelector('[class*="styles_subtitle"]');
            const ratingEl = item.querySelector('[class*="styles_value"]');
            const titleRu = titleEl?.textContent?.trim()
                || link.querySelector('img')?.alt?.split('.')[0]?.trim() || '';
            const subtitle = subtitleEl?.textContent?.trim() || '';
            const year = subtitle.match(/\b(19|20)\d{2}\b/)?.[0] || '';
            const ratingText = ratingEl?.textContent?.trim() || '';
            const rating = /^\d+$/.test(ratingText) ? +ratingText : null;
            results.push({
                titleRu, titleOrig: '',
                type: match[1] === 'series' ? 'TvSeries' : 'Film',
                kpId: match[2],
                yearStart: year, yearEnd: '',
                rating, watched: rating == null,
                genres: '',
            });
        }
        return results;
    }

    async function fetchDocTimed(url) {
        const t0 = Date.now();
        const resp = await fetchT(url, 15000);
        const time = Date.now() - t0;
        if (!resp?.ok) return { doc: null, time };
        const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
        return { doc, time };
    }

    async function performKPExport(statusEl) {
        const uid = getKPUserId();
        if (!uid) throw new Error('user ID не найден — откройте страницу профиля КП');

        const baseUrl = `https://www.kinopoisk.ru/user/${uid}/movies/voted-watched`;
        let allItems = [], totalPages = 0, ssrHits = 0, consecutiveEmpty = 0;
        const stats = { pages: 0, ssr: 0, fallback: 0, retries: 0, maxConsecutiveEmpty: 0 };

        for (let p = 1; p <= 2000; p++) {
            setStatus(statusEl, `Загрузка стр. ${p}${totalPages ? '/' + totalPages : ''} (${allItems.length} фильмов)${dots()}`);

            let items = [];
            let usedFallback = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const { doc } = await fetchDocTimed(`${baseUrl}/?page=${p}`);
                if (!doc) break;
                if (p === 1 && !totalPages) {
                    for (const a of doc.querySelectorAll('a[href*="?page="], a[href*="&page="]')) {
                        const m = a.href.match(/[?&]page=(\d+)/);
                        if (m) totalPages = Math.max(totalPages, +m[1]);
                    }
                }
                items = parseKPListingPage(doc);
                if (items.length > 0) break;
                if (attempt < 3) {
                    stats.retries++;
                    await sleep(800 * attempt);
                }
            }

            if (items.length === 0) {
                consecutiveEmpty++;
                stats.maxConsecutiveEmpty = Math.max(stats.maxConsecutiveEmpty, consecutiveEmpty);
                if (p === 1) throw new Error('Не удалось распарсить листинг КП — SSR JSON и HTML fallback не сработали');
                if (consecutiveEmpty >= 3) break;
                continue;
            }
            consecutiveEmpty = 0;
            stats.pages++;
            if (items[0].titleOrig !== undefined && items[0].genres !== undefined) { ssrHits++; stats.ssr++; }
            else stats.fallback++;
            allItems = allItems.concat(items);
            if (totalPages && p >= totalPages) break;
            await sleep(DELAY.PAGE_BETWEEN);
        }

        if (allItems.length === 0) throw new Error('Не удалось загрузить листинг КП');

        const unique = [...new Map(allItems.map(i => [i.kpId, i])).values()];
        console.log(`[mrs] KP export: ${unique.length} фильмов, страниц: ${totalPages || '?'}, SSR: ${stats.ssr}, fallback: ${stats.fallback}, retries: ${stats.retries}, maxConsecutiveEmpty: ${stats.maxConsecutiveEmpty}`);
        return buildCSV(unique.map(i => ({
            titleRu: i.titleRu || '',
            titleOrig: i.titleOrig || '',
            type: i.type || '',
            kpId: i.kpId || '',
            ttId: '',
            lbSlug: '',
            yearStart: i.yearStart || i.year || '',
            yearEnd: i.yearEnd || '',
            rating: i.rating == null ? (i.watched ? 'w' : '') : i.rating,
            genres: i.genres || '',
            src: 'kp',
        })));
    }

    // ----- KP GQL -----

    const KP_SUGGEST_QUERY = `query SuggestSearch($keyword: String!, $yandexCityId: Int, $limit: Int, $withUserData: Boolean!) { suggest(keyword: $keyword) { top(yandexCityId: $yandexCityId, limit: $limit) { topResult { global { ...SuggestMovieItem ...SuggestPersonItem ...SuggestCinemaItem ...SuggestMovieListItem __typename } __typename } movies { movie { ...SuggestMovieItem __typename } __typename } persons { person { ...SuggestPersonItem __typename } __typename } cinemas { cinema { ...SuggestCinemaItem __typename } __typename } movieLists { movieList { ...SuggestMovieListItem __typename } __typename } __typename } __typename } } fragment ShortImage on Image { avatarsUrl fallbackUrl __typename } fragment MovieHdVerticalPoster on Movie { gallery { posters { hdVertical: vertical(override: OTT_WHEN_EXISTS) { ...ShortImage __typename } __typename } __typename } __typename } fragment MovieKpVerticalPoster on Movie { gallery { posters { kpVertical: vertical { ...ShortImage __typename } __typename } __typename } __typename } fragment TicketOption on Movie { ticketOption { purchasable releaseAnnounce { available releaseDate { accuracy date __typename } __typename } __typename } __typename } fragment SuggestMovieItem on Movie { id contentId title { russian original __typename } rating { kinopoisk { isActive value __typename } __typename } ...MovieHdVerticalPoster ...MovieKpVerticalPoster viewOption { buttonText isAvailableOnline: isWatchable(filter: {anyDevice: false, anyRegion: false}) purchasabilityStatus contentPackageToBuy { billingFeatureName __typename } subscriptionBadge { image { avatarsUrl __typename } __typename } type availabilityAnnounce { groupPeriodType announcePromise availabilityDate type __typename } __typename } ...TicketOption userData @include(if: $withUserData) { isPlannedToWatch __typename } ... on Film { productionYear __typename } ... on TvSeries { releaseYears { end start __typename } __typename } ... on TvShow { releaseYears { end start __typename } __typename } ... on MiniSeries { releaseYears { end start __typename } __typename } __typename } fragment SuggestPersonItem on Person { id name originalName birthDate poster { avatarsUrl fallbackUrl __typename } __typename } fragment SuggestCinemaItem on Cinema { id ctitle: title city { id name geoId __typename } __typename } fragment SuggestMovieListItem on MovieListMeta { id cover { avatarsUrl __typename } coverBackground { avatarsUrl __typename } name url description movies(limit: 0) { total __typename } __typename }`;
    const KP_VOTE_MUT = `mutation MovieSetVote($movieId: Long!, $rate: Int!) {\n  movie {\n    vote {\n      set(input: {movieId: $movieId, rate: $rate}) {\n        error {\n          message\n          __typename\n        }\n        status\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n`;
    const KP_WATCH_MUT = `mutation MovieSetWatched($movieId: Long!) {\n  movie {\n    watched {\n      set(input: {movieId: $movieId}) {\n        error {\n          message\n          __typename\n        }\n        status\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n`;

    async function kpGql(query, variables, op) {
        const url = op ? `${KP_GQL}?operationName=${encodeURIComponent(op)}` : KP_GQL;
        const genId = () => `${Date.now()}-${Math.random().toString().slice(2)}:${Math.floor(Math.random() * 100)}`;
        const genSearchId = () => `${Date.now()}${Math.floor(Math.random() * 1000000000)}`;
        const genTraceId = () => {
            const hex = () => Math.random().toString(16).slice(2, 18);
            return `00-${hex()}${hex()}-${hex()}-01`;
        };
        for (let i = 1; i <= RETRY.GQL; i++) {
            try {
                const bodyStr = JSON.stringify({ operationName: op, variables, query });
                const r = await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', url, true);
                    xhr.withCredentials = true;
                    xhr.setRequestHeader('content-type', 'application/json');
                    xhr.setRequestHeader('Accept', '*/*');
                    xhr.setRequestHeader('Accept-Language', 'ru,en;q=0.9');
                    xhr.setRequestHeader('x-kp-testids', '414549,436857,436979,1615440');
                    xhr.setRequestHeader('x-search-request-id', genSearchId());
                    xhr.setRequestHeader('service-id', '25');
                    xhr.setRequestHeader('source-id', '1');
                    xhr.setRequestHeader('x-preferred-language', 'ru');
                    xhr.setRequestHeader('x-request-id', genId());
                    xhr.setRequestHeader('traceparent', genTraceId());
                    xhr.timeout = 10000;
                    xhr.onload = () => resolve(xhr);
                    xhr.onerror = () => reject(new Error('XHR failed'));
                    xhr.ontimeout = () => reject(new Error('XHR timeout'));
                    xhr.send(bodyStr);
                });
                const status = r.status;
                const text = r.responseText || '';
                if (status === 429) { adjDelay(gqlDelay, '429'); await sleep(gqlDelay.val * 1.5); continue; }
                if (!text) { adjDelay(gqlDelay, 'error'); continue; }
                let json;
                try { json = JSON.parse(text); } catch { 
                    console.warn(`[mrs] KP GQL non-JSON response (${status}):`, text.slice(0, 300));
                    adjDelay(gqlDelay, 'error');
                    continue;
                }
                if (json?.errors && !json?.data) {
                    console.warn(`[mrs] KP GQL errors (${status}):`, JSON.stringify(json.errors).slice(0, 500));
                    adjDelay(gqlDelay, 'error');
                    if (status >= 400 && status < 500) throw new Error(`GQL ${status}`);
                    continue;
                }
                adjDelay(gqlDelay, 'ok', 200);
                return json;
            } catch (e) {
                console.warn(`[mrs] KP GQL exception (attempt ${i}/${RETRY.GQL}):`, e.message);
                adjDelay(gqlDelay, 'error');
                if (i === RETRY.GQL) throw e;
            }
            if (i < RETRY.GQL) await sleep(gqlDelay.val * 1.6);
        }
        return null;
    }

    function matchMovie(movie, nKey, year) {
        if (!movie?.id) return null;
        const mYear = movie.productionYear ?? movie.releaseYears?.start ?? movie.releaseYears?.end;
        const nRu = normTitle(movie.title?.russian ?? '');
        const nOrig = normTitle(movie.title?.original ?? '');
        const nTr = hasCyr(movie.title?.russian ?? '') ? normTitle(translit(movie.title.russian)) : '';
        const hit = [nRu, nOrig, nTr].some(n => n === nKey || n.includes(nKey) || nKey.includes(n));
        if (!hit) return null;
        return (!year || yearsMatch(mYear, year)) ? movie : null;
    }

    async function searchKPId(title, year) {
        const cacheKey = `kp:${normTitle(title)}|${year || ''}`;
        return dedupeFetch(cacheKey, async () => {
            const nKey = normTitle(title);
            const vars = { keyword: title, yandexCityId: 6, limit: 20, withUserData: true };

            for (let pass = 0; pass < 2; pass++) {
                const json = await kpGql(KP_SUGGEST_QUERY, vars, 'SuggestSearch');
                if (json?.errors) console.warn('[mrs] KP search errors:', JSON.stringify(json.errors).slice(0, 500));
                const top = json?.data?.suggest?.top;
                if (!top) continue;

                const candidates = [];
                const tr = top.topResult?.global;
                if (tr && !tr.__typename?.includes('Person')) candidates.push(tr);
                for (const e of top.movies ?? []) candidates.push(e?.movie);

                for (const m of candidates) {
                    const hit = pass === 0 ? matchMovie(m, nKey, year) : (m?.id ? m : null);
                    if (!hit) continue;
                    if (pass === 1) {
                        const nR = normTitle(m.title?.russian ?? ''), nO = normTitle(m.title?.original ?? '');
                        const nT = hasCyr(m.title?.russian ?? '') ? normTitle(translit(m.title.russian)) : '';
                        if (![nR, nO, nT].includes(nKey)) continue;
                    }
                    console.log(`[mrs] KP search OK: "${title}" (${year}) → kpId=${hit.id}`);
                    return { kpId: String(hit.id), existingRating: null };
                }
            }
            console.warn(`[mrs] KP search FAILED: "${title}" (${year}) — кандидаты не найдены`);

            // HTML fallback (regex-based, no DOMParser)
            try {
                const r = await fetchT(`https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(title)}`);
                if (r?.ok) {
                    const html = await r.text();
                    for (const match of html.matchAll(/<a[^>]+href="\/(?:film|series)\/(\d+)"[^>]*>([^<]+)</g)) {
                        const [, id, text] = match;
                        if (normTitle(text.trim()).includes(nKey)) return { kpId: id, existingRating: null };
                    }
                }
            } catch { }
            return null;
        });
    }

    async function applyKP(kpId, rating) {
        const hasR = rating != null && String(rating) !== '' && +rating >= 1 && +rating <= 10;
        const op = hasR ? 'MovieSetVote' : 'MovieSetWatched';
        const vars = hasR ? { movieId: +kpId, rate: +rating } : { movieId: +kpId };
        const json = await kpGql(hasR ? KP_VOTE_MUT : KP_WATCH_MUT, vars, op);
        if (!json) {
            console.warn(`[mrs] KP apply FAILED (null response): kpId=${kpId} rating=${rating}`);
            return null;
        }
        if (json.errors) {
            console.warn(`[mrs] KP apply ERRORS: kpId=${kpId} rating=${rating}`, JSON.stringify(json.errors).slice(0, 500));
        }
        const r = hasR ? json?.data?.movie?.vote?.set : json?.data?.movie?.watched?.set;
        if (r?.error) {
            console.warn(`[mrs] KP apply GQL ERROR: kpId=${kpId} rating=${rating} msg=${r.error.message}`, JSON.stringify(r).slice(0, 300));
        }
        const ok = r && !r.error;
        if (ok) console.log(`[mrs] KP apply OK: kpId=${kpId} rating=${rating} → ${hasR ? 'rated' : 'watched'}`);
        return ok ? (hasR ? 'rated' : 'watched') : null;
    }

    async function kpFetchRatings(statusEl) {
        const uid = getKPUserId();
        if (!uid) {
            setStatus(statusEl, '⚠️ Не удалось определить user ID — существующие оценки не будут пропущены');
            return new Map();
        }
        const baseUrl = `https://www.kinopoisk.ru/user/${uid}/movies/voted-watched`;
        const map = new Map();
        let totalPages = 0;
        for (let p = 1; p <= 2000; p++) {
            setStatus(statusEl, `Загрузка существующих оценок: стр. ${p}${totalPages ? '/' + totalPages : ''} (${map.size} фильмов)${dots()}`);
            const { doc } = await fetchDocTimed(`${baseUrl}/?page=${p}`);
            if (!doc) break;
            if (p === 1 && !totalPages) {
                for (const a of doc.querySelectorAll('a[href*="?page="], a[href*="&page="]')) {
                    const m = a.href.match(/[?&]page=(\d+)/);
                    if (m) totalPages = Math.max(totalPages, +m[1]);
                }
            }
            const items = parseKPListingPage(doc);
            if (!items.length) break;
            for (const item of items) {
                if (!item.kpId || map.has(item.kpId)) continue;
                map.set(item.kpId, item.rating != null ? item.rating : 'watched');
            }
            if (totalPages && p >= totalPages) break;
            await sleep(DELAY.PAGE_BETWEEN);
        }
        return map;
    }

    async function runKPImportBatch(items, statusEl, mode) {
        Object.assign(kpGqlProbe, makeProbe(20, PLATFORM_MAX.kpGql));
        gqlDelay.val = DELAY.GQL_INIT;
        setStatus(statusEl, `Загружено ${items.length} записей. ${mode === 'normal' ? 'Проверяем существующие оценки...' : 'Начинаем импорт...'}${dots()}`);
        const existing = mode === 'normal' ? await kpFetchRatings(statusEl) : new Map();
        let rated = 0, watched = 0, skipped = 0, notFound = 0, failed = 0;
        const missed = [];
        let cur = 0;

        while (cur < items.length) {
            const slice = items.slice(cur, cur + kpGqlProbe.c);
            setStatus(statusEl, `Импорт на КП ${cur + 1}–${Math.min(cur + kpGqlProbe.c, items.length)}/${items.length}${dots()}`);
            const res = await asyncPool(kpGqlProbe.c, slice, async item => {
                const kpId = (item.kpId && /^\d+$/.test(item.kpId)) ? item.kpId : (await searchKPId(item.title, item.year))?.kpId;
                if (!kpId) return 'notfound';
                const ex = existing.get(kpId);
                const hasR = item.rating != null && +item.rating >= 1 && +item.rating <= 10;
                if (mode === 'normal' && ex != null && (ex !== 'watched' || !hasR)) return 'skipped';
                return await applyKP(kpId, item.rating) ?? 'failed';
            });
            const t0 = Date.now();
            let fail = false;
            res.forEach((r, j) => {
                const s = r.status === 'fulfilled' ? r.value : 'failed';
                if (s === 'rated') rated++;
                else if (s === 'watched') watched++;
                else if (s === 'skipped') skipped++;
                else if (s === 'notfound') { notFound++; missed.push(slice[j]); }
                else { failed++; missed.push(slice[j]); fail = true; }
            });
            cur += kpGqlProbe.c;
            const elapsed = Date.now() - t0;
            fail ? probeFail(kpGqlProbe) : probeOk(kpGqlProbe, elapsed);
            if (cur < items.length) await sleep(gqlDelay.val);
        }
        return { rated, watched, skipped, notFound, failed, missed };
    }

    async function performKPImport(csvData, statusEl, mode) {
        const items = parseCSV(csvData);
        if (!items.length) return setStatus(statusEl, '❌ CSV пуст или не распознан');
        const t0 = Date.now();
        const result = await runKPImportBatch(items, statusEl, mode);
        const elapsed = Math.round((Date.now() - t0) / 1000);
        const lbl = mode === 'replace' ? ' (режим замены)' : '';
        if (result.missed.length) downloadCSV(buildCSV(result.missed), 'kp_missed.csv');
        statusEl.textContent = '';
        statusEl.insertAdjacentHTML('beforeend', `✅ <b>Готово${lbl} (${elapsed} сек)!</b><br>Оценено: <b>${result.rated}</b><br>Отмечено: <b>${result.watched}</b><br>Пропущено: <b>${result.skipped}</b><br>Не найдено: <b>${result.notFound}</b><br>Ошибок: <b>${result.failed}</b>${result.notFound === 0 && result.failed === 0 ? '<br><br>🎉 Все записи импортированы!' : ''}`);
    }

    // ====================== IMDb MODULE ======================

    let titleMap = new Map(), imdbHistory = null;
    const resetTitleMap = () => { titleMap = new Map(); };

    function registerTitle(id, title, orig, year) {
        const add = raw => {
            if (!raw) return;
            for (const k of [raw.toLowerCase().trim(), normTitle(raw), ...(hasCyr(raw) ? [translit(raw).toLowerCase(), normTitle(translit(raw))] : [])]) {
                if (k.length > 1) titleMap.set(k, { ttId: id, year });
            }
        };
        add(title); if (orig && orig !== title) add(orig);
    }

    function lookupTitle(title, year) {
        const nKey = normTitle(title);
        const keys = [title.toLowerCase().trim(), nKey, hasCyr(title) ? translit(title).toLowerCase() : null].filter(Boolean);
        for (const k of keys) {
            const e = titleMap.get(k);
            if (e?.ttId && yearsMatch(e.year, year)) return e.ttId;
        }
        for (const [k, v] of titleMap) {
            if (yearsMatch(v.year, year) && (normTitle(k) === nKey || normTitle(k).includes(nKey) || nKey.includes(normTitle(k)))) return v.ttId;
        }
        return null;
    }

    function parseEdges(edges, set) {
        for (const e of edges) {
            const n = e?.node?.title ?? e?.node;
            if (!n?.id?.startsWith('tt')) continue;
            set?.add(n.id);
            registerTitle(n.id, n?.titleText?.text, n?.originalTitleText?.text, n?.releaseYear?.year);
        }
    }

    function getIMDbUid() {
        try {
            const d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? 'null');
            const uid = d?.props?.pageProps?.requestContext?.sidecar?.account?.userId;
            if (uid) return uid;
        } catch { }
        return location.href.match(/\/user\/(ur\d+)/i)?.[1] ?? null;
    }

    async function fetchNextData(url) {
        try {
            const r = await fetchT(url);
            if (!r?.ok) return null;
            const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            return m ? JSON.parse(m[1]) : null;
        } catch { return null; }
    }

    async function scanIMDb(uid, urlFn, label, statusEl, set) {
        for (let p = 1; p <= RETRY.PAGES; p++) {
            setStatus(statusEl, `${label} стр. ${p}${dots()}`);
            const nd = await fetchNextData(urlFn(uid, p));
            if (!nd) break;
            const search = nd?.props?.pageProps?.mainColumnData?.advancedTitleSearch;
            const edges = search?.edges ?? [];
            if (!edges.length) break;
            parseEdges(edges, set);
            if (!search?.pageInfo?.hasNextPage) break;
            await sleep(DELAY.HISTORY_PAGE);
        }
    }

    async function getIMDbHistory(statusEl) {
        if (imdbHistory) return imdbHistory;
        setStatus(statusEl, `Определяем профиль IMDb${dots()}`);
        const uid = getIMDbUid();
        if (!uid) {
            setStatus(statusEl, '❌ IMDb user ID не найден — войдите в аккаунт');
            return imdbHistory = { rated: new Set(), watched: new Set() };
        }
        const rated = new Set(), watched = new Set();
        await scanIMDb(uid, (u, p) => `https://www.imdb.com/user/${u}/ratings/?page=${p}`, 'Оценки', statusEl, rated);
        await scanIMDb(uid, (u, p) => `https://www.imdb.com/user/${u}/watchhistory/?my_ratings=exclude&page=${p}`, 'Просмотры', statusEl, watched);
        return imdbHistory = { rated, watched };
    }

    const IMDB_GQL = 'https://api.graphql.imdb.com/';
    const GQL_RATE = `mutation RateTitle($titleId:ID!,$rating:Int!){rateTitle(input:{titleId:$titleId,rating:$rating}){rating{value}}}`;
    const GQL_WATCH = `mutation AddWatched($titleId:ID!){addWatchedTitle(titleId:$titleId){success}}`;

    async function imdbGql(query, variables) {
        for (let i = 1; i <= RETRY.GQL; i++) {
            try {
                const r = await fetchT(IMDB_GQL, 10000, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, variables }),
                });
                if (!r) { adjDelay(gqlDelay, 'error'); continue; }
                if (r.status === 429) { adjDelay(gqlDelay, '429'); await sleep(gqlDelay.val * 1.5); continue; }
                const json = await r.json().catch(() => ({}));
                adjDelay(gqlDelay, json?.errors ? '429' : 'ok', 200);
                return json;
            } catch { adjDelay(gqlDelay, 'error'); }
            if (i < RETRY.GQL) await sleep(gqlDelay.val * 1.6);
        }
        return null;
    }

    async function applyIMDb(ttId, rating, rated, watched) {
        const hasR = rating != null && String(rating) !== '' && +rating >= 1 && +rating <= 10;
        if (hasR) {
            const j = await imdbGql(GQL_RATE, { titleId: ttId, rating: +rating });
            if (j?.data?.rateTitle?.rating?.value) { rated.add(ttId); watched.add(ttId); return 'rated'; }
        } else {
            const j = await imdbGql(GQL_WATCH, { titleId: ttId });
            if (j?.data?.addWatchedTitle?.success) { watched.add(ttId); return 'watched'; }
        }
        return null;
    }

    async function searchIMDbFallback(title, year) {
        const cacheKey = `imdb:${normTitle(title)}|${year || ''}`;
        return dedupeFetch(cacheKey, async () => {
            const qs = [title, ...(hasCyr(title) ? [translit(title)] : [])];
            for (const q of qs) {
                for (const ttype of ['ft', 'tv']) {
                    const r = await fetchT(`https://www.imdb.com/find/?q=${encodeURIComponent(q)}&s=tt&ttype=${ttype}`);
                    if (!r?.ok) continue;
                    const html = await r.text();
                    const ids = [...new Set([...html.matchAll(/\/title\/(tt\d+)/g)].map(m => m[1]))];
                    if (!ids.length) continue;
                    if (year) {
                        for (const id of ids) {
                            const idx = html.indexOf(id);
                            if (html.substring(Math.max(0, idx - 200), idx + 200).includes(String(year))) return id;
                        }
                    }
                    return ids[0];
                }
            }
            return null;
        });
    }

    const resolveIMDb = (title, year, deep) => lookupTitle(title, year) ?? (deep ? searchIMDbFallback(title, year) : null);

    async function imdbApplyPhase(resolved, rated, watched, statusEl, mode, total) {
        Object.assign(gqlProbe, makeProbe());
        gqlDelay.val = DELAY.GQL_INIT;
        let r = 0, w = 0, sk = 0, nf = 0, fa = 0;
        const missed = [];
        const toApply = [];

        for (const { item, ttId } of resolved) {
            if (!ttId) { nf++; missed.push(item); continue; }
            const hasR = item.rating != null && String(item.rating) !== '' && +item.rating >= 1 && +item.rating <= 10;
            if (mode !== 'replace' && (rated.has(ttId) || (watched.has(ttId) && !hasR))) { sk++; continue; }
            toApply.push({ item, ttId });
        }

        let cur = 0;
        while (cur < toApply.length) {
            const slice = toApply.slice(cur, cur + gqlProbe.c);
            setStatus(statusEl, `Импорт ${cur + 1}–${Math.min(cur + gqlProbe.c, toApply.length)}/${total}${dots()}`);
            const t0 = Date.now();
            const res = await asyncPool(gqlProbe.c, slice, ({ item, ttId }) => applyIMDb(ttId, item.rating, rated, watched));
            let fail = false;
            res.forEach((x, j) => {
                const s = x.status === 'fulfilled' ? x.value : null;
                if (s === 'rated') r++;
                else if (s === 'watched') w++;
                else { fa++; missed.push(slice[j].item); fail = true; }
            });
            cur += gqlProbe.c;
            const elapsed = Date.now() - t0;
            fail ? probeFail(gqlProbe) : probeOk(gqlProbe, elapsed);
            if (cur < toApply.length) await sleep(gqlDelay.val);
        }
        return { rated: r, watched: w, skipped: sk, notFound: nf, failed: fa, missed };
    }

    async function imdbProcess(items, rated, watched, statusEl, deep, mode) {
        Object.assign(kpProbe, makeProbe());
        const resolved = [];
        let cur = 0;
        while (cur < items.length) {
            const slice = items.slice(cur, cur + kpProbe.c);
            setStatus(statusEl, `Поиск ${cur + 1}–${Math.min(cur + kpProbe.c, items.length)}/${items.length}${dots()}`);
            const t0 = Date.now();
            const res = await asyncPool(kpProbe.c, slice, i =>
                i.ttId && /^tt\d+$/.test(i.ttId) ? Promise.resolve(i.ttId) : resolveIMDb(i.title, i.year, deep)
            );
            let fail = false;
            res.forEach((r, j) => {
                const ttId = r.status === 'fulfilled' ? r.value : null;
                resolved.push({ item: slice[j], ttId });
                if (!ttId && deep) fail = true;
            });
            cur += kpProbe.c;
            const elapsed = Date.now() - t0;
            fail ? probeFail(kpProbe) : probeOk(kpProbe, elapsed);
            if (cur < items.length) await sleep(Math.max(30, elapsed < 300 ? 30 : 60));
        }
        return imdbApplyPhase(resolved, rated, watched, statusEl, mode, items.length);
    }

    function renderIMDbResult(result, statusEl, rated, watched, mode) {
        const lbl = mode === 'replace' ? ' (режим замены)' : '';
        statusEl.textContent = '';
        statusEl.insertAdjacentHTML('beforeend', `✅ <b>Готово${lbl}!</b><br>Оценено: <b>${result.rated}</b><br>Просмотрено: <b>${result.watched}</b><br>Пропущено: <b>${result.skipped}</b><br>Не найдено: <b>${result.notFound}</b><br>Ошибок: <b>${result.failed}</b>`);
        if (!result.notFound && !result.failed) {
            statusEl.insertAdjacentHTML('beforeend', '<br><br>🎉 Все записи импортированы!');
        }
        if (result.missed.length) {
            downloadCSV(buildCSV(result.missed), 'imdb_missed.csv');
            const btn = Object.assign(document.createElement('button'), {
                id: 'mrs-retry',
                className: 'mrs-btn mrs-btn--yellow',
                textContent: `🔍 Искать глубже (${result.missed.length})`,
            });
            btn.addEventListener('click', async () => {
                setStatus(statusEl, `Глубокий поиск${dots()}`);
                const r2 = await imdbProcess(result.missed, rated, watched, statusEl, true, mode);
                renderIMDbResult(r2, statusEl, rated, watched, mode);
            });
            statusEl.insertAdjacentElement('beforeend', document.createElement('br'));
            statusEl.insertAdjacentElement('beforeend', document.createElement('br'));
            statusEl.insertAdjacentElement('beforeend', btn);
        }
    }

    async function performIMDbExport(statusEl) {
        setStatus(statusEl, `Определяем профиль IMDb${dots()}`);
        const uid = getIMDbUid();
        if (!uid) throw new Error('IMDb user ID не найден — войдите в аккаунт');
        resetTitleMap(); imdbHistory = null;

        const HASH = '7c4e0771d67f21fc27fd44fc46d49cc589225a9c5e63e51cc0b8d42f39ee99cc';
        const seen = new Set();

        const scan = async (urlFn, label) => {
            const items = [];
            for (let p = 1; p <= RETRY.PAGES; p++) {
                setStatus(statusEl, `${label} стр. ${p}${dots()}`);
                const nd = await fetchNextData(urlFn(uid, p));
                if (!nd) break;
                const s = nd?.props?.pageProps?.mainColumnData?.advancedTitleSearch;
                const edges = s?.edges ?? [];
                if (!edges.length) break;
        for (const e of edges) {
            const n = e?.node?.title ?? e?.node;
            if (!n?.id?.startsWith('tt') || seen.has(n.id)) continue;
            seen.add(n.id);
            const typeTxt = (n?.titleType?.text || '').toLowerCase();
            items.push({
                titleRu: '',
                titleOrig: n?.originalTitleText?.text ?? n?.titleText?.text ?? '',
                type: typeTxt.includes('series') ? 'TvSeries' : 'Film',
                ttId: n.id,
                yearStart: String(n?.releaseYear?.year ?? ''),
                yearEnd: String(n?.releaseYear?.endYear ?? ''),
                rating: null,
            });
        }
                if (!s?.pageInfo?.hasNextPage) break;
                await sleep(DELAY.HISTORY_PAGE);
            }
            return items;
        };

        // Parallelize ratings + watch history scanning
        const [rated, watched] = await Promise.all([
            scan((u, p) => `https://www.imdb.com/user/${u}/ratings/?page=${p}`, 'Оценки'),
            scan((u, p) => `https://www.imdb.com/user/${u}/watchhistory/?my_ratings=exclude&page=${p}`, 'Просмотры'),
        ]);

        // Fetch actual rating values in parallel batches
        const BATCH = 250;
        const batches = [];
        for (let i = 0; i < rated.length; i += BATCH) batches.push(rated.slice(i, i + BATCH).map(x => x.ttId));

        const results = await Promise.allSettled(batches.map(batch =>
            fetch(IMDB_GQL, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    operationName: 'PersonalizedUserData',
                    variables: { locale: 'en-US', idArray: batch, includeUserData: true, includeWatchedData: true, location: { latLong: { lat: '55.75', long: '37.58' } }, fetchOtherUserRating: false },
                    extensions: { persistedQuery: { version: 1, sha256Hash: HASH } },
                }),
            })
        ));

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value.ok) {
                const j = await r.value.json();
                for (const t of j?.data?.titles ?? []) {
                    const item = rated.find(x => x.ttId === t.id);
                    if (item && t?.userRating?.value != null) item.rating = t.userRating.value;
                }
            }
        }

        return buildCSV([...rated, ...watched.map(i => ({ ...i, rating: 'w' }))].map(i => ({ ...i, src: 'imdb' })));
    }

    async function performIMDbImport(csvData, statusEl, mode) {
        const items = parseCSV(csvData);
        if (!items.length) return setStatus(statusEl, '❌ CSV пуст или не распознан');
        imdbHistory = null;
        resetTitleMap();

        const uid = getIMDbUid();
        if (!uid) return setStatus(statusEl, '❌ IMDb user ID не найден — войдите в аккаунт');

        setStatus(statusEl, `Загружено ${items.length} записей. Сканируем историю IMDb${dots()}`);
        const { rated, watched } = await getIMDbHistory(statusEl);
        if (mode === 'replace') { rated.clear(); watched.clear(); }

        const result = await imdbProcess(items, rated, watched, statusEl, false, mode);
        renderIMDbResult(result, statusEl, rated, watched, mode);
    }

    // ====================== LETTERBOXD MODULE ======================

    // Letterboxd has no public API — all writes go through their internal API v0.
    // Reading is done via HTML scraping (their site is server-rendered).
    // Key endpoints:
    //   Search: GET /s/autocompletefilm?q=...  → JSON {matches:[{film:{id,slug,name,releaseYear}}]}
    //   Film page: GET /film/:slug/            → contains data-film-id in DOM
    //   Log/rate: PATCH https://letterboxd.com/api/v0/me/rate/{LID}  → JSON body with rating (0.5–5.0, 0.5 increments)
    //   Add to watched: POST same endpoint with no rating field
    // CSRF: available as supermodelCSRF global JS variable, sent via X-CSRF-TOKEN header

    function getLBUsername() {
        // Primary: Letterboxd sets `person` global on every page for logged-in users
        try {
            if (typeof person !== 'undefined' && person?.loggedIn && person?.username) return person.username;
        } catch { }
        // Fallback: URL path (only works on profile pages)
        const m = location.pathname.match(/^\/([^/]+)\/?$/);
        const excluded = new Set(['films', 'lists', 'members', 'journal', 'search', 'activity', 'import', 'settings', 'create-account', 'sign-in', 'about', 'pro', 'apps', 'contact', 'legal', 'stats', 'year-in-review', 'gift-guide', 'welcome', 'crew', 'api-beta', 'podcast']);
        if (m && !excluded.has(m[1])) return m[1];
        // Fallback: nav link (may not exist since nav is now React)
        for (const sel of ['a.main-nav-account-link', 'a[href^="/"][class*="account"]', '.main-nav .person-link']) {
            const el = document.querySelector(sel);
            const um = el?.getAttribute('href')?.match(/^\/([^/]+)\/?$/);
            if (um && !excluded.has(um[1])) return um[1];
        }
        return null;
    }

    function getLBCsrf() {
        // Primary: supermodelCSRF is set as a global JS variable on every Letterboxd page
        try { if (typeof supermodelCSRF !== 'undefined' && supermodelCSRF) return supermodelCSRF; } catch { }
        // Fallback: window.csrf
        try { if (typeof window.csrf !== 'undefined' && window.csrf) return window.csrf; } catch { }
        // Fallback: cookie (may be HttpOnly, so often unreadable)
        try {
            const c = document.cookie.match(/\bcom\.xk72\.webparts\.csrf=([^;]+)/);
            if (c) return decodeURIComponent(c[1]);
        } catch { }
        // Fallback: DOM elements
        return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
            ?? document.querySelector('input[name="__csrf"]')?.value
            ?? null;
    }

    // Fast regex-based parsers for Letterboxd (replaces DOMParser, ~100x faster)
    // Updated for Letterboxd's React-based grid layout (2026)
    const LB_GRIDITEM_RE = /<li[^>]*class="[^"]*griditem[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    const LB_SLUG_RE = /data-item-slug="([^"]+)"/;
    const LB_NAME_RE = /data-item-name="([^"]+)"/;
    const LB_ITEM_UID_RE = /data-item-uid="film:(\d+)"/;
    const LB_RATED_RE = /class="[^"]*rated-(\d+)[^"]*"/;
    const LB_GRIDITEM_JSON_RE = /data-postered-identifier='([^']+)'/;
    const LB_DIARY_ROW_RE = /<tr[^>]*class="[^"]*diary-entry-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    const LB_DIARY_DATE_RE = /<td[^>]*class="[^"]*td-day[^"]*"[^>]*>[\s\S]*?(\d{4}\/\d{2}\/\d{2})/;
    const LB_TIME_DATETIME_RE = /<time[^>]+datetime="([^"]+)"/;
    const LB_PAGINATION_NEXT_RE = /<a[^>]*(?:class="[^"]*next[^"]*"|rel="next")[^>]*>/;

    async function fetchLBHtml(url) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const r = await fetchT(url, 15000);
            if (r?.status === 429) { await sleep(2000 + attempt * 2000); continue; }
            if (!r?.ok) return null;
            return await r.text();
        }
        return null;
    }

    function parseLBRatings(html) { return parseLBItems(html, 'grid'); }
    function parseLBDiary(html) { return parseLBItems(html, 'diary'); }
    function parseLBWatched(html) { return parseLBItems(html, 'grid'); }

    function parseLBItems(html, mode) {
        const results = [];
        let sources = [];
        if (mode === 'diary') {
            const diary = [...html.matchAll(LB_DIARY_ROW_RE)];
            if (diary.length) sources = diary.map(m => m[1]);
            else sources = [...html.matchAll(LB_GRIDITEM_RE)].map(m => m[1]);
        } else {
            sources = [...html.matchAll(LB_GRIDITEM_RE)].map(m => m[1]);
        }
        for (const liHtml of sources) {
            const slug = liHtml.match(LB_SLUG_RE)?.[1];
            if (!slug) continue;
            let filmId = '';
            const jsonMatch = liHtml.match(LB_GRIDITEM_JSON_RE);
            if (jsonMatch) {
                try { const d = JSON.parse(jsonMatch[1]); filmId = d?.uid?.replace('film:', '') ?? ''; } catch { }
            }
            if (!filmId) filmId = liHtml.match(LB_ITEM_UID_RE)?.[1] ?? '';
            const nameMatch = liHtml.match(LB_NAME_RE);
            const fullName = nameMatch ? nameMatch[1] : '';
            const yearMatch = fullName.match(/\((\d{4}(?:-\d{4})?)\)\s*$/);
            const title = yearMatch ? fullName.replace(/\s*\(\d{4}(?:-\d{4})?\)\s*$/, '').trim() : fullName;
            const year = yearMatch ? yearMatch[1] : '';
            const ratingMatch = liHtml.match(LB_RATED_RE);
            const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null;
            const dateMatch = liHtml.match(LB_DIARY_DATE_RE) ?? liHtml.match(LB_TIME_DATETIME_RE);
            const watchedDate = dateMatch ? dateMatch[1].replace(/\//g, '-').split('T')[0] : '';
            results.push({ slug, filmId, title, year, rating, watchedDate });
        }
        return results;
    }

    async function lbScrapePages(username, pathFn, parseFn, label, statusEl, maxPages = 200) {
        const all = [];
        for (let p = 1; p <= maxPages; p++) {
            setStatus(statusEl, `${label}: страница ${p}${dots()}`);
            const html = await fetchLBHtml(pathFn(username, p));
            if (!html) break;
            const items = parseFn(html);
            if (!items.length) break;
            all.push(...items);
            if (!html.match(LB_PAGINATION_NEXT_RE)) break;
            await sleep(200);
        }
        return all;
    }

    async function performLBExport(statusEl) {
        const username = getLBUsername();
        if (!username) throw new Error('Не удалось определить имя пользователя Letterboxd — откройте свой профиль');

        const map = new Map();
        const merge = items => items.forEach(i => {
            if (!i.slug) return;
            if (!map.has(i.slug)) { map.set(i.slug, { ...i }); return; }
            const ex = map.get(i.slug);
            if (i.watchedDate && !ex.watchedDate) ex.watchedDate = i.watchedDate;
            if (i.rating != null && ex.rating == null) ex.rating = i.rating;
            if (i.filmId && !ex.filmId) ex.filmId = i.filmId;
        });

        const [ratings, diary, watched] = await Promise.all([
            lbScrapePages(username, (u, p) => `https://letterboxd.com/${u}/films/ratings/page/${p}/`, parseLBRatings, 'Рейтинги', statusEl),
            lbScrapePages(username, (u, p) => `https://letterboxd.com/${u}/films/diary/page/${p}/`, parseLBDiary, 'Дневник', statusEl),
            lbScrapePages(username, (u, p) => `https://letterboxd.com/${u}/films/page/${p}/`, parseLBWatched, 'Просмотрено', statusEl),
        ]);

        merge(ratings);
        merge(diary);
        merge(watched);

        const rows = [...map.values()].map(i => ({
            titleRu: '',
            titleOrig: i.title || i.slug,
            type: 'Film',
            lbSlug: i.slug || '',
            yearStart: i.year || '',
            rating: i.rating ?? null,
            watchedDate: i.watchedDate ?? '',
            src: 'lb',
        }));
        setStatus(statusEl, `Найдено: ${rows.length} фильмов. Формируем CSV${dots()}`);
        return buildCSV(rows);
    }

    // Letterboxd film lookup: multiple strategies with progressive fallback
    async function lbSearchFilm(title, year, csrfRef) {
        const cacheKey = `lb:${normTitle(title)}|${year || ''}`;
        return dedupeFetch(cacheKey, async () => {
            const nT = normTitle(title);
            const yearStr = String(year || '').trim();
            const yearNum = yearStr ? parseInt(yearStr, 10) : null;
            const ts = Date.now();

            // Helper: extract slug from autocomplete entry (url="/film/the-matrix/" or "/tv/breaking-bad/")
            const slugFromUrl = u => u?.replace(/^\/(?:film|tv)\/|\/$/g, '') || null;

            // Helper: try autocomplete with a query
            const tryAutocomplete = async (q, csrfRef) => {
                for (let attempt = 0; attempt < 3; attempt++) {
                    const r = await fetchT(`https://letterboxd.com/s/autocompletefilm?q=${encodeURIComponent(q)}&limit=20&timestamp=${ts}`);
                    if (r?.status === 429) { await sleep(2000 + attempt * 2000); continue; }
                    if (!r?.ok) return null;
                    const json = await r.json().catch(() => null);
                    if (json?.result !== true) return null;
                    if (csrfRef && json.csrf) csrfRef.val = json.csrf;
                    const items = json.data ?? [];
                    if (!items.length) return null;

                    for (const entry of items) {
                        const slug = slugFromUrl(entry.url);
                        if (!slug) continue;
                        const fYear = String(entry.releaseYear ?? '');
                        const fN = normTitle(entry.name ?? '');
                        const titleMatch = nT === fN || nT.includes(fN) || fN.includes(nT);
                        const yearMatch = !yearNum || !fYear || Math.abs(parseInt(fYear, 10) - yearNum) <= 1;
                        if (titleMatch && yearMatch) return { slug, filmId: entry.id ? String(entry.id) : null, lid: entry.lid ?? null, year: fYear };
                    }
                    if (!yearNum) {
                        const first = items[0];
                        const slug = slugFromUrl(first.url);
                        if (slug) return { slug, filmId: first.id ? String(first.id) : null, lid: first.lid ?? null, year: String(first.releaseYear ?? '') };
                    }
                    return null;
                }
                return null;
            };

            // Strategy 1: Autocomplete with original title + transliteration
            let result = await tryAutocomplete(title, csrfRef);
            if (result) return result;
            if (hasCyr(title)) {
                result = await tryAutocomplete(translit(title), csrfRef);
                if (result) return result;
            }

            // Strategy 2: Alternative title formats
            const altTitles = [
                title.replace(/^The\s+/i, '').replace(/^A\s+/i, ''),
                title.replace(/[\(\[].*?[\)\]]/g, '').trim(),
                title.replace(/[^a-zа-яё0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim(),
                // Normalize special chars: ²→2, etc.
                title.replace(/²/g, '2').replace(/³/g, '3'),
                // Remove episode/part numbers: "Star Wars: Episode VIII - The Last Jedi" → "Star Wars: The Last Jedi"
                title.replace(/[\-–—]?\s*(?:Episode|Part|Season|Сезон|Серия)\s+[IVXLCDM\d]+/gi, '').replace(/[\-–—]?\s*(?:Part|Season|Сезон)\s+\d+/gi, '').trim(),
                // Extract core title from franchise: "Star Wars: The Last Jedi" → "The Last Jedi"
                (m => m ? m[1].trim() : null)(title.match(/^(?:Star Wars|Harry Potter|Fast and Furious|Mission: Impossible)[\-–—]\s*(.+?)$/i)),
            ].filter(Boolean);
            for (const q of [...new Set(altTitles)]) {
                if (q === title || !q || q.length < 2) continue;
                result = await tryAutocomplete(q, csrfRef);
                if (result) return result;
            }

            // Strategy 3: REMOVED — unreliable for TV shows (/film/ vs /tv/), wastes HEAD requests

            // Strategy 4: HTML search fallback (includes TV shows)
            const tryHtmlSearch = async (q) => {
                try {
                    const html = await fetchLBHtml(`https://letterboxd.com/search/films/?q=${encodeURIComponent(q)}`);
                    if (!html) return null;
                    // Try new React-based format: data-item-slug + data-postered-identifier
                    const itemMatch = html.match(/data-item-slug="([^"]+)"[\s\S]*?data-postered-identifier='(\{[^']+\})'/);
                    if (itemMatch) {
                        let filmId = null, lid = null;
                        try { const d = JSON.parse(itemMatch[2]); filmId = d?.uid?.replace('film:', '') ?? null; lid = d?.lid ?? null; } catch { }
                        const nameMatch = html.match(/data-item-name="[^"]*\((\d{4})\)/);
                        return { slug: itemMatch[1], filmId, lid, year: nameMatch?.[1] ?? '' };
                    }
                    return null;
                } catch { return null; }
            };

            result = await tryHtmlSearch(title);
            if (result) return result;
            if (hasCyr(title)) {
                result = await tryHtmlSearch(translit(title));
                if (result) return result;
            }

            // Strategy 5: Try normalized/core title variants via HTML search
            for (const q of altTitles) {
                if (q === title || !q || q.length < 2) continue;
                result = await tryHtmlSearch(q);
                if (result) return result;
            }

            return null;
        });
    }

    // Get film's LID (Letterboxd ID like "2a1m") needed for the API v0 rate endpoint
    async function lbGetFilmLid(slug, csrfRef) {
        for (const path of [`/film/${slug}/`, `/tv/${slug}/`]) {
            try {
                const html = await fetchLBHtml(`https://letterboxd.com${path}`);
                if (!html) continue;
                if (csrfRef) {
                    const csrfInPage = html.match(/supermodelCSRF\s*=\s*['"]([^'"]+)['"]/);
                    if (csrfInPage) csrfRef.val = csrfInPage[1];
                }
                // Extract from production:identifier meta tag: {"lid":"2a1m","uid":"film:51518",...}
                const prodId = html.match(/name="production:identifier"\s+content="([^"]+)"/);
                if (prodId) {
                    try { const d = JSON.parse(prodId[1].replace(/&quot;/g, '"')); if (d?.lid) return d.lid; } catch { }
                }
                // Extract from data-postered-identifier JSON (React format)
                const jsonId = html.match(/data-postered-identifier='(\{[^']+\})'/);
                if (jsonId) {
                    try { const d = JSON.parse(jsonId[1]); if (d?.lid) return d.lid; } catch { }
                }
            } catch { continue; }
        }
        return null;
    }

    // Apply rating or mark as watched via Letterboxd internal API v0.
    // csrfRef: { val: string } — mutable ref, updated from each response
    // Returns { status: 'rated'|'watched'|null }
    async function applyLBRating(slug, lid, filmId, rating10, csrfRef, watchedDate) {
        const hasR = rating10 != null && String(rating10) !== '' && +rating10 >= 1 && +rating10 <= 10;

        if (!hasR && !filmId) {
            // Need filmId for watch endpoint; try to get LID at minimum
            if (!lid) lid = await lbGetFilmLid(slug, csrfRef);
            if (!lid) return { status: null };
        }

        if (!csrfRef.val) {
            console.warn('[mrs] CSRF token is empty! supermodelCSRF=', typeof supermodelCSRF !== 'undefined' ? supermodelCSRF : 'undefined');
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            let r;
            if (hasR) {
                // Rating: PATCH /me/rate/{LID}  body: {"rating": 0.5–5.0}
                if (!lid) lid = await lbGetFilmLid(slug, csrfRef);
                if (!lid) return { status: null };
                const ratingVal = Math.min(5, Math.max(0.5, Math.round(+rating10) / 2));
                const hdrs = {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Accept': '*/*',
                    'Referer': location.href,
                    'X-CSRF-TOKEN': csrfRef.val ?? '',
                };
                r = await fetchT(`https://letterboxd.com/api/v0/me/rate/${lid}`, 10000, {
                    method: 'PATCH', headers: hdrs,
                    body: JSON.stringify({ rating: ratingVal }),
                });
            } else {
                // Watched only: POST /s/film:{filmId}/watch/  body: watched=true&__csrf={csrf}
                if (!filmId) { console.warn(`[mrs] LB no filmId for ${slug}`); return { status: null }; }
                const watchUrl = `https://letterboxd.com/s/film:${filmId}/watch/`;
                r = await fetchT(watchUrl, 10000, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': '*/*',
                        'Referer': location.href,
                    },
                    body: `watched=true&__csrf=${encodeURIComponent(csrfRef.val ?? '')}`,
                });
            }

            if (r) {
                const respText = await r.clone().text().catch(() => '');
                if (r.ok) {
                    const status = hasR ? 'rated' : 'watched';
                    applyLBRating._okCount = (applyLBRating._okCount || 0) + 1;
                    if (applyLBRating._okCount <= 5 || applyLBRating._okCount % 50 === 0) {
                        console.log(`[mrs] LB ${status.toUpperCase()} OK #${applyLBRating._okCount}: ${slug} filmId=${filmId} lid=${lid} rating=${hasR ? Math.min(5, Math.max(0.5, Math.round(+rating10) / 2)) : 'none'} (csv=${rating10}) status=${r.status} resp=${respText.slice(0, 200)}`);
                    }
                    return { status };
                }
                if (r.status === 429) {
                    const waitMs = 3000 + attempt * 3000;
                    console.warn(`[mrs] LB 429: ${slug} — retry in ${waitMs}ms (attempt ${attempt + 1}/3)`);
                    await sleep(waitMs);
                    continue;
                }
                console.warn(`[mrs] LB FAILED: ${slug} filmId=${filmId} lid=${lid} rating=${hasR ? rating10 : 'none'} status=${r.status} body=${respText.slice(0, 300)}`);
                return { status: null };
            } else {
                console.warn(`[mrs] LB timeout: ${slug} filmId=${filmId}`);
            }
        }
        return { status: null };
    }

    async function performLBImport(csvData, statusEl, mode) {
        const items = parseCSV(csvData);
        if (!items.length) return setStatus(statusEl, '❌ CSV пуст или не распознан');

        const csrfRef = { val: getLBCsrf() };
        if (!csrfRef.val) return setStatus(statusEl, '❌ CSRF токен не найден — войдите в аккаунт Letterboxd');

        // Phase 1: resolve slugs
        Object.assign(lbProbe, makeProbe(100));
        setStatus(statusEl, `Резолвинг ID: ${items.length} фильмов${dots()}`);
        const resolved = [];
        let cur = 0;

        while (cur < items.length) {
            const slice = items.slice(cur, cur + lbProbe.c);
            setStatus(statusEl, `Резолвинг ${cur + 1}–${Math.min(cur + lbProbe.c, items.length)}/${items.length}${dots()}`);
            const t0 = Date.now();
            const res = await asyncPool(15, slice, i =>
                i.lbSlug && /^[a-z0-9-]+$/i.test(i.lbSlug)
                    ? Promise.resolve({ slug: i.lbSlug, filmId: null, lid: null })
                    : lbSearchFilm(i.title, i.year, csrfRef)
            );
            let fail = false;
            res.forEach((r, j) => {
                const found = r.status === 'fulfilled' ? r.value : null;
                resolved.push({ item: slice[j], slug: found?.slug ?? null, filmId: found?.filmId ?? null, lid: found?.lid ?? null });
                if (!found) fail = true;
            });
            cur += lbProbe.c;
            const elapsed = Date.now() - t0;
            fail ? probeFail(lbProbe) : probeOk(lbProbe, elapsed);
            if (cur < items.length) await sleep(200);
        }

        // Pre-fetch missing LIDs in parallel before apply phase
        const needLid = resolved.filter(x => x.slug && !x.lid);
        if (needLid.length) {
            setStatus(statusEl, `Получение LID: ${needLid.length} фильмов${dots()}`);
            const lids = await asyncPool(10, needLid, x => lbGetFilmLid(x.slug, csrfRef));
            lids.forEach((r, i) => {
                if (r.status === 'fulfilled' && r.value) needLid[i].lid = r.value;
            });
        }

        // Phase 2: apply
        Object.assign(lbProbe, makeProbe(100));
        let rated = 0, watched = 0, notFound = 0, failed = 0;
        const missed = [];
        const toApply = resolved.filter(x => {
            if (!x.slug) { notFound++; missed.push(x.item); return false; }
            return true;
        });
        console.log(`[mrs] LB PHASE SUMMARY: CSV parsed=${items.length} resolved=${resolved.length} withSlug=${toApply.length} noSlug=${notFound}`);

        cur = 0;
        while (cur < toApply.length) {
            const slice = toApply.slice(cur, cur + 15);
            setStatus(statusEl, `Применение ${cur + 1}–${Math.min(cur + 15, toApply.length)}/${toApply.length}${dots()}`);
            const res = await asyncPool(15, slice, entry => applyLBRating(entry.slug, entry.lid, entry.filmId, entry.item.rating, csrfRef, entry.item.watchedDate));
            res.forEach((r, j) => {
                const st = r.status === 'fulfilled' ? (r.value?.status ?? null) : null;
                if (st === 'rated') rated++;
                else if (st === 'watched') watched++;
                else { failed++; missed.push(toApply[cur + j].item); }
            });
            cur += 15;
            await sleep(50);
        }

        if (missed.length) downloadCSV(buildCSV(missed), 'lb_missed.csv');
        console.log(`[mrs] LB APPLY DONE: rated=${rated} watched=${watched} failed=${failed} toApply=${toApply.length}`);
        statusEl.textContent = '';
        statusEl.insertAdjacentHTML('beforeend', `✅ <b>Готово!</b><br>Оценено: <b>${rated}</b><br>Просмотрено: <b>${watched}</b><br>Не найдено: <b>${notFound}</b><br>Ошибок: <b>${failed}</b>${!notFound && !failed ? '<br><br>🎉 Все записи импортированы!' : ''}`);
    }

    // ====================== MODULE REGISTRY ======================

    const MODULES = {
        kp: {
            isActive: () => SITE.isKP,
            export: performKPExport,
            import: performKPImport,
            exportFileName: () => `kinopoisk_ratings_${new Date().toISOString().slice(0, 10)}.csv`,
        },
        imdb: {
            isActive: () => SITE.isIMDb,
            export: performIMDbExport,
            import: performIMDbImport,
            exportFileName: () => `imdb_ratings_${new Date().toISOString().slice(0, 10)}.csv`,
        },
        lb: {
            isActive: () => SITE.isLB,
            export: performLBExport,
            import: performLBImport,
            exportFileName: () => `letterboxd_ratings_${new Date().toISOString().slice(0, 10)}.csv`,
        },
    };

    // ====================== UI ======================

    const __mrsStyle = document.createElement('style');
    __mrsStyle.textContent = `
        #mrs-wrap{position:fixed;bottom:20px;right:20px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
        #mrs-status{background:rgba(0,0,0,.93);color:#fff;padding:12px 16px;border-radius:8px;max-width:420px;display:none;font-size:13.5px;line-height:1.5;word-break:break-word}
        .mrs-btn{padding:12px 20px;font-weight:700;border:none;border-radius:8px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.4);font-size:14px;transition:opacity .15s}
        .mrs-btn:disabled{opacity:.5;cursor:default}
        .mrs-btn--yellow{background:#f5c518;color:#000}
        .mrs-btn--red{background:#e60000;color:#fff}
        #mrs-btn-group{display:flex;flex-direction:column;gap:8px}
    `;
    (document.head || document.documentElement).appendChild(__mrsStyle);

    function buildUI() {
        if (document.getElementById('mrs-wrap')) return;
        const mod = Object.values(MODULES).find(m => m.isActive());
        if (!mod) return;

        const wrap = document.createElement('div');
        wrap.id = 'mrs-wrap';

        const statusEl = document.createElement('div');
        statusEl.id = 'mrs-status';
        wrap.appendChild(statusEl);

        const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv' });
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        let mode = 'normal';
        const btns = [];
        const setDisabled = v => btns.forEach(b => b.disabled = v);

        const btnExport = Object.assign(document.createElement('button'), { className: 'mrs-btn mrs-btn--yellow', textContent: '📤 Экспорт оценок' });
        btnExport.addEventListener('click', async () => {
            setDisabled(true);
            try {
                const csv = await mod.export(statusEl);
                if (csv) {
                    const fname = typeof mod.exportFileName === 'function' ? mod.exportFileName() : mod.exportFileName;
                    downloadCSV(csv, fname);
                    setStatus(statusEl, '✅ Экспорт завершён! Файл сохранён.');
                }
            } catch (e) {
                setStatus(statusEl, '❌ ' + (e.message ?? String(e)));
            } finally { setDisabled(false); }
        });

        const btnImport = Object.assign(document.createElement('button'), { className: 'mrs-btn mrs-btn--yellow', textContent: '📥 Импортировать' });
        const btnReplace = Object.assign(document.createElement('button'), { className: 'mrs-btn mrs-btn--red', textContent: '🔄 Жёсткий импорт', title: 'Перезапишет существующие оценки' });

        btnImport.addEventListener('click', () => { mode = 'normal'; fileInput.click(); });
        btnReplace.addEventListener('click', () => { mode = 'replace'; fileInput.click(); });

        fileInput.addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            fileInput.value = '';
            setDisabled(true);
            statusEl.style.display = 'block';
            try { await mod.import(await file.text(), statusEl, mode); }
            finally { setDisabled(false); }
        });

        btns.push(btnExport, btnImport, btnReplace);
        wrap.appendChild(btnExport);
        const grp = document.createElement('div');
        grp.id = 'mrs-btn-group';
        grp.append(btnImport, btnReplace);
        wrap.appendChild(grp);
        document.body.appendChild(wrap);
    }

    // ====================== INIT ======================

    if (SITE.isKP || SITE.isIMDb || SITE.isLB) {
        buildUI();
        const reinit = () => setTimeout(buildUI, 500);
        window.addEventListener('popstate', reinit);
        const _push = history.pushState.bind(history);
        history.pushState = (...a) => { _push(...a); reinit(); };
    }

})();