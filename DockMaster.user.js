// ==UserScript==
// @name         DockMaster + FC Research Collector
// @namespace    dockmaster-fc-research
// @version      5.1
// @updateURL    https://raw.githubusercontent.com/bernardbajv-nijit/Nijit/main/DockMaster.user.js
// @downloadURL  https://raw.githubusercontent.com/bernardbajv-nijit/Nijit/main/DockMaster.user.js
// @description  Zbiera ISA z DockMaster, otwiera FC Research i kolekcjonuje ASIN-y
// @match        https://dockmaster.eu.aftx.amazonoperations.app/*
// @match        https://qifcr.eu.aftx.amazonoperations.app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      pandash.eu.aftx.amazonoperations.app
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /******************************************************************
     * KONFIGURACJA
     ******************************************************************/

    const CONFIG = {
        warehouseId: 'XDR1',

        fcResearchBaseUrl:
            'https://qifcr.eu.aftx.amazonoperations.app/XDR1/results?s=',

        dockMasterHost:
            'dockmaster.eu.aftx.amazonoperations.app',

        fcResearchHost:
            'qifcr.eu.aftx.amazonoperations.app',

        collectionDelay: 1800,

        pageScanInterval: 2500,

        fcResearchWaitTime: 7000,

        storageKeys: {
            isaRecords: 'dockmaster_isa_records_v5',
            asinRecords: 'dockmaster_asin_records_v5',
            collectionQueue: 'dockmaster_collection_queue_v5',
            collectionStatus: 'dockmaster_collection_status_v5',
            updateTime: 'dockmaster_update_time_v5'
        }
    };

    const IS_DOCKMASTER =
        location.hostname === CONFIG.dockMasterHost;

    const IS_FC_RESEARCH =
        location.hostname === CONFIG.fcResearchHost;

    let widgetCreated = false;
    let refreshTimer = null;
    let scanInProgress = false;
    let lastUrl = location.href;

    console.log(
        '[DM+FC COLLECTOR] Start:',
        IS_DOCKMASTER ? 'DockMaster' : 'FC Research'
    );

    /******************************************************************
     * NARZĘDZIA PODSTAWOWE
     ******************************************************************/

    function log() {
        const args = Array.from(arguments);

        console.log.apply(
            console,
            ['[DM+FC COLLECTOR]'].concat(args)
        );
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);

        refreshTimer = setTimeout(function () {
            refreshWidget();
        }, 150);
    }

    function parseNumber(value) {
        if (
            value === null ||
            value === undefined ||
            value === ''
        ) {
            return null;
        }

        if (
            typeof value === 'number' &&
            Number.isFinite(value)
        ) {
            return value;
        }

        const cleaned = String(value)
            .replace(/\s/g, '')
            .replace(/,/g, '');

        const match = cleaned.match(/\d+/);

        if (!match) {
            return null;
        }

        const number = Number(match[0]);

        return Number.isFinite(number)
            ? number
            : null;
    }

    function parseISA(value) {
        if (
            value === null ||
            value === undefined
        ) {
            return null;
        }

        const text = String(value).trim();
        const match = text.match(
            /(?:^|\D)(\d{11})(?:\D|$)/
        );

        return match ? match[1] : null;
    }

    function parseASIN(value) {
        if (
            value === null ||
            value === undefined
        ) {
            return null;
        }

        const text = String(value)
            .trim()
            .toUpperCase();

        /*
         * Najczęstszy format ASIN:
         * B + 9 cyfr/liter, łącznie 10 znaków.
         */
        const bAsinMatch = text.match(
            /(?:^|[^A-Z0-9])(B[A-Z0-9]{9})(?:[^A-Z0-9]|$)/
        );

        if (bAsinMatch) {
            return bAsinMatch[1];
        }

        return null;
    }

    function getCurrentISAFromUrl() {
        try {
            const url = new URL(location.href);
            const searchValue = url.searchParams.get('s');

            return parseISA(searchValue);
        } catch (error) {
            return null;
        }
    }

    function escapeCSV(value) {
        const text =
            value === null ||
            value === undefined
                ? ''
                : String(value);

        return '"' +
            text.replace(/"/g, '""') +
            '"';
    }

    async function copyText(text) {
        if (
            navigator.clipboard &&
            window.isSecureContext
        ) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch (error) {
                log('Clipboard API niedostępne:', error);
            }
        }

        const textarea =
            document.createElement('textarea');

        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';

        document.body.appendChild(textarea);

        textarea.focus();
        textarea.select();

        document.execCommand('copy');

        textarea.remove();
    }

    function downloadCSV(filename, rows) {
        const csv =
            '\uFEFF' +
            rows
                .map(function (row) {
                    return row
                        .map(escapeCSV)
                        .join(';');
                })
                .join('\r\n');

        const blob = new Blob(
            [csv],
            {
                type: 'text/csv;charset=utf-8'
            }
        );

        const url =
            URL.createObjectURL(blob);

        const link =
            document.createElement('a');

        link.href = url;
        link.download = filename;

        document.body.appendChild(link);

        link.click();
        link.remove();

        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    /******************************************************************
     * STORAGE
     ******************************************************************/

    function readISARecords() {
        const stored = GM_getValue(
            CONFIG.storageKeys.isaRecords,
            {}
        );

        return stored &&
            typeof stored === 'object'
                ? stored
                : {};
    }

    function writeISARecords(records) {
        GM_setValue(
            CONFIG.storageKeys.isaRecords,
            records
        );

        GM_setValue(
            CONFIG.storageKeys.updateTime,
            Date.now()
        );
    }

    function readASINRecords() {
        const stored = GM_getValue(
            CONFIG.storageKeys.asinRecords,
            {}
        );

        return stored &&
            typeof stored === 'object'
                ? stored
                : {};
    }

    function writeASINRecords(records) {
        GM_setValue(
            CONFIG.storageKeys.asinRecords,
            records
        );

        GM_setValue(
            CONFIG.storageKeys.updateTime,
            Date.now()
        );
    }

    function readQueue() {
        const queue = GM_getValue(
            CONFIG.storageKeys.collectionQueue,
            []
        );

        return Array.isArray(queue)
            ? queue
            : [];
    }

    function writeQueue(queue) {
        GM_setValue(
            CONFIG.storageKeys.collectionQueue,
            queue
        );

        GM_setValue(
            CONFIG.storageKeys.updateTime,
            Date.now()
        );
    }

    function readCollectionStatus() {
        return GM_getValue(
            CONFIG.storageKeys.collectionStatus,
            {
                running: false,
                total: 0,
                completed: 0,
                currentISA: null,
                startedAt: null,
                finishedAt: null
            }
        );
    }

    function writeCollectionStatus(status) {
        GM_setValue(
            CONFIG.storageKeys.collectionStatus,
            status
        );

        GM_setValue(
            CONFIG.storageKeys.updateTime,
            Date.now()
        );
    }
/******************************************************************
 * ODCZYT, SORTOWANIE I PODSUMOWANIE DANYCH
 ******************************************************************/

function getSortedISARecords() {
    const records = readISARecords();

    return Object.values(records)
        .filter(function (record) {
            return (
                record &&
                record.isa &&
                parseISA(record.isa)
            );
        })
        .sort(function (a, b) {
            return String(a.isa).localeCompare(
                String(b.isa),
                undefined,
                {
                    numeric: true
                }
            );
        });
}

function getSortedASINRecords() {
    const records = readASINRecords();

    return Object.values(records)
        .filter(function (record) {
            return (
                record &&
                record.isa &&
                record.asin &&
                parseASIN(record.asin)
            );
        })
        .sort(function (a, b) {
            const isaComparison =
                String(a.isa).localeCompare(
                    String(b.isa),
                    undefined,
                    {
                        numeric: true
                    }
                );

            if (isaComparison !== 0) {
                return isaComparison;
            }

            return String(a.asin).localeCompare(
                String(b.asin)
            );
        });
}

function getUniqueASINs() {
    const uniqueASINs = new Set();

    getSortedASINRecords()
        .forEach(function (record) {
            const asin = parseASIN(
                record.asin
            );

            if (asin) {
                uniqueASINs.add(asin);
            }
        });

    return Array.from(uniqueASINs)
        .sort(function (a, b) {
            return String(a).localeCompare(
                String(b)
            );
        });
}

function getASINCountForISA(isa) {
    const normalizedISA =
        parseISA(isa);

    if (!normalizedISA) {
        return 0;
    }

    const uniqueASINs = new Set();

    getSortedASINRecords()
        .forEach(function (record) {
            if (
                record.isa !==
                normalizedISA
            ) {
                return;
            }

            const asin = parseASIN(
                record.asin
            );

            if (asin) {
                uniqueASINs.add(asin);
            }
        });

    return uniqueASINs.size;
}
    /******************************************************************
     * ZAPIS ISA
     ******************************************************************/

    function saveISA(
        isa,
        pallets,
        cartons,
        units
    ) {
        isa = parseISA(isa);

        if (!isa) {
            return false;
        }

        const records = readISARecords();

        const previous =
            records[isa] || {
                isa: isa,
                pallets: null,
                cartons: null,
                units: null,
                collected: false,
                discoveredAt: null,
                updatedAt: null
            };

        const updated = {
            isa: isa,

            pallets:
                pallets !== null &&
                pallets !== undefined
                    ? pallets
                    : previous.pallets,

            cartons:
                cartons !== null &&
                cartons !== undefined
                    ? cartons
                    : previous.cartons,

            units:
                units !== null &&
                units !== undefined
                    ? units
                    : previous.units,

            collected:
                previous.collected || false,

            discoveredAt:
                previous.discoveredAt ||
                new Date().toISOString(),

            updatedAt:
                new Date().toISOString()
        };

        const changed =
            !records[isa] ||
            previous.pallets !== updated.pallets ||
            previous.cartons !== updated.cartons ||
            previous.units !== updated.units;

        records[isa] = updated;
        writeISARecords(records);

        if (changed) {
            log('Zapisano ISA:', updated);
            scheduleRefresh();
        }

        return changed;
    }

    function markISACollected(isa) {
        const records = readISARecords();

        if (!records[isa]) {
            records[isa] = {
                isa: isa,
                pallets: null,
                cartons: null,
                units: null,
                discoveredAt:
                    new Date().toISOString()
            };
        }

        records[isa].collected = true;
        records[isa].collectedAt =
            new Date().toISOString();

        writeISARecords(records);
    }

    /******************************************************************
     * ZAPIS ASIN
     ******************************************************************/
function saveASIN(
    asin,
    isa,
    source,
    unfilled,
    canceled,
    received,
    overage
) {
    asin = parseASIN(asin);

    if (!asin) {
        return false;
    }

    isa = parseISA(isa) || 'UNKNOWN';

    const parsedUnfilled = parseNumber(unfilled);
    const parsedCanceled = parseNumber(canceled);
    const parsedReceived = parseNumber(received);
    const parsedOverage = parseNumber(overage);

    const records = readASINRecords();
    const uniqueKey = isa + '::' + asin;
    const previous = records[uniqueKey] || null;

    const updated = {
        asin: asin,
        isa: isa,

        /*
         * Jeszcze nieprzyjęte jednostki.
         * Kolumna Unfilled.
         */
        unfilled:
            parsedUnfilled !== null
                ? parsedUnfilled
                : previous &&
                  previous.unfilled !== undefined
                    ? previous.unfilled
                    : null,

        /*
         * Anulowane jednostki.
         * Kolumna Canceled.
         */
        canceled:
            parsedCanceled !== null
                ? parsedCanceled
                : previous &&
                  previous.canceled !== undefined
                    ? previous.canceled
                    : null,

        /*
         * Przyjęte jednostki.
         * Kolumna Received.
         */
        received:
            parsedReceived !== null
                ? parsedReceived
                : previous &&
                  previous.received !== undefined
                    ? previous.received
                    : null,

        /*
         * Jednostki overage.
         * Kolumna Overaged.
         */
        overage:
            parsedOverage !== null
                ? parsedOverage
                : previous &&
                  previous.overage !== undefined
                    ? previous.overage
                    : null,
       hazmatLevelPL:
    previous &&
    previous.hazmatLevelPL !== undefined
        ? previous.hazmatLevelPL
        : '',

hazmatLevelDE:
    previous &&
    previous.hazmatLevelDE !== undefined
        ? previous.hazmatLevelDE
        : '',

glName:
    previous &&
    previous.glName !== undefined
        ? previous.glName
        : '',

unCode:
    previous &&
    previous.unCode !== undefined
        ? previous.unCode
        : '',

dropZone:
    previous &&
    previous.dropZone !== undefined
        ? previous.dropZone
        : '',
        source:
            source ||
            (
                previous &&
                previous.source
                    ? previous.source
                    : 'FC Research'
            ),

        discoveredAt:
            previous &&
            previous.discoveredAt
                ? previous.discoveredAt
                : new Date().toISOString(),

        updatedAt:
            new Date().toISOString()
    };

    /*
     * Zachowujemy również pole units dla kompatybilności
     * ze starszymi fragmentami skryptu.
     *
     * units oznacza teraz Unfilled konkretnego ASIN-u.
     */
    updated.units = updated.unfilled;

    const changed =
        !previous ||
        previous.unfilled !== updated.unfilled ||
        previous.canceled !== updated.canceled ||
        previous.received !== updated.received ||
        previous.overage !== updated.overage;

    records[uniqueKey] = updated;

    writeASINRecords(records);

    if (changed) {
        log(
            'ASIN:',
            asin,
            'ISA:',
            isa,
            'Unfilled:',
            updated.unfilled,
            'Canceled:',
            updated.canceled,
            'Received:',
            updated.received,
            'Overage:',
            updated.overage
        );

        scheduleRefresh();
    }

    return changed;
}

    /******************************************************************
     * WYSZUKIWANIE P/C/U W JSON
     ******************************************************************/

    function normalizeKey(key) {
        return String(key)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    function findNumber(object, possibleKeys) {
        if (
            !object ||
            typeof object !== 'object'
        ) {
            return null;
        }

        const wantedKeys =
            possibleKeys.map(normalizeKey);

        for (
            const [key, value]
            of Object.entries(object)
        ) {
            if (
                wantedKeys.includes(
                    normalizeKey(key)
                )
            ) {
                const parsed =
                    parseNumber(value);

                if (parsed !== null) {
                    return parsed;
                }
            }
        }

        return null;
    }

    function findISAInObject(object) {
        if (
            !object ||
            typeof object !== 'object'
        ) {
            return null;
        }

        const preferredKeys = [
            'inboundShipmentAppointmentId',
            'shipmentAppointmentId',
            'inboundAppointmentId',
            'appointmentId',
            'isaId',
            'isa'
        ];

        for (
            const preferredKey
            of preferredKeys
        ) {
            for (
                const [key, value]
                of Object.entries(object)
            ) {
                if (
                    key.toLowerCase() ===
                    preferredKey.toLowerCase()
                ) {
                    const isa =
                        parseISA(value);

                    if (isa) {
                        return isa;
                    }
                }
            }
        }

        for (
            const [key, value]
            of Object.entries(object)
        ) {
            const lowerKey =
                key.toLowerCase();

            if (
                lowerKey.includes(
                    'appointment'
                ) ||
                lowerKey === 'isa' ||
                lowerKey.includes('isaid')
            ) {
                const isa =
                    parseISA(value);

                if (isa) {
                    return isa;
                }
            }
        }

        return null;
    }

    /******************************************************************
     * WYSZUKIWANIE ASIN W JSON
     ******************************************************************/

  function extractASINFromObject(object, currentISA) {
    if (
        !object ||
        typeof object !== 'object' ||
        Array.isArray(object)
    ) {
        return;
    }

    const unfilled = findNumber(object, [
        'unfilled',
        'unfilledQuantity',
        'unfilledUnits',
        'openQuantity',
        'openQty',
        'remainingQuantity',
        'remainingUnits'
    ]);

    const canceled = findNumber(object, [
        'canceled',
        'cancelled',
        'canceledQuantity',
        'cancelledQuantity',
        'canceledUnits',
        'cancelledUnits'
    ]);

    const received = findNumber(object, [
        'received',
        'receivedQuantity',
        'receivedUnits',
        'receivedQty',
        'quantityReceived'
    ]);

    const overage = findNumber(object, [
        'overaged',
        'overage',
        'overagedQuantity',
        'overageQuantity',
        'overagedUnits',
        'overageUnits',
        'overReceived',
        'overReceivedQuantity'
    ]);

    const foundASINs = new Set();

    for (const [key, value] of Object.entries(object)) {
        const normalized = normalizeKey(key);

        const isASINKey =
            normalized === 'asin' ||
            normalized === 'asins' ||
            normalized === 'productasin' ||
            normalized === 'itemasin' ||
            normalized === 'childasin' ||
            normalized === 'parentasin' ||
            normalized === 'sku' ||
            normalized.includes('asin');

        if (!isASINKey) {
            continue;
        }

        if (Array.isArray(value)) {
            value.forEach(function (item) {
                if (
                    typeof item === 'string' ||
                    typeof item === 'number'
                ) {
                    const asin = parseASIN(item);

                    if (asin) {
                        foundASINs.add(asin);
                    }
                }
            });

            continue;
        }

        if (
            typeof value === 'string' ||
            typeof value === 'number'
        ) {
            const asin = parseASIN(value);

            if (asin) {
                foundASINs.add(asin);
            }
        }
    }

    foundASINs.forEach(function (asin) {
        saveASIN(
            asin,
            currentISA,
            'FC Research API',
            unfilled,
            canceled,
            received,
            overage
        );
    });
}
    /******************************************************************
     * REKURENCYJNE PRZESZUKIWANIE JSON
     ******************************************************************/

    function processJSONData(
        data,
        parentObject,
        visited
    ) {
        if (
            data === null ||
            data === undefined ||
            typeof data !== 'object'
        ) {
            return;
        }

        parentObject =
            parentObject || null;

        visited =
            visited || new WeakSet();

        if (visited.has(data)) {
            return;
        }

        visited.add(data);

        if (Array.isArray(data)) {
            data.forEach(function (item) {
                processJSONData(
                    item,
                    parentObject,
                    visited
                );
            });

            return;
        }

        if (IS_DOCKMASTER) {
            const isa =
                findISAInObject(data);

            if (isa) {
                let pallets =
                    findNumber(data, [
                        'palletCount',
                        'palletsCount',
                        'palletQuantity',
                        'numberOfPallets',
                        'totalPallets',
                        'pallets'
                    ]);

                let cartons =
                    findNumber(data, [
                        'cartonCount',
                        'cartonsCount',
                        'cartonQuantity',
                        'numberOfCartons',
                        'totalCartons',
                        'caseCount',
                        'cases',
                        'cartons'
                    ]);

                let units =
                    findNumber(data, [
                        'unitCount',
                        'unitsCount',
                        'unitQuantity',
                        'numberOfUnits',
                        'totalUnits',
                        'expectedUnits',
                        'quantity',
                        'units'
                    ]);

                if (parentObject) {
                    if (pallets === null) {
                        pallets =
                            findNumber(
                                parentObject,
                                [
                                    'palletCount',
                                    'palletsCount',
                                    'totalPallets',
                                    'pallets'
                                ]
                            );
                    }

                    if (cartons === null) {
                        cartons =
                            findNumber(
                                parentObject,
                                [
                                    'cartonCount',
                                    'cartonsCount',
                                    'caseCount',
                                    'totalCartons',
                                    'cartons'
                                ]
                            );
                    }

                    if (units === null) {
                        units =
                            findNumber(
                                parentObject,
                                [
                                    'unitCount',
                                    'unitsCount',
                                    'totalUnits',
                                    'quantity',
                                    'units'
                                ]
                            );
                    }
                }

                saveISA(
                    isa,
                    pallets,
                    cartons,
                    units
                );
            }
        }

        if (IS_FC_RESEARCH) {
            const currentISA =
                getCurrentISAFromUrl();

            extractASINFromObject(
                data,
                currentISA
            );
        }

        Object.values(data)
            .forEach(function (value) {
                processJSONData(
                    value,
                    data,
                    visited
                );
            });
    }

    /******************************************************************
     * PRZETWARZANIE ODPOWIEDZI API
     ******************************************************************/

    function processResponseText(
        text,
        sourceUrl
    ) {
        if (
            !text ||
            typeof text !== 'string'
        ) {
            return;
        }

        try {
            const json = JSON.parse(text);

            processJSONData(json);

            return;
        } catch (error) {
            /*
             * Odpowiedź nie była JSON-em.
             */
        }

        if (IS_DOCKMASTER) {
            const isaMatches =
                text.match(/\b\d{11}\b/g);

            if (isaMatches) {
                Array.from(
                    new Set(isaMatches)
                ).forEach(function (isa) {
                    saveISA(
                        isa,
                        null,
                        null,
                        null
                    );
                });
            }
        }

        if (IS_FC_RESEARCH) {
            const currentISA =
                getCurrentISAFromUrl();

            const asinMatches =
                text
                    .toUpperCase()
                    .match(
                        /\bB[A-Z0-9]{9}\b/g
                    );

            if (asinMatches) {
                Array.from(
                    new Set(asinMatches)
                ).forEach(function (asin) {
                    saveASIN(
                        asin,
                        currentISA,
                        sourceUrl ||
                            'FC Research response'
                    );
                });
            }
        }
    }

    /******************************************************************
     * PRZECHWYTYWANIE FETCH
     ******************************************************************/

    function installFetchInterceptor() {
        if (
            typeof window.fetch !==
            'function'
        ) {
            return;
        }

        if (
            window.fetch
                .__dmFcCollectorWrapped
        ) {
            return;
        }

        const originalFetch =
            window.fetch;

        function wrappedFetch() {
            const args =
                Array.from(arguments);

            const requestUrl =
                typeof args[0] === 'string'
                    ? args[0]
                    : args[0] &&
                      args[0].url
                        ? args[0].url
                        : '';

            return originalFetch
                .apply(this, args)
                .then(function (response) {
                    try {
                        const clone =
                            response.clone();

                        clone.text()
                            .then(function (
                                text
                            ) {
                                processResponseText(
                                    text,
                                    requestUrl
                                );
                            })
                            .catch(
                                function () {}
                            );
                    } catch (error) {
                        log(
                            'Błąd FETCH:',
                            error
                        );
                    }

                    return response;
                });
        }

        wrappedFetch
            .__dmFcCollectorWrapped =
            true;

        window.fetch = wrappedFetch;

        log('FETCH interceptor aktywny');
    }

    /******************************************************************
     * PRZECHWYTYWANIE XHR
     ******************************************************************/

    function installXHRInterceptor() {
        if (
            XMLHttpRequest.prototype.open
                .__dmFcCollectorWrapped
        ) {
            return;
        }

        const originalOpen =
            XMLHttpRequest.prototype.open;

        const originalSend =
            XMLHttpRequest.prototype.send;

        function wrappedOpen(
            method,
            url
        ) {
            this.__dmFcCollectorUrl = url;

            return originalOpen.apply(
                this,
                arguments
            );
        }

        wrappedOpen
            .__dmFcCollectorWrapped =
            true;

        XMLHttpRequest.prototype.open =
            wrappedOpen;

        XMLHttpRequest.prototype.send =
            function () {
                this.addEventListener(
                    'load',
                    function () {
                        try {
                            if (
                                this.responseType ===
                                'json'
                            ) {
                                processJSONData(
                                    this.response
                                );

                                return;
                            }

                            if (
                                this.responseType ===
                                    '' ||
                                this.responseType ===
                                    'text'
                            ) {
                                processResponseText(
                                    this.responseText,
                                    this
                                        .__dmFcCollectorUrl
                                );
                            }
                        } catch (error) {
                            log(
                                'Błąd XHR:',
                                error
                            );
                        }
                    }
                );

                return originalSend.apply(
                    this,
                    arguments
                );
            };

        log('XHR interceptor aktywny');
    }

    /******************************************************************
     * SKANOWANIE DOCKMASTER
     ******************************************************************/

    function scanDockMasterPage() {
        if (
            !IS_DOCKMASTER ||
            !document.body ||
            scanInProgress
        ) {
            return;
        }

        scanInProgress = true;

        try {
            const selectors = [
                'tr',
                'li',
                'article',
                '[role="row"]',
                '[role="gridcell"]',
                '[class*="card"]',
                '[class*="appointment"]',
                '[data-testid]'
            ].join(',');

            const elements =
                document.querySelectorAll(
                    selectors
                );

            elements.forEach(function (
                element
            ) {
                if (
                    element.id ===
                        'dm-fc-widget' ||
                    element.closest(
                        '#dm-fc-widget'
                    )
                ) {
                    return;
                }

                const text =
                    element.innerText ||
                    element.textContent ||
                    '';

                const isaMatch =
                    text.match(
                        /\b(\d{11})\b/
                    );

                if (!isaMatch) {
                    return;
                }

                const palletMatch =
                    text.match(
                        /(?:pallets?|plt|p)\s*[:\-]?\s*(\d+)/i
                    );

                const cartonMatch =
                    text.match(
                        /(?:cartons?|cases?|ctn|c)\s*[:\-]?\s*(\d+)/i
                    );

                const unitMatch =
                    text.match(
                        /(?:units?|qty|u)\s*[:\-]?\s*(\d+)/i
                    );

                saveISA(
                    isaMatch[1],

                    palletMatch
                        ? parseNumber(
                              palletMatch[1]
                          )
                        : null,

                    cartonMatch
                        ? parseNumber(
                              cartonMatch[1]
                          )
                        : null,

                    unitMatch
                        ? parseNumber(
                              unitMatch[1]
                          )
                        : null
                );
            });
        } finally {
            scanInProgress = false;
        }
    }

    /******************************************************************
     * SKANOWANIE FC RESEARCH
     ******************************************************************/
function scanFCResearchPage() {

    if (
        !IS_FC_RESEARCH ||
        !document.body ||
        scanInProgress
    ) {
        return;
    }

    scanInProgress = true;

    try {

        const currentISA =
            getCurrentISAFromUrl();

        if (!currentISA) {
            return;
        }

        let savedRows = 0;

        const rows =
            document.querySelectorAll(
                '#table-purchase-order-item tbody tr'
            );

        rows.forEach(function (row) {

            const cells =
                Array.from(
                    row.querySelectorAll('td')
                );

            /*
             * Purchase Order Items:
             *
             * 0 Purchase Order
             * 1 SKU / ASIN
             * 2 Vendor Code
             * 3 Unfilled
             * 4 Canceled
             * 5 Received
             * 6 Overaged
             */

            if (cells.length < 7) {
                return;
            }

            const asin =
                parseASIN(
                    cells[1].innerText
                );

            if (!asin) {
                return;
            }

            const unfilled =
                parseNumber(
                    cells[3].innerText
                );

            const canceled =
                parseNumber(
                    cells[4].innerText
                );

            const received =
                parseNumber(
                    cells[5].innerText
                );

            const overage =
                parseNumber(
                    cells[6].innerText
                );

            saveASIN(
                asin,
                currentISA,
                'Purchase Order Items',
                unfilled,
                canceled,
                received,
                overage
            );

            savedRows++;
        });

        /*
         * fallback ASIN scan
         */
        const elements =
            document.querySelectorAll(
                [
                    'a',
                    'td',
                    'li',
                    'article',
                    '[role="row"]',
                    '[role="gridcell"]',
                    '[data-testid]',
                    '[class*="asin"]',
                    '[class*="result"]',
                    '[class*="product"]'
                ].join(',')
            );

        elements.forEach(function (element) {

            if (
                element.id === 'dm-fc-widget' ||
                element.closest('#dm-fc-widget')
            ) {
                return;
            }

            const values = [
                element.innerText,
                element.textContent,
                element.getAttribute('href'),
                element.getAttribute('data-asin'),
                element.getAttribute('aria-label'),
                element.getAttribute('title')
            ]
                .filter(Boolean)
                .join(' ')
                .toUpperCase();

            const matches =
                values.match(
                    /\bB[A-Z0-9]{9}\b/g
                );

            if (!matches) {
                return;
            }

            Array.from(
                new Set(matches)
            ).forEach(function (asin) {

                saveASIN(
                    asin,
                    currentISA,
                    'FC Research page fallback',
                    null,
                    null,
                    null,
                    null
                );

            });
        });

        log(
            'Skan FC Research zakończony:',
            {
                isa: currentISA,
                savedRows: savedRows
            }
        );

    } catch (error) {

        log(
            'Błąd scanFCResearchPage:',
            error
        );

    } finally {

        scanInProgress = false;

    }
}
    /******************************************************************
     * KOLEJKA COLLECT ALL ASIN
     ******************************************************************/

    function collectAllASINs() {
        if (!IS_DOCKMASTER) {
            return;
        }

        scanDockMasterPage();

        const isaRecords =
            getSortedISARecords();

        if (!isaRecords.length) {
            alert(
                'Nie znaleziono żadnych numerów ISA. ' +
                'Najpierw otwórz listę appointmentów w DockMaster.'
            );

            return;
        }

        const queue =
            isaRecords.map(function (
                record
            ) {
                return record.isa;
            });

        /*
         * Czyścimy stare ASIN-y przed nowym pełnym zbieraniem.
         */
        writeASINRecords({});
        writeQueue(queue);

        writeCollectionStatus({
            running: true,
            total: queue.length,
            completed: 0,
            currentISA: null,
            startedAt:
                new Date().toISOString(),
            finishedAt: null
        });

        refreshWidget();

        /*
         * Otwieramy pierwszą stronę bezpośrednio po kliknięciu,
         * żeby przeglądarka nie uznała jej za niechciany popup.
         */
        const firstISA = queue[0];

        const firstUrl =
            CONFIG.fcResearchBaseUrl +
            encodeURIComponent(firstISA) +
            '&dmCollector=1';

        const collectionTab =
            window.open(
                firstUrl,
                'dm_fc_asin_collector'
            );

        if (!collectionTab) {
            writeCollectionStatus({
                running: false,
                total: queue.length,
                completed: 0,
                currentISA: null,
                startedAt: null,
                finishedAt: null
            });

            alert(
                'Przeglądarka zablokowała FC Research. ' +
                'Zezwól na wyskakujące okna dla DockMaster i kliknij ponownie Collect All ASIN.'
            );

            return;
        }

        log(
            'Rozpoczęto Collect All ASIN:',
            queue.length,
            'ISA'
        );
    }

    function processFCResearchQueue() {
        if (!IS_FC_RESEARCH) {
            return;
        }

        const url =
            new URL(location.href);

        const collectorMode =
            url.searchParams.get(
                'dmCollector'
            ) === '1';

        if (!collectorMode) {
            return;
        }

        const currentISA =
            getCurrentISAFromUrl();

        const queue = readQueue();
        const status =
            readCollectionStatus();

        if (
            !status.running ||
            !queue.length ||
            !currentISA
        ) {
            return;
        }

        /*
         * Chroni przed wielokrotnym uruchomieniem
         * kolejki na tej samej stronie.
         */
        if (
            window
                .__dmFcQueueProcessing
        ) {
            return;
        }

        window
            .__dmFcQueueProcessing =
            true;

        const currentIndex =
            queue.indexOf(currentISA);

        const completedBefore =
            currentIndex >= 0
                ? currentIndex
                : status.completed || 0;

        writeCollectionStatus({
            running: true,
            total: queue.length,
            completed: completedBefore,
            currentISA: currentISA,
            startedAt:
                status.startedAt ||
                new Date().toISOString(),
            finishedAt: null
        });

        /*
         * Kilka skanów, ponieważ wyniki mogą doładowywać
         * się asynchronicznie.
         */
        setTimeout(
            scanFCResearchPage,
            1200
        );

        setTimeout(
            scanFCResearchPage,
            3000
        );

        setTimeout(
            scanFCResearchPage,
            5000
        );

        setTimeout(function () {
            scanFCResearchPage();
            markISACollected(currentISA);

            const nextIndex =
                currentIndex + 1;

            if (
                currentIndex === -1 ||
                nextIndex >=
                    queue.length
            ) {
                writeQueue([]);

                writeCollectionStatus({
                    running: false,
                    total: queue.length,
                    completed:
                        queue.length,
                    currentISA: null,
                    startedAt:
                        status.startedAt ||
                        null,
                    finishedAt:
                        new Date()
                            .toISOString()
                });

                log(
                    'Collect All ASIN zakończony'
                );

                document.title =
                    'DONE - FC Research';

                setTimeout(function () {
                    window.close();
                }, 1500);

                return;
            }

            const nextISA =
                queue[nextIndex];

            writeCollectionStatus({
                running: true,
                total: queue.length,
                completed: nextIndex,
                currentISA: nextISA,
                startedAt:
                    status.startedAt ||
                    new Date()
                        .toISOString(),
                finishedAt: null
            });

            const nextUrl =
                CONFIG
                    .fcResearchBaseUrl +
                encodeURIComponent(
                    nextISA
                ) +
                '&dmCollector=1';

            location.href = nextUrl;
        }, CONFIG.fcResearchWaitTime);
    }

    /******************************************************************
     * EKSPORT
     ******************************************************************/

    function exportISAData() {
        const rows = [
            [
                'ISA',
                'Pallets',
                'Cartons',
                'Units',
                'ASIN Count',
                'Collected'
            ]
        ];

        getSortedISARecords()
            .forEach(function (record) {
                rows.push([
                    record.isa,
                    record.pallets,
                    record.cartons,
                    record.units,
                    getASINCountForISA(
                        record.isa
                    ),
                    record.collected
                        ? 'YES'
                        : 'NO'
                ]);
            });

        downloadCSV(
            'DockMaster_ISA_' +
                new Date()
                    .toISOString()
                    .slice(0, 10) +
                '.csv',
            rows
        );
    }

function exportASINData() {
    const rows = [
        [
            'ISA',
            'ASIN',
            'Not Received - Unfilled',
            'Canceled',
            'Received',
            'Overage',
            'Source',
            'Collected At'
        ]
    ];

    getSortedASINRecords()
        .forEach(function (record) {
            rows.push([
                record.isa,
                record.asin,
                record.unfilled,
                record.canceled,
                record.received,
                record.overage,
                record.source,
                record.discoveredAt
            ]);
        });

    downloadCSV(
        'DockMaster_ASIN_' +
            new Date()
                .toISOString()
                .slice(0, 10) +
            '.csv',
        rows
    );
}
    function exportCombinedData() {
    const isaMap = readISARecords();

    const rows = [
[
    'ISA',
    'ASIN',
    'Not Received - Unfilled',
    'Canceled',
    'Received',
    'Overage',

    'Hazmat PL',
    'Hazmat DE',

    'GL Name',
    'UN',
    'Drop Zone',

    'ISA Units',
    'Pallets',
    'Cartons'
]
    ];

    getSortedASINRecords()
        .forEach(function (asinRecord) {
            const isaRecord =
                isaMap[asinRecord.isa] || {};

rows.push([
    asinRecord.isa,
    asinRecord.asin,

    asinRecord.unfilled,
    asinRecord.canceled,
    asinRecord.received,
    asinRecord.overage,

asinRecord.hazmatLevelPL || '',
asinRecord.hazmatLevelDE || '',

asinRecord.glName || '',

asinRecord.unCode || '',
asinRecord.dropZone || '',

    isaRecord.units,
    isaRecord.pallets,
    isaRecord.cartons
]);
        });

    downloadCSV(
        'DockMaster_ISA_ASIN_' +
            new Date()
                .toISOString()
                .slice(0, 10) +
            '.csv',
        rows
    );
}

    /******************************************************************
     * WIDŻET
     ******************************************************************/

    function makeButton(
        text,
        backgroundColor
    ) {
        const button =
            document.createElement(
                'button'
            );

        button.textContent = text;

        button.style.cssText = [
            'border:0',
            'border-radius:5px',
            'padding:7px 9px',
            'cursor:pointer',
            'background:' +
                (
                    backgroundColor ||
                    '#ff9900'
                ),
            'color:#111111',
            'font-size:11px',
            'font-weight:bold'
        ].join(';');

        return button;
    }

    function createWidget() {
        if (
            !document.body ||
            document.getElementById(
                'dm-fc-widget'
            )
        ) {
            return;
        }

        const widget =
            document.createElement('div');

        widget.id = 'dm-fc-widget';

        widget.style.cssText = [
            'position:fixed',
            'right:12px',
            'top:100px',
            'width:390px',
            'background:#232f3e',
            'color:#ffffff',
            'z-index:2147483647',
            'border-radius:8px',
            'box-shadow:0 3px 16px rgba(0,0,0,0.50)',
            'font-family:Arial,sans-serif',
            'font-size:12px',
            'overflow:hidden'
        ].join(';');

        const header =
            document.createElement('div');

        header.id = 'dm-fc-header';

        header.style.cssText = [
            'padding:12px',
            'background:#146eb4',
            'color:#ffffff',
            'font-weight:bold',
            'cursor:pointer',
            'user-select:none'
        ].join(';');

        const body =
            document.createElement('div');

        body.id = 'dm-fc-body';

        body.style.cssText = [
            'display:none',
            'max-height:600px',
            'overflow-y:auto',
            'padding:10px'
        ].join(';');

        const status =
            document.createElement('div');

        status.id = 'dm-fc-status';

        status.style.cssText = [
            'padding:7px',
            'margin-bottom:8px',
            'background:#37475a',
            'border-radius:5px',
            'font-size:11px',
            'line-height:1.5'
        ].join(';');

        const toolbar =
            document.createElement('div');

        toolbar.style.cssText = [
            'display:flex',
            'gap:6px',
            'flex-wrap:wrap',
            'margin-bottom:10px'
        ].join(';');

        if (IS_DOCKMASTER) {
            const collectButton =
                makeButton(
                    'Collect All ASIN',
                    '#00c853'
                );

            collectButton.id =
                'dm-collect-all';

            collectButton.addEventListener(
                'click',
                collectAllASINs
            );

            toolbar.appendChild(
                collectButton
            );
        }

        const copyASINButton =
            makeButton(
                'Copy ASIN',
                '#ff9900'
            );

        const exportASINButton =
            makeButton(
                'ASIN CSV',
                '#ff9900'
            );

        const exportISAButton =
            makeButton(
                'ISA CSV',
                '#ff9900'
            );

        const hazmatButton =
    makeButton(
        'Collect Hazmat',
        '#7b1fa2'
    );

        const combinedButton =
            makeButton(
                'Combined CSV',
                '#ff9900'
            );

        const scanButton =
            makeButton(
                'Scan',
                '#d5dbdb'
            );

        const clearButton =
            makeButton(
                'Clear All',
                '#ff6b6b'
            );

        copyASINButton
            .addEventListener(
                'click',
                function () {
                    copyText(
                        getUniqueASINs()
                            .join('\n')
                    );
                }
            );

        exportASINButton
            .addEventListener(
                'click',
                exportASINData
            );

        exportISAButton
            .addEventListener(
                'click',
                exportISAData
            );

hazmatButton.addEventListener(
    'click',
    collectHazmat
);
        combinedButton
            .addEventListener(
                'click',
                exportCombinedData
            );

        scanButton
            .addEventListener(
                'click',
                function () {
                    if (IS_DOCKMASTER) {
                        scanDockMasterPage();
                    }

                    if (IS_FC_RESEARCH) {
                        scanFCResearchPage();
                    }

                    refreshWidget();
                }
            );

        clearButton
            .addEventListener(
                'click',
                function () {
                    GM_deleteValue(
                        CONFIG.storageKeys
                            .isaRecords
                    );

                    GM_deleteValue(
                        CONFIG.storageKeys
                            .asinRecords
                    );

                    GM_deleteValue(
                        CONFIG.storageKeys
                            .collectionQueue
                    );

                    GM_deleteValue(
                        CONFIG.storageKeys
                            .collectionStatus
                    );

                    refreshWidget();
                }
            );

        toolbar.appendChild(
            copyASINButton
        );

        toolbar.appendChild(
            exportASINButton
        );

        toolbar.appendChild(
            exportISAButton
        );

toolbar.appendChild(
    hazmatButton
);
        toolbar.appendChild(
            combinedButton
        );

        toolbar.appendChild(
            scanButton
        );

        toolbar.appendChild(
            clearButton
        );

        const list =
            document.createElement('div');

        list.id = 'dm-fc-list';

        body.appendChild(status);
        body.appendChild(toolbar);
        body.appendChild(list);

        widget.appendChild(header);
        widget.appendChild(body);

        document.body.appendChild(
            widget
        );

        header.addEventListener(
            'click',
            function () {
                body.style.display =
                    body.style.display ===
                    'none'
                        ? 'block'
                        : 'none';

                if (
                    body.style.display ===
                    'block'
                ) {
                    if (IS_DOCKMASTER) {
                        scanDockMasterPage();
                    }

                    if (IS_FC_RESEARCH) {
                        scanFCResearchPage();
                    }

                    refreshWidget();
                }
            }
        );

        widgetCreated = true;

        log('Widżet utworzony');
    }

    function refreshWidget() {
        if (!document.body) {
            return;
        }

        createWidget();

        const header =
            document.getElementById(
                'dm-fc-header'
            );

        const statusElement =
            document.getElementById(
                'dm-fc-status'
            );

        const list =
            document.getElementById(
                'dm-fc-list'
            );

        if (
            !header ||
            !statusElement ||
            !list
        ) {
            return;
        }

        const isaRecords =
            getSortedISARecords();

        const asinRecords =
            getSortedASINRecords();

        const uniqueASINs =
            getUniqueASINs();

        const collectionStatus =
            readCollectionStatus();

        header.textContent =
            '📦 ISA ' +
            isaRecords.length +
            ' | ASIN ' +
            uniqueASINs.length;

        if (
            collectionStatus.running
        ) {
            statusElement.innerHTML =
                '<strong>Collect All działa</strong><br>' +
                'ISA: ' +
                (
                    collectionStatus
                        .currentISA ||
                    'oczekiwanie'
                ) +
                '<br>' +
                'Postęp: ' +
                collectionStatus.completed +
                ' / ' +
                collectionStatus.total;
        } else {
            statusElement.innerHTML =
                '<strong>' +
                (
                    IS_DOCKMASTER
                        ? 'DockMaster'
                        : 'FC Research'
                ) +
                '</strong><br>' +
                'ISA: ' +
                isaRecords.length +
                ' | Unikalne ASIN: ' +
                uniqueASINs.length;
        }

        list.innerHTML = '';

        if (!isaRecords.length) {
            const empty =
                document.createElement(
                    'div'
                );

            empty.textContent =
                IS_DOCKMASTER
                    ? 'Brak ISA. Otwórz appointmenty lub kliknij Scan.'
                    : 'Brak wcześniejszych danych ISA.';

            empty.style.cssText = [
                'padding:10px',
                'color:#b8c7d9',
                'text-align:center'
            ].join(';');

            list.appendChild(empty);
        }

        isaRecords.forEach(function (
            record
        ) {
            const row =
                document.createElement(
                    'div'
                );

            row.style.cssText = [
                'display:flex',
                'justify-content:space-between',
                'align-items:center',
                'gap:8px',
                'padding:8px 4px',
                'border-bottom:1px solid #3a4654'
            ].join(';');

            const textContainer =
                document.createElement(
                    'div'
                );

            textContainer.style.cssText = [
                'flex:1',
                'cursor:pointer',
                'line-height:1.45'
            ].join(';');

            const asinCount =
                getASINCountForISA(
                    record.isa
                );

            const numberLine =
                document.createElement(
                    'div'
                );

            numberLine.textContent =
                record.isa +
                (
                    record.collected
                        ? ' ✓'
                        : ''
                );

            numberLine.style.cssText = [
                'color:#ffffff',
                'font-size:13px',
                'font-weight:bold'
            ].join(';');

            const detailsLine =
                document.createElement(
                    'div'
                );

            detailsLine.textContent =
                'P:' +
                (
                    record.pallets ??
                    '?'
                ) +
                ' C:' +
                (
                    record.cartons ??
                    '?'
                ) +
                ' U:' +
                (
                    record.units ??
                    '?'
                ) +
                ' | ASIN:' +
                asinCount;

            detailsLine.style.cssText = [
                'color:#b8c7d9',
                'font-size:11px'
            ].join(';');

            textContainer.appendChild(
                numberLine
            );

            textContainer.appendChild(
                detailsLine
            );

            textContainer.addEventListener(
                'click',
                function () {
                    window.open(
                        CONFIG
                            .fcResearchBaseUrl +
                            encodeURIComponent(
                                record.isa
                            ),
                        '_blank'
                    );
                }
            );

            const copyButton =
                makeButton(
                    '📋',
                    '#ff9900'
                );

            copyButton.addEventListener(
                'click',
                function (event) {
                    event.stopPropagation();

                    copyText(record.isa);

                    copyButton.textContent =
                        '✓';

                    setTimeout(function () {
                        copyButton
                            .textContent =
                            '📋';
                    }, 700);
                }
            );

            row.appendChild(
                textContainer
            );

            row.appendChild(
                copyButton
            );

            list.appendChild(row);
        });
    }

    /******************************************************************
     * NASŁUCH ZMIAN STORAGE
     ******************************************************************/

    function installStorageListeners() {
        Object.values(
            CONFIG.storageKeys
        ).forEach(function (storageKey) {
            GM_addValueChangeListener(
                storageKey,
                function () {
                    scheduleRefresh();
                }
            );
        });
    }

    /******************************************************************
     * START
     ******************************************************************/

    function startApplication() {
        if (!document.body) {
            setTimeout(
                startApplication,
                250
            );

            return;
        }

        createWidget();
        refreshWidget();

        if (IS_DOCKMASTER) {
            scanDockMasterPage();
        }

        if (IS_FC_RESEARCH) {
            scanFCResearchPage();

            setTimeout(
                processFCResearchQueue,
                900
            );
        }

        setInterval(function () {
            if (
                location.href !==
                lastUrl
            ) {
                lastUrl =
                    location.href;

                if (IS_DOCKMASTER) {
                    setTimeout(
                        scanDockMasterPage,
                        500
                    );
                }

                if (IS_FC_RESEARCH) {
                    setTimeout(
                        scanFCResearchPage,
                        500
                    );
                }
            }
        }, 750);

        setInterval(function () {
            if (IS_DOCKMASTER) {
                scanDockMasterPage();
            }

            if (IS_FC_RESEARCH) {
                scanFCResearchPage();
            }
        }, CONFIG.pageScanInterval);

        log(
            'Skrypt uruchomiony poprawnie'
        );
    }

    installFetchInterceptor();
    installXHRInterceptor();
    installStorageListeners();

    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            startApplication,
            {
                once: true
            }
        );

        setTimeout(
            startApplication,
            1500
        );
    } else {
        startApplication();
    }
    async function collectHazmat() {
console.log('HAZMAT START');
    const asinRecords = readASINRecords();

    const uniqueAsins =
        Array.from(
            new Set(
                Object.values(asinRecords)
                    .map(x => x.asin)
                    .filter(Boolean)
            )
        );

    if (!uniqueAsins.length) {

        alert(
            'Najpierw uruchom Collect All ASIN'
        );

        return;
    }

    const CHUNK_SIZE = 50;

    for (
        let i = 0;
        i < uniqueAsins.length;
        i += CHUNK_SIZE
    ) {

        const batch =
            uniqueAsins.slice(
                i,
                i + CHUNK_SIZE
            );

        const payload =
            'language=default' +
            '&source=retail-rbs' +
            '&marketPlaces=PL,DE' +
            '&asins=' +
            encodeURIComponent(
                batch.join('\n')
            ) +
            '&sidx=product.asin' +
            '&rows=99999' +
            '&page=1' +
            '&sord=desc' +
            '&isExportOnly=FALSE' +
            '&fileName=dockmaster_hazmat' +
            '&fc=' +
            '&pandashservice=';

        try {

const json = await new Promise(
    function(resolve, reject) {

        GM_xmlhttpRequest({

            method: 'POST',

            url: 'https://pandash.eu.aftx.amazonoperations.app/GridServlet',

            headers: {
                'Content-Type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With':
                    'XMLHttpRequest'
            },

            data: payload,

            onload: function(response) {

                try {

console.log(
    'PANDASH RESPONSE',
    response.responseText
);

resolve(
    JSON.parse(
        response.responseText
    )
);

                } catch (error) {

                    reject(error);

                }
            },

            onerror: function(error) {

                reject(error);

            }

        });

    }
);

            if (
                !json ||
                !Array.isArray(json.rows)
            ) {
                continue;
            }

json.rows.forEach(function (row) {
console.log(row.asin, row.mp, row.level, row.glname);
``
    const asin = row.asin;

    if (!asin) {
        return;
    }

    Object.values(asinRecords)
        .forEach(function (record) {

            if (record.asin !== asin) {
                return;
            }

            if (row.mp === 'PL') {

                record.hazmatLevelPL =
                    row.level || '';

            }

            if (row.mp === 'DE') {

                record.hazmatLevelDE =
                    row.level || '';

            }

            record.glName =
                row.glname ||
                record.glName ||
                '';

            record.unCode =
                row.un ||
                record.unCode ||
                '';

            record.dropZone =
                row.dropZone ||
                record.dropZone ||
                '';
console.log(
    'SAVED',
    record.asin,
    {
        pl: record.hazmatLevelPL,
        de: record.hazmatLevelDE,
        gl: record.glName,
        un: record.unCode,
        dz: record.dropZone
    }
);
        });

});

            writeASINRecords(
                asinRecords
            );

        } catch (error) {

            console.error(
                'Hazmat error',
                error
            );
        }
    }

    alert(
        'Collect Hazmat completed'
    );

    refreshWidget();
}

    /*
     * KONIEC CAŁEGO SKRYPTU
     */
})();
