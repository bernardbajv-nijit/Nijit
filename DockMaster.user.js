// ==UserScript==
// @name         DockMaster + FC Research Collector
// @namespace    dockmaster-fc-research
// @version      6.0.0
// @description  DockMaster Fast: ISA, ASIN, P/C/U, Hazmat PL/DE, CSV; oszczedne skanowanie i kolejka z kontrola bledow
// @match        https://dockmaster.eu.aftx.amazonoperations.app/*
// @match        https://idx.eu.aftx.amazonoperations.app/*
// @match        https://qifcr.eu.aftx.amazonoperations.app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      pandash.eu.aftx.amazonoperations.app
// @sandbox      raw
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * DockMaster v6 Fast - 2026-10-28
 * Zachowuje klucze zapisanych ISA/ASIN z v5. Nie kasuje ich przy rozpoczeciu zbierania.
 * Instaluj ZAMIAST v5.7, nie rownolegle. Nie ustawia @updateURL/@downloadURL
 * dopoki nowa wersja nie znajdzie sie w kontrolowanym repozytorium.
 * Zmiany sa w pamieci i zapisywane porcjami, nie raz na kazdy ASIN.
 * Brak telemetrii; Hazmat odpytywany TYLKO po kliknieciu uzytkownika.
 */
(function () {
    'use strict';
    if (window.__dockmasterFastV6Loaded) return;
    window.__dockmasterFastV6Loaded = true;

    const CFG = Object.freeze({
        fcBase: 'https://qifcr.eu.aftx.amazonoperations.app/XDR1/results?s=',
        hazmatURL: 'https://pandash.eu.aftx.amazonoperations.app/GridServlet',
        hosts: ['dockmaster.eu.aftx.amazonoperations.app', 'idx.eu.aftx.amazonoperations.app'],
        fcHost: 'qifcr.eu.aftx.amazonoperations.app',
        keyISA: 'dockmaster_isa_records_v5',
        keyASIN: 'dockmaster_asin_records_v5',
        keyJob: 'dockmaster_collection_job_v6',
        keyOpen: 'dockmaster_panel_open_v6',
        flushMs: 1800,
        scanDelay: 650,
        minScanGap: 1200,
        queueCheckMs: 850,
        queueTimeoutMs: 22000,
        queueStableMs: 1600,
        queueMinMs: 1900,
        queueMaxAttempts: 2,
        maxNetworkText: 1000000,
        maxJSONNodes: 12000,
        maxRenderRows: 100
    });
    const isDock = CFG.hosts.includes(location.hostname);
    const isFC = location.hostname === CFG.fcHost;
    if (!isDock && !isFC) return;
    const startedAt = Date.now();
    const isCollector = () => isFC && new URL(location.href).searchParams.get('dmCollector') === '1';
    const storageObject = key => {
        const val = GM_getValue(key, {});
        return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
    };
    const state = {
        isa: storageObject(CFG.keyISA),
        asins: storageObject(CFG.keyASIN),
        pendingISA: new Map(),
        pendingASIN: new Map(),
        flushTimer: 0,
        renderTimer: 0,
        scanTimer: 0,
        firstPendingScanAt: 0,
        scanning: false,
        scanAgain: false,
        lastScan: 0,
        route: location.href,
        visibleISA: new Set(),
        asinByISA: new Map(),
        asinIndex: new Map(),
        uniqueASINs: new Set(),
        tableChangeAt: Date.now(),
        tableStats: { isa: null, rows: 0, validRows: 0 },
        panelOpen: !!GM_getValue(CFG.keyOpen, false),
        filter: '',
        shown: CFG.maxRenderRows,
        root: null,
        dom: null,
        jobTimer: 0,
        hazmatBusy: false,
        hazmatStop: false,
        hazmatMessage: '',
        responseQueue: [],
        responseScheduled: false,
        aborting: false
    };

    const nowISO = () => new Date().toISOString();
    const parseISA = value => {
        const m = String(value ?? '').match(/(?:^|\D)(\d{11})(?!\d)/);
        return m ? m[1] : null;
    };
    const parseASIN = value => {
        const m = String(value ?? '').toUpperCase().match(/(?:^|[^A-Z0-9])(B[A-Z0-9]{9})(?![A-Z0-9])/);
        return m ? m[1] : null;
    };
    const num = value => {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (value == null || value === '') return null;
        const m = String(value).replace(/[\s\u00a0,]/g, '').match(/^-?\d+(?:\.\d+)?/);
        return m ? Number(m[0]) : null;
    };
    const norm = key => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    const first = (obj, names) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
        const wanted = new Set(names.map(norm));
        for (const [k, v] of Object.entries(obj)) if (wanted.has(norm(k))) return v;
        return undefined;
    };
    const firstNum = (obj, names) => {
        const v = first(obj, names);
        return v === undefined ? null : num(v);
    };
    const KEYS = Object.freeze({
        pallets: ['palletCount', 'palletsCount', 'palletQuantity', 'numberOfPallets', 'totalPallets', 'pallets'],
        cartons: ['cartonCount', 'cartonsCount', 'cartonQuantity', 'numberOfCartons', 'totalCartons', 'caseCount', 'cases', 'cartons'],
        units: ['unitCount', 'unitsCount', 'unitQuantity', 'numberOfUnits', 'totalUnits', 'expectedUnits', 'quantity', 'units'],
        unfilled: ['unfilled', 'unfilledQuantity', 'unfilledUnits', 'openQuantity', 'openQty', 'remainingQuantity', 'remainingUnits'],
        canceled: ['canceled', 'cancelled', 'canceledQuantity', 'cancelledQuantity', 'canceledUnits', 'cancelledUnits'],
        received: ['received', 'receivedQuantity', 'receivedUnits', 'receivedQty', 'quantityReceived'],
        overage: ['overaged', 'overage', 'overagedQuantity', 'overageQuantity', 'overagedUnits', 'overageUnits', 'overReceived', 'overReceivedQuantity'],
        isa: ['inboundShipmentAppointmentId', 'shipmentAppointmentId', 'inboundAppointmentId', 'appointmentId', 'isaId', 'isa'],
        vendor: ['vendorCode', 'vendor', 'vendorId']
    });
    const isNil = v => v === null || v === undefined || v === '';

    // ----- Rejestry w pamieci; nie ma petli sortujacych po calej bazie dla kazdego wiersza -----
    function rebuildIndexes() {
        state.asinByISA.clear();
        state.asinIndex.clear();
        state.uniqueASINs.clear();
        for (const [key, row] of Object.entries(state.asins)) {
            if (!row || !row.asin) continue;
            const asin = parseASIN(row.asin);
            if (!asin) continue;
            state.uniqueASINs.add(asin);
            const isa = parseISA(row.isa) || 'UNKNOWN';
            if (!state.asinByISA.has(isa)) state.asinByISA.set(isa, new Set());
            state.asinByISA.get(isa).add(asin);
            if (!state.asinIndex.has(asin)) state.asinIndex.set(asin, new Set());
            state.asinIndex.get(asin).add(key);
        }
    }
    rebuildIndexes();

    function markPending(kind, key, changes) {
        const pending = kind === 'isa' ? state.pendingISA : state.pendingASIN;
        pending.set(key, Object.assign(pending.get(key) || {}, changes));
        if (!state.flushTimer) state.flushTimer = setTimeout(flush, CFG.flushMs);
        scheduleRender();
    }
    function patchISA(raw, data = {}) {
        const isa = parseISA(raw);
        if (!isa) return false;
        const old = state.isa[isa] || { isa, discoveredAt: nowISO(), collected: false };
        const changes = {};
        if (!state.isa[isa]) {
            changes.isa = isa;
            changes.discoveredAt = old.discoveredAt;
            changes.collected = false;
        }
        for (const field of ['pallets', 'cartons', 'units']) {
            if (data[field] == null) continue;
            const next = num(data[field]);
            if (next !== null && next !== old[field]) changes[field] = next;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'collected') && data.collected !== old.collected) {
            changes.collected = !!data.collected;
            if (data.collected) changes.collectedAt = nowISO();
        }
        if (!Object.keys(changes).length) return false;
        changes.updatedAt = nowISO();
        state.isa[isa] = Object.assign({}, old, changes);
        markPending('isa', isa, changes);
        return true;
    }
    function patchASIN(rawASIN, rawISA, fields = {}) {
        const asin = parseASIN(rawASIN);
        if (!asin) return false;
        const isa = parseISA(rawISA) || 'UNKNOWN';
        const key = isa + '::' + asin;
        const old = state.asins[key] || { asin, isa, discoveredAt: nowISO() };
        const changes = {};
        if (!state.asins[key]) {
            changes.asin = asin; changes.isa = isa;
            changes.discoveredAt = old.discoveredAt;
        }
        for (const field of ['unfilled', 'canceled', 'received', 'overage']) {
            if (isNil(fields[field])) continue;
            const next = num(fields[field]);
            if (next !== null && old[field] !== next) changes[field] = next;
        }
        if ('unfilled' in changes) changes.units = changes.unfilled; // kompatybilnosc z v5
        for (const field of ['vendorCode', 'hazmatLevelPL', 'hazmatLevelDE', 'glName', 'unCode', 'dropZone', 'source']) {
            if (isNil(fields[field])) continue;
            const next = String(fields[field]).trim();
            if (next && old[field] !== next) changes[field] = next;
        }
        if (!Object.keys(changes).length) return false;
        changes.updatedAt = nowISO();
        state.asins[key] = Object.assign({}, old, changes);
        if (!state.asinByISA.has(isa)) state.asinByISA.set(isa, new Set());
        state.asinByISA.get(isa).add(asin);
        if (!state.asinIndex.has(asin)) state.asinIndex.set(asin, new Set());
        state.asinIndex.get(asin).add(key);
        state.uniqueASINs.add(asin);
        markPending('asin', key, changes);
        return true;
    }
    function flush() {
        if (state.flushTimer) clearTimeout(state.flushTimer);
        state.flushTimer = 0;
        for (const [storageKey, pending, stateKey] of [
            [CFG.keyISA, state.pendingISA, 'isa'],
            [CFG.keyASIN, state.pendingASIN, 'asins']
        ]) {
            if (!pending.size) continue;
            try {
                const latest = storageObject(storageKey);
                for (const [id, patch] of pending) {
                    latest[id] = Object.assign({}, latest[id] || {}, patch);
                }
                GM_setValue(storageKey, latest); // Jeden zapis na paczke, nie per rekord.
                pending.clear();
                state[stateKey] = latest;
            } catch (error) {
                console.error('[DockMaster v6] Blad zapisu, ponowie za 3 s', error);
                if (!state.flushTimer) state.flushTimer = setTimeout(flush, 3000);
            }
        }
        rebuildIndexes();
    }
    function mergeRemote(kind, value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const pending = kind === 'isa' ? state.pendingISA : state.pendingASIN;
        const merged = Object.assign({}, value);
        for (const [id, patch] of pending) merged[id] = Object.assign({}, merged[id] || {}, patch);
        state[kind] = merged;
        rebuildIndexes();
        scheduleRender();
    }
    GM_addValueChangeListener(CFG.keyISA, (key, oldValue, value, remote) => {
        if (remote) mergeRemote('isa', value);
    });
    GM_addValueChangeListener(CFG.keyASIN, (key, oldValue, value, remote) => {
        if (remote) mergeRemote('asins', value);
    });
    GM_addValueChangeListener(CFG.keyJob, (key, oldValue, value, remote) => {
        if (remote) { scheduleRender(); if (isCollector()) queueEvaluateSoon(); }
    });
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flush();
        else scheduleScan(100);
    });

    // ----- Zbieranie przez DOM / odpowiedzi JSON -----
    function currentISA() {
        try { return parseISA(new URL(location.href).searchParams.get('s')); }
        catch (_) { return null; }
    }
    function fcUrl(isa, jobId = '') {
        const link = CFG.fcBase + encodeURIComponent(isa);
        return jobId ? link + '&dmCollector=1&dmJob=' + encodeURIComponent(jobId) : link;
    }
    function scanDock() {
        const visible = new Set();
        const nodes = document.querySelectorAll('[aria-label*="Appointment" i]');
        for (const el of nodes) {
            const text = el.getAttribute('aria-label') || '';
            const isa = parseISA(text);
            if (!isa) continue;
            visible.add(isa);
            const grab = letter => {
                const m = text.match(new RegExp(letter + '\\s*:\\s*([\\d,]+)', 'i'));
                return m ? num(m[1]) : null;
            };
            patchISA(isa, { pallets: grab('P'), cartons: grab('C'), units: grab('U') });
        }
        state.visibleISA = visible;
    }
    function scanFC() {
        const isa = currentISA();
        if (!isa) return;
        const table = document.querySelector('#table-purchase-order-item');
        const rows = table ? table.querySelectorAll('tbody tr') : [];
        let validRows = 0;
        for (const tr of rows) {
            const cells = tr.cells || tr.querySelectorAll('td');
            if (cells.length < 7) continue;
            const asin = parseASIN(cells[1].textContent);
            if (!asin) continue;
            validRows++;
            patchASIN(asin, isa, {
                source: 'Purchase Order Items',
                vendorCode: cells[2].textContent.trim(),
                unfilled: num(cells[3].textContent),
                canceled: num(cells[4].textContent),
                received: num(cells[5].textContent),
                overage: num(cells[6].textContent)
            });
        }
        // Fallback tylko dla stron bez tabeli, bez skanowania calego dokumentu.
        if (!validRows && !table) {
            let examined = 0;
            const elems = document.querySelectorAll('[data-asin], [class*="asin" i], a[href*="/dp/"]');
            for (const el of elems) {
                if (++examined > 600) break;
                const asin = parseASIN(el.getAttribute('data-asin')) ||
                    parseASIN(el.getAttribute('href')) || parseASIN(el.textContent.slice(0, 100));
                if (asin) patchASIN(asin, isa, { source: 'FC Research page fallback' });
            }
        }
        state.tableStats = { isa, rows: rows.length, validRows };
    }
    function runScan() {
        state.scanTimer = 0;
        state.firstPendingScanAt = 0;
        if (!document.body || state.scanning) { state.scanAgain = true; return; }
        if (document.hidden && !isCollector()) return; // Bez cyklicznego skanu ukrytych kart.
        if (Date.now() - state.lastScan < CFG.minScanGap) {
            scheduleScan(CFG.minScanGap - (Date.now() - state.lastScan)); return;
        }
        state.scanning = true;
        state.lastScan = Date.now();
        try { if (isDock) scanDock(); else if (isFC) scanFC(); }
        catch (error) { console.error('[DockMaster v6] Skanowanie:', error); }
        finally {
            state.scanning = false;
            if (state.scanAgain) { state.scanAgain = false; scheduleScan(CFG.scanDelay); }
        }
        scheduleRender();
    }
    function scheduleScan(delay = CFG.scanDelay) {
        const now = Date.now();
        if (!state.firstPendingScanAt) state.firstPendingScanAt = now;
        // Ciagle mutacje nie moga w nieskonczonosc odsuwac skanu.
        const maxWait = Math.max(0, 3500 - (now - state.firstPendingScanAt));
        if (state.scanTimer) clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(runScan, Math.max(0, Math.min(delay, maxWait)));
    }
    function isRelevantMutation(m) {
        const target = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
        if (!target || target.closest?.('#dm-v6-shell')) return false;
        if (isFC && (target.closest?.('#table-purchase-order-item') ||
            Array.from(m.addedNodes || []).some(n => n.nodeType === 1 &&
                (n.id === 'table-purchase-order-item' || n.querySelector?.('#table-purchase-order-item'))))) {
            state.tableChangeAt = Date.now();
        }
        return true;
    }
    function installObserver() {
        const observer = new MutationObserver(mutations => {
            // Jeden debounce zamiast pelnego skanu po kazdym mutation.
            if (mutations.some(isRelevantMutation)) scheduleScan();
        });
        observer.observe(document.body, {
            subtree: true, childList: true, characterData: isFC,
            attributes: true, attributeFilter: isDock ? ['aria-label'] : ['data-asin']
        });
        window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    }

    function looksLikeJSONObject(value) {
        return value && typeof value === 'object';
    }
    function extractObject(obj, parent) {
        if (Array.isArray(obj) || !looksLikeJSONObject(obj)) return;
        if (isDock) {
            let isa = parseISA(first(obj, KEYS.isa));
            if (!isa) {
                for (const [k, v] of Object.entries(obj)) {
                    if (/isa|appointment/i.test(k)) { isa = parseISA(v); if (isa) break; }
                }
            }
            if (isa) {
                const data = {};
                for (const field of ['pallets', 'cartons', 'units']) {
                    data[field] = firstNum(obj, KEYS[field]);
                    if (data[field] === null) data[field] = firstNum(parent, KEYS[field]);
                }
                patchISA(isa, data);
            }
        }
        if (isFC) {
            const isa = currentISA();
            if (!isa) return;
            const found = new Set();
            for (const [k, v] of Object.entries(obj)) {
                if (!norm(k).includes('asin') && norm(k) !== 'sku') continue;
                const items = Array.isArray(v) ? v : [v];
                for (const val of items) {
                    if (typeof val !== 'string' && typeof val !== 'number') continue;
                    const asin = parseASIN(val);
                    if (asin) found.add(asin);
                }
            }
            if (found.size) {
                const metrics = { source: 'FC Research API', vendorCode: first(obj, KEYS.vendor) };
                for (const f of ['unfilled', 'canceled', 'received', 'overage']) metrics[f] = firstNum(obj, KEYS[f]);
                for (const asin of found) patchASIN(asin, isa, metrics);
            }
        }
    }
    function processJSON(data) {
        const stack = [[data, null]];
        const seen = new WeakSet();
        let visited = 0;
        while (stack.length && visited < CFG.maxJSONNodes) {
            const [entry, parent] = stack.pop();
            if (!looksLikeJSONObject(entry) || seen.has(entry)) continue;
            seen.add(entry); visited++;
            if (!Array.isArray(entry)) extractObject(entry, parent);
            const obj = Array.isArray(entry) ? entry : Object.values(entry);
            for (let i = obj.length - 1; i >= 0; i--) {
                if (looksLikeJSONObject(obj[i])) stack.push([obj[i], Array.isArray(entry) ? parent : entry]);
            }
        }
    }
    function queueJSONText(text) {
        if (typeof text !== 'string' || text.length > CFG.maxNetworkText || text.length < 2) return;
        const trimmed = text.trimStart();
        if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
        // Ograniczenie backlogu, jezeli strona generuje nadmiar odpowiedzi.
        if (state.responseQueue.length >= 8) return;
        state.responseQueue.push(text);
        if (state.responseScheduled) return;
        state.responseScheduled = true;
        const run = () => {
            state.responseScheduled = false;
            const body = state.responseQueue.shift();
            if (body) { try { processJSON(JSON.parse(body)); } catch (_) { /* nie-JSON */ } }
            if (state.responseQueue.length) {
                state.responseScheduled = true;
                scheduleIdle(run);
            }
        };
        scheduleIdle(run);
    }
    function scheduleIdle(fn) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1700 });
        else setTimeout(fn, 0);
    }
    function allowedRequest(url) {
        try {
            const u = new URL(String(url), location.href);
            return u.protocol === 'https:' && (u.hostname === location.hostname);
        } catch (_) { return false; }
    }
    function isLikelyJSON(contentType, url) {
        if (/json/i.test(contentType || '')) return true;
        return /(?:api|graphql|appointment|research|results|search|purchase|order|item|shipment)/i.test(String(url));
    }
    // Bez pobierania calej wielomegabajtowej odpowiedzi do pamieci.
    async function readLimitedResponse(response) {
        const clone = response.clone();
        if (!clone.body || !clone.body.getReader) {
            const text = await clone.text();
            return text.length <= CFG.maxNetworkText ? text : null;
        }
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        let total = 0, text = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > CFG.maxNetworkText) { await reader.cancel(); return null; }
                text += decoder.decode(value, { stream: true });
            }
            return text + decoder.decode();
        } finally { try { reader.releaseLock(); } catch (_) { /* noop */ } }
    }
    function installNetworkCapture() {
        // @sandbox raw: przechwytujemy wywolania w kontekscie strony (MAIN_WORLD).
        if (typeof window.fetch === 'function' && !window.fetch.__dmFastWrapped) {
            const original = window.fetch;
            const wrapped = function (...args) {
                const req = args[0];
                const url = typeof req === 'string' ? req : req && req.url;
                const result = original.apply(this, args);
                if (!allowedRequest(url)) return result;
                return result.then(response => {
                    try {
                        const type = response.headers?.get('content-type') || '';
                        const size = Number(response.headers?.get('content-length') || 0);
                        if (response.ok && isLikelyJSON(type, url) && (!size || size <= CFG.maxNetworkText)) {
                            readLimitedResponse(response).then(queueJSONText).catch(() => {});
                        }
                    } catch (_) { /* nie ingerujemy w zachowanie strony */ }
                    return response;
                });
            };
            wrapped.__dmFastWrapped = true;
            window.fetch = wrapped;
        }
        const proto = XMLHttpRequest.prototype;
        if (!proto.open.__dmFastWrapped) {
            const originalOpen = proto.open;
            const originalSend = proto.send;
            proto.open = function (...args) {
                this.__dmFastURL = args[1];
                return originalOpen.apply(this, args);
            };
            proto.open.__dmFastWrapped = true;
            proto.send = function (...args) {
                if (allowedRequest(this.__dmFastURL)) {
                    this.addEventListener('load', function () {
                        try {
                            if (!(this.status >= 200 && this.status < 300)) return;
                            if (!isLikelyJSON(this.getResponseHeader('content-type'), this.__dmFastURL)) return;
                            if (this.responseType === 'json') scheduleIdle(() => processJSON(this.response));
                            else if (this.responseType === '' || this.responseType === 'text') {
                                if (this.responseText.length <= CFG.maxNetworkText) queueJSONText(this.responseText);
                            }
                        } catch (_) { /* nie zmieniamy odpowiedzi aplikacji */ }
                    }, { once: true });
                }
                return originalSend.apply(this, args);
            };
        }
    }
    installNetworkCapture();

    // ----- Kolejka zbierania: bez kasowania poprzednich ASIN i bez falszywego DONE -----
    const readJob = () => {
        const job = GM_getValue(CFG.keyJob, null);
        return job && typeof job === 'object' && Array.isArray(job.queue) ? job : null;
    };
    function writeJob(job) { GM_setValue(CFG.keyJob, job); scheduleRender(); }
    function modifyJob(fn) {
        const job = readJob();
        if (!job) return null;
        const next = fn(job);
        if (next) writeJob(next);
        return next;
    }
    function newJob(isaList) {
        return {
            id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
            queue: isaList, index: 0, results: {}, attempts: {},
            running: true, paused: false, startedAt: nowISO(), finishedAt: null
        };
    }
    function startCollect() {
        if (!isDock) return;
        runScan();
        if (readJob()?.running) { alert('Zbieranie juz trwa. Uzyj Pause/Resume lub Stop.'); return; }
        const mode = state.dom.mode.value;
        let list = mode === 'visible' ? [...state.visibleISA] : Object.keys(state.isa);
        list = list.map(parseISA).filter(Boolean);
        if (mode === 'pending') list = list.filter(isa => !state.isa[isa]?.collected);
        list = [...new Set(list)].sort();
        if (!list.length) { alert('Nie znaleziono ISA dla wybranego zakresu. Otworz appointmenty lub zmien zakres.'); return; }
        const job = newJob(list);
        writeJob(job);
        const tab = window.open(fcUrl(list[0], job.id), 'dm_fc_asin_collector_v6');
        if (!tab) {
            job.running = false; job.finishedAt = nowISO();
            writeJob(job);
            alert('Przegladarka zablokowala karte FC Research. Zezwol na pop-upy i sproboj ponownie.');
            return;
        }
        try { tab.focus(); } catch (_) { /* noop */ }
    }
    function pauseResume() {
        const job = readJob();
        if (!job || job.index >= job.queue.length) return;
        if (job.running && !job.paused) {
            job.paused = true; writeJob(job); return;
        }
        job.running = true; job.paused = false;
        writeJob(job);
        const tab = window.open(fcUrl(job.queue[job.index], job.id), 'dm_fc_asin_collector_v6');
        if (!tab) { job.paused = true; writeJob(job); alert('Zezwol na pop-upy dla DockMaster.'); }
    }
    function stopCollect() {
        modifyJob(job => {
            if (!job.running) return null;
            job.running = false; job.paused = false; job.finishedAt = nowISO();
            return job;
        });
    }
    function queueEvaluateSoon() {
        if (!isCollector()) return;
        setTimeout(() => { if (document.body) checkCollector(); }, 120);
    }
    let activePage = '', activeSince = 0, checkBusy = false, lastTableSignature = '', stableSince = 0;
    function tableSignature() {
        const table = document.querySelector('#table-purchase-order-item');
        if (!table) return 'none';
        const rows = table.querySelectorAll('tbody tr');
        const firstRow = rows[0]?.textContent || '';
        const lastRow = rows[rows.length - 1]?.textContent || '';
        return rows.length + '|' + firstRow.slice(0, 160) + '|' + lastRow.slice(-160);
    }
    function finishItem(ok, reason = '') {
        if (checkBusy) return;
        checkBusy = true;
        const isa = currentISA();
        const jobId = new URL(location.href).searchParams.get('dmJob');
        const job = readJob();
        if (!job || !job.running || job.paused || job.id !== jobId || job.queue[job.index] !== isa) {
            checkBusy = false; return;
        }
        if (!ok && (job.attempts[isa] || 0) + 1 < CFG.queueMaxAttempts) {
            job.attempts[isa] = (job.attempts[isa] || 0) + 1;
            writeJob(job);
            location.replace(fcUrl(isa, job.id) + '&try=' + job.attempts[isa]);
            return;
        }
        if (ok) patchISA(isa, { collected: true });
        flush(); // Przed zmiana strony zapis wynikow.
        job.results[isa] = { state: ok ? 'done' : 'error', reason, at: nowISO() };
        job.index++;
        if (job.index >= job.queue.length) {
            job.running = false; job.finishedAt = nowISO();
            writeJob(job);
            document.title = 'DockMaster: ' + (Object.values(job.results).filter(x => x.state === 'error').length ? 'DONE (errors)' : 'DONE');
            checkBusy = false;
            // Nie zamykamy karty automatycznie: operator moze sprawdzic wynik.
        } else {
            writeJob(job);
            location.replace(fcUrl(job.queue[job.index], job.id));
        }
    }
    function checkCollector() {
        if (!isCollector() || checkBusy) return;
        const job = readJob();
        const isa = currentISA();
        const urlJobId = new URL(location.href).searchParams.get('dmJob');
        if (!job || !job.running || job.paused || job.id !== urlJobId || job.queue[job.index] !== isa) return;
        const pageKey = urlJobId + '|' + isa + '|' + (new URL(location.href).searchParams.get('try') || '0');
        if (activePage !== pageKey) {
            activePage = pageKey; activeSince = Date.now();
            state.tableChangeAt = Date.now(); lastTableSignature = ''; stableSince = Date.now();
        }
        const signature = tableSignature();
        if (signature !== lastTableSignature) {
            lastTableSignature = signature;
            stableSince = Date.now();
            scheduleScan(0);
        }
        const rows = state.tableStats.isa === isa ? state.tableStats.validRows : 0;
        const stableFor = Date.now() - Math.max(stableSince, state.tableChangeAt);
        const elapsed = Date.now() - activeSince;
        if (rows > 0 && stableFor >= CFG.queueStableMs && elapsed >= CFG.queueMinMs && !state.scanning) {
            finishItem(true);
        } else if (elapsed >= CFG.queueTimeoutMs) {
            finishItem(false, rows ? 'Tabela nie ustabilizowala sie' : 'Brak potwierdzonych wierszy ASIN');
        }
    }
    function installCollector() {
        if (!isCollector()) return;
        if (state.jobTimer) return;
        state.jobTimer = setInterval(checkCollector, CFG.queueCheckMs);
        window.addEventListener('pagehide', () => clearInterval(state.jobTimer), { once: true });
        setTimeout(checkCollector, 400);
    }

    // ----- Hazmat: paczki po 50, indeks ASIN zamiast zagniezdzonej petli -----
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    function hazmatRequest(batch) {
        const data = new URLSearchParams({
            language: 'default', source: 'retail-rbs', marketPlaces: 'PL,DE',
            asins: batch.join('\n'), sidx: 'product.asin', rows: '99999',
            page: '1', sord: 'desc', isExportOnly: 'FALSE',
            fileName: 'dockmaster_hazmat', fc: '', pandashservice: ''
        }).toString();
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url: CFG.hazmatURL, timeout: 30000,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                           'X-Requested-With': 'XMLHttpRequest' },
                data,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error('HTTP ' + response.status)); return;
                    }
                    try {
                        const result = JSON.parse(response.responseText);
                        if (!Array.isArray(result.rows)) throw new Error('Nieprawidlowy format Pandash');
                        resolve(result.rows);
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('Brak polaczenia z Pandash')),
                ontimeout: () => reject(new Error('Timeout Pandash'))
            });
        });
    }
    async function collectHazmat() {
        if (state.hazmatBusy) { state.hazmatStop = true; state.hazmatMessage = 'Zatrzymywanie Hazmat po biezacej paczce...'; scheduleRender(); return; }
        flush();
        const all = [...state.uniqueASINs];
        if (!all.length) { alert('Brak ASIN. Najpierw zbierz ASIN z FC Research.'); return; }
        const onlyMissing = state.dom.hazmatMissing.checked;
        const selected = onlyMissing ? all.filter(asin => {
            const keys = state.asinIndex.get(asin) || [];
            return [...keys].some(k => !state.asins[k]?.hazmatLevelPL || !state.asins[k]?.hazmatLevelDE);
        }) : all;
        if (!selected.length) { alert('Wszystkie ASIN maja juz Hazmat PL i DE.'); return; }
        state.hazmatBusy = true; state.hazmatStop = false;
        let errors = 0, saved = 0;
        try {
            for (let i = 0; i < selected.length && !state.hazmatStop; i += 50) {
                state.hazmatMessage = `Hazmat: ${Math.min(i + 50, selected.length)}/${selected.length}; bledy paczek: ${errors}`;
                scheduleRender();
                const batch = selected.slice(i, i + 50);
                let rows = null;
                for (let retry = 0; retry < 2; retry++) {
                    try { rows = await hazmatRequest(batch); break; }
                    catch (e) {
                        if (retry === 1) { errors++; console.warn('[DockMaster v6] Hazmat batch:', e.message); }
                        else await sleep(900);
                    }
                }
                if (!rows) continue;
                for (const row of rows) {
                    const asin = parseASIN(row.asin);
                    if (!asin) continue;
                    for (const key of state.asinIndex.get(asin) || []) {
                        if (patchASIN(asin, state.asins[key].isa, {
                            hazmatLevelPL: row.mp === 'PL' ? row.level : undefined,
                            hazmatLevelDE: row.mp === 'DE' ? row.level : undefined,
                            glName: row.glname, unCode: row.un, dropZone: row.dropZone
                        })) saved++;
                    }
                }
                flush();
                if (i + 50 < selected.length) await sleep(180);
            }
        } finally {
            state.hazmatBusy = false;
            state.hazmatMessage = state.hazmatStop ? 'Hazmat przerwany.' :
                `Hazmat zakonczony. Aktualizacje: ${saved}; nieudane paczki: ${errors}.`;
            scheduleRender();
        }
    }

    // ----- Eksport: CSV z poprawna liczba kolumn + kopia JSON -----
    const sortedISA = () => Object.values(state.isa).filter(x => x && parseISA(x.isa))
        .sort((a, b) => String(a.isa).localeCompare(String(b.isa), undefined, { numeric: true }));
    const sortedASIN = () => Object.values(state.asins).filter(x => x && parseASIN(x.asin))
        .sort((a, b) => (String(a.isa).localeCompare(String(b.isa))) || String(a.asin).localeCompare(String(b.asin)));
    function download(filename, contents, mime) {
        const link = document.createElement('a');
        const url = URL.createObjectURL(new Blob([contents], { type: mime }));
        link.href = url; link.download = filename; link.style.display = 'none';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    function csv(name, rows) {
        const quote = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        download('DockMaster_' + name + '_' + nowISO().slice(0, 10) + '.csv',
            '\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
    }
    function exportISA() {
        flush();
        csv('ISA', [['ISA', 'Pallets', 'Cartons', 'Units', 'ASIN Count', 'Collected'],
            ...sortedISA().map(row => [row.isa, row.pallets, row.cartons, row.units,
                state.asinByISA.get(row.isa)?.size || 0, row.collected ? 'YES' : 'NO'])]);
    }
    function exportASIN() {
        flush();
        csv('ASIN', [['ISA', 'ASIN', 'Not Received - Unfilled', 'Canceled', 'Received', 'Overage', 'Vendor Code', 'Source', 'Collected At'],
            ...sortedASIN().map(x => [x.isa, x.asin, x.unfilled, x.canceled, x.received, x.overage,
                x.vendorCode, x.source, x.discoveredAt])]);
    }
    function exportCombined() {
        flush();
        csv('ISA_ASIN', [['ISA', 'ASIN', 'Not Received - Unfilled', 'Canceled', 'Received', 'Overage', 'Vendor Code',
            'Hazmat PL', 'Hazmat DE', 'GL Name', 'UN', 'Drop Zone', 'ISA Units', 'Pallets', 'Cartons'],
            ...sortedASIN().map(x => {
                const isa = state.isa[x.isa] || {};
                return [x.isa, x.asin, x.unfilled, x.canceled, x.received, x.overage, x.vendorCode,
                    x.hazmatLevelPL, x.hazmatLevelDE, x.glName, x.unCode, x.dropZone,
                    isa.units, isa.pallets, isa.cartons];
            })]);
    }
    function exportBackup() {
        flush();
        download('DockMaster_backup_' + nowISO().replace(/[:.]/g, '-') + '.json',
            JSON.stringify({ version: '6.0.0', createdAt: nowISO(), isa: state.isa,
                asins: state.asins, collectionJob: readJob() }, null, 2), 'application/json;charset=utf-8');
    }
    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); }
        catch (_) {
            const input = document.createElement('textarea'); input.value = text;
            document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
        }
    }
    function clearData() {
        if (readJob()?.running) { alert('Najpierw zatrzymaj zbieranie.'); return; }
        if (prompt('Usunac wszystkie ISA/ASIN i historie kolejki? Wpisz USUN, aby potwierdzic.') !== 'USUN') return;
        flush();
        for (const key of [CFG.keyISA, CFG.keyASIN, CFG.keyJob,
            'dockmaster_collection_queue_v5', 'dockmaster_collection_status_v5']) GM_deleteValue(key);
        state.isa = {}; state.asins = {}; state.pendingISA.clear(); state.pendingASIN.clear();
        rebuildIndexes(); scheduleRender();
    }

    // ----- Lekki, zwijany panel: lista renderowana maksymalnie 100 wierszy na strone -----
    const PANEL_CSS = `
      :host { all: initial; font-family: Arial, sans-serif; font-size: 12px; color:#e9eef4; }
      * { box-sizing:border-box; }
      [hidden] { display:none!important; }
      .dm-panel { background:#1c2938; border:1px solid #43576c; border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.33); overflow:hidden; }
      button,select,input { font-family:inherit; font-size:12px; }
      button { cursor:pointer; border:0; border-radius:5px; padding:7px 9px; background:#f5a623; color:#132131; font-weight:700; }
      button:hover { filter:brightness(1.12); }
      button:disabled { opacity:.45; cursor:default; }
      .dm-head { width:100%; display:flex; align-items:center; justify-content:space-between; padding:11px 12px;
        background:#146eb4; color:white; text-align:left; border-radius:0; font-size:13px; }
      .dm-head small { opacity:.88; font-size:10px; }
      .dm-content { padding:11px; max-height:min(74vh,690px); overflow-y:auto; }
      .dm-muted { color:#bfd1df; }
      .dm-status { padding:9px; border-radius:6px; background:#2f4155; margin-bottom:9px; line-height:1.55; overflow-wrap:anywhere; }
      .dm-tools { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
      .dm-green { background:#40cc80; }
      .dm-blue { background:#b4dbfa; }
      .dm-red { background:#ff8290; }
      .dm-violet { background:#c6a4fa; }
      .dm-row { display:flex; gap:8px; align-items:center; justify-content:space-between;
        border-bottom:1px solid #3a4e62; padding:8px 0; }
      .dm-row button:first-child { background:none; color:white; text-align:left; font-weight:400;
        padding:3px; flex:1; overflow-wrap:anywhere; }
      .dm-row strong { font-size:12px; }
      .dm-row small { color:#b9cee1; font-size:11px; }
      input,select { width:100%; background:#314358; color:white; border:1px solid #61758a; padding:7px; border-radius:5px; }
      input::placeholder { color:#c0cfdb; }
      .dm-flex { display:flex; gap:6px; align-items:center; }
      .dm-flex > * { flex:1; }
      .dm-check { display:flex; align-items:center; gap:6px; margin:6px 0; color:#c6d5e1; }
      .dm-check input { width:auto; }
      .dm-more { width:100%; background:#425a70; color:white; margin-top:7px; }
      .dm-foot { font-size:10px; color:#a9c1d2; line-height:1.4; padding-top:7px; }
    `;
    function createPanel() {
        if (state.root || !document.body) return;
        const shell = document.createElement('div');
        shell.id = 'dm-v6-shell';
        shell.style.cssText = 'position:fixed;right:12px;top:92px;width:min(385px,calc(100vw - 24px));z-index:2147483647;';
        const shadow = shell.attachShadow({ mode: 'open' });
        const style = document.createElement('style'); style.textContent = PANEL_CSS; shadow.appendChild(style);
        const panel = document.createElement('div'); panel.className = 'dm-panel';
        panel.innerHTML = `
          <button type="button" class="dm-head" data-action="toggle"><span id="dm-title">📦 DockMaster Fast v6</span><small id="dm-arrow">▼</small></button>
          <div class="dm-content" id="dm-content" hidden>
            <div id="dm-status" class="dm-status" aria-live="polite"></div>
            <div class="dm-flex"><select id="dm-mode" title="Zakres ISA">
              <option value="visible">Widoczne na stronie</option>
              <option value="pending">Niezebrane (z historii)</option>
              <option value="all">Wszystkie zapisane ISA</option>
            </select></div>
            <div class="dm-tools" id="dm-job-tools">
              <button class="dm-green" data-action="collect">▶ Collect ASIN</button>
              <button class="dm-blue" data-action="pause">⏸ Pause / Resume</button>
              <button class="dm-red" data-action="stop">■ Stop</button>
            </div>
            <div class="dm-tools">
              <button data-action="copy">Copy ASIN</button><button data-action="asin">ASIN CSV</button>
              <button data-action="isa">ISA CSV</button><button data-action="combined">Combined CSV</button>
            </div>
            <label class="dm-check"><input type="checkbox" id="dm-hazmat-missing" checked>Hazmat: tylko brakujace PL/DE</label>
            <div class="dm-tools">
              <button class="dm-violet" id="dm-hazmat" data-action="hazmat">Collect Hazmat</button>
              <button class="dm-blue" data-action="scan">Scan</button>
              <button class="dm-blue" data-action="backup">Kopia JSON</button>
              <button class="dm-red" data-action="clear">Clear all</button>
            </div>
            <div class="dm-muted" id="dm-hazmat-msg" role="status"></div>
            <input id="dm-filter" placeholder="Filtruj ISA (11 cyfr)..." aria-label="Filtruj ISA">
            <div id="dm-list"></div>
            <button id="dm-more" class="dm-more" data-action="more" hidden>Pokaz kolejne 100</button>
            <div class="dm-foot">v6 Fast · Dane lokalne Tampermonkey · Stare dane v5 zachowane</div>
          </div>`;
        shadow.appendChild(panel);
        document.body.appendChild(shell);
        state.root = shadow;
        const $ = sel => shadow.querySelector(sel);
        state.dom = {
            head: $('#dm-title'), arrow: $('#dm-arrow'), content: $('#dm-content'),
            status: $('#dm-status'), list: $('#dm-list'), filter: $('#dm-filter'),
            mode: $('#dm-mode'), more: $('#dm-more'), hazmat: $('#dm-hazmat'),
            hazmatMissing: $('#dm-hazmat-missing'), hazmatMsg: $('#dm-hazmat-msg'),
            jobTools: $('#dm-job-tools')
        };
        state.dom.content.hidden = !state.panelOpen;
        state.dom.arrow.textContent = state.panelOpen ? '▲' : '▼';
        state.dom.jobTools.hidden = !isDock;
        shadow.addEventListener('click', event => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            const action = button.dataset.action;
            const isa = button.dataset.isa;
            if (action === 'toggle') {
                state.panelOpen = !state.panelOpen;
                GM_setValue(CFG.keyOpen, state.panelOpen);
                state.dom.content.hidden = !state.panelOpen;
                state.dom.arrow.textContent = state.panelOpen ? '▲' : '▼';
                if (state.panelOpen) { scheduleScan(0); scheduleRender(); }
            } else if (action === 'collect') startCollect();
            else if (action === 'pause') pauseResume();
            else if (action === 'stop') stopCollect();
            else if (action === 'copy') copyText([...state.uniqueASINs].sort().join('\n'));
            else if (action === 'asin') exportASIN();
            else if (action === 'isa') exportISA();
            else if (action === 'combined') exportCombined();
            else if (action === 'hazmat') collectHazmat();
            else if (action === 'scan') runScan();
            else if (action === 'backup') exportBackup();
            else if (action === 'clear') clearData();
            else if (action === 'more') { state.shown += CFG.maxRenderRows; scheduleRender(); }
            else if (action === 'open' && isa) window.open(fcUrl(isa), '_blank');
            else if (action === 'copyisa' && isa) copyText(isa);
        });
        state.dom.filter.addEventListener('input', () => {
            state.filter = state.dom.filter.value.trim(); state.shown = CFG.maxRenderRows; scheduleRender();
        });
        scheduleRender();
    }
    function rowButton(text, action, isa) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.action = action;
        if (isa) button.dataset.isa = isa;
        button.textContent = text;
        return button;
    }
    function scheduleRender() {
        if (state.renderTimer) return;
        state.renderTimer = setTimeout(renderPanel, 420);
    }
    function renderPanel() {
        state.renderTimer = 0;
        if (!state.dom) return;
        const countISA = Object.keys(state.isa).length;
        const job = readJob();
        state.dom.head.textContent = `📦 ISA ${countISA} | ASIN ${state.uniqueASINs.size} · v6`;
        if (!state.panelOpen) return; // Nie renderujemy setek wierszy w zamknietym panelu.
        if (job) {
            const done = Object.values(job.results || {}).filter(x => x.state === 'done').length;
            const errors = Object.values(job.results || {}).filter(x => x.state === 'error').length;
            const current = job.running ? job.queue[job.index] : '-';
            state.dom.status.textContent =
                `Kolejka: ${job.running ? (job.paused ? 'PAUZA' : 'ZBIERANIE') : 'STOP / KONIEC'} | ` +
                `${job.index}/${job.queue.length} | OK: ${done} | Bledy: ${errors} | ISA: ${current}`;
        } else {
            state.dom.status.textContent = `ISA: ${countISA} | Unikalne ASIN: ${state.uniqueASINs.size}`;
        }
        state.dom.hazmat.textContent = state.hazmatBusy ? 'Stop Hazmat' : 'Collect Hazmat';
        state.dom.hazmatMsg.textContent = state.hazmatMessage;
        const records = sortedISA().filter(x => !state.filter || String(x.isa).includes(state.filter));
        const fragment = document.createDocumentFragment();
        for (const record of records.slice(0, state.shown)) {
            const row = document.createElement('div'); row.className = 'dm-row';
            const detail = rowButton('', 'open', record.isa);
            const strong = document.createElement('strong');
            strong.textContent = record.isa + (record.collected ? ' ✓' : '');
            const small = document.createElement('small');
            small.textContent = `P:${record.pallets ?? '?'} C:${record.cartons ?? '?'} U:${record.units ?? '?'} | ASIN:${state.asinByISA.get(record.isa)?.size || 0}`;
            detail.append(strong, document.createElement('br'), small);
            const copy = rowButton('📋', 'copyisa', record.isa);
            row.append(detail, copy); fragment.appendChild(row);
        }
        if (!records.length) {
            const empty = document.createElement('p'); empty.className = 'dm-muted';
            empty.textContent = 'Brak ISA dla filtra. Otworz appointmenty w DockMaster lub uzyj Scan.';
            fragment.appendChild(empty);
        }
        state.dom.list.replaceChildren(fragment);
        state.dom.more.hidden = records.length <= state.shown;
    }

    // ----- Start tylko raz, a SPA/route obserwowane bez czestego setInterval skanow -----
    let didStart = false;
    function routeCheck() {
        if (location.href === state.route) return;
        state.route = location.href;
        state.tableStats = { isa: null, rows: 0, validRows: 0 };
        state.tableChangeAt = Date.now();
        scheduleScan(250);
        if (isCollector()) queueEvaluateSoon();
    }
    function start() {
        if (didStart || !document.body) return;
        didStart = true;
        createPanel();
        installObserver();
        scheduleScan(100);
        installCollector();
        window.addEventListener('popstate', routeCheck);
        window.addEventListener('hashchange', routeCheck);
        // Fallback dla routerow SPA bez popstate (15 s, bez skanowania DOM).
        const routeTimer = setInterval(routeCheck, 15000);
        window.addEventListener('pagehide', () => clearInterval(routeTimer), { once: true });
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('DockMaster v6: kopia danych JSON', exportBackup);
            GM_registerMenuCommand('DockMaster v6: otworz panel', () => {
                if (!state.panelOpen) state.root.querySelector('[data-action="toggle"]').click();
            });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    // Fallback przy niestandardowym DOMContentLoaded: idempotentny.
    setTimeout(start, 1400);

})();
