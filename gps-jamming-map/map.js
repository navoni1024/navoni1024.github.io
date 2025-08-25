let map, hexLayer;

const GeoUtils = {
    EARTH_RADIUS_METERS: 6371000,

    radiansToDegrees: (r) => r * 180 / Math.PI,
    degreesToRadians: (d) => d * Math.PI / 180,

    getDistanceOnEarthInMeters: (lat1, lon1, lat2, lon2) => {
        const lat1Rad = GeoUtils.degreesToRadians(lat1);
        const lat2Rad = GeoUtils.degreesToRadians(lat2);
        const lonDelta = GeoUtils.degreesToRadians(lon2 - lon1);
        const x = Math.sin(lat1Rad) * Math.sin(lat2Rad) +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lonDelta);
        return GeoUtils.EARTH_RADIUS_METERS * Math.acos(Math.max(Math.min(x, 1), -1));
    }
};

const FIXED_H3_RES = 4;

const getH3ResForMapZoom = (mapZoom) => {
    // 函式現在只會回傳固定的解析度
    return FIXED_H3_RES;
};

const parseQueryString = () => {
    const queryString = window.location.search;
    const query = {};
    const pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i].split('=');
        query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '');
    }
    return query;
};

const queryParams = parseQueryString();

const copyToClipboard = (text) => {
    const dummy = document.createElement("textarea");
    document.body.appendChild(dummy);
    dummy.value = text;
    dummy.select();
    document.execCommand("copy");
    document.body.removeChild(dummy);
};

const INTERFERENCE_LOW = 'low';
const INTERFERENCE_MED = 'med';
const INTERFERENCE_HIGH = 'high';

const interferenceLevel = (good, bad) => {
    const total = good + bad;
    if (total === 0) {
        return INTERFERENCE_LOW;
    }
    const ratio = bad / total;
    if (ratio > 0.5) {
        return INTERFERENCE_HIGH;
    } else if (ratio > 0.1) {
        return INTERFERENCE_MED;
    } else {
        return INTERFERENCE_LOW;
    }
};

// 修正跨換日線的邊界點
function wrapBoundary(boundary) {
    const fixed = [];
    let prevLng = null;

    for (let [lat, lng] of boundary) {
        if (lng > 180) lng -= 360;
        if (lng < -180) lng += 360;

        if (prevLng !== null) {
            const diff = lng - prevLng;
            if (diff > 180) {
                lng -= 360;
            } else if (diff < -180) {
                lng += 360;
            }
        }

        fixed.push([lat, lng]);
        prevLng = lng;
    }

    return fixed;
}

var app = new Vue({
    el: "#app",

    data: {
        searchH3Id: undefined,
        gotoLatLon: undefined,
        currentH3Res: undefined,
        h3Data: {},
        availableFiles: ['2022-04-06-h3_4.csv', '2025-8-1_0000_filterA.csv', '2025-8-1_0000_unfilter.csv', '2025-8-1_0000_filterB.csv'],
        selectedFile: '2025-8-1_0000_filterB.csv'
    },

    computed: {},

    methods: {
        computeAverageEdgeLengthInMeters: function(vertexLocations) {
            let totalLength = 0;
            let edgeCount = 0;
            for (let i = 1; i < vertexLocations.length; i++) {
                const [fromLat, fromLng] = vertexLocations[i - 1];
                const [toLat, toLng] = vertexLocations[i];
                const edgeDistance = GeoUtils.getDistanceOnEarthInMeters(fromLat, fromLng, toLat, toLng);
                totalLength += edgeDistance;
                edgeCount++;
            }
            return totalLength / edgeCount;
        },

        updateMapDisplay: function() {
            if (hexLayer) {
                hexLayer.remove();
            }
            hexLayer = L.layerGroup().addTo(map);

            this.currentH3Res = getH3ResForMapZoom(map.getZoom());
            const { _southWest: sw, _northEast: ne } = map.getBounds();

            // 把經度 normalize 到 -180~180
            const normalizeLng = (lng) => {
                while (lng < -180) lng += 360;
                while (lng > 180) lng -= 360;
                return lng;
            };

            const h3s = new Set();

            const addPolygonCells = (boundsSw, boundsNe) => {
                const polygon = [
                    [boundsSw.lat, boundsSw.lng],
                    [boundsNe.lat, boundsSw.lng],
                    [boundsNe.lat, boundsNe.lng],
                    [boundsSw.lat, boundsNe.lng],
                    [boundsSw.lat, boundsSw.lng],
                ];
                h3.polygonToCells(polygon, this.currentH3Res).forEach(h3id => h3s.add(h3id));
            };

            // 一般情況
            addPolygonCells(sw, ne);

            // 如果經度範圍超過 180，需要複製偏移世界
            if (ne.lng > 180) {
                addPolygonCells(
                    { lat: sw.lat, lng: normalizeLng(sw.lng - 360) },
                    { lat: ne.lat, lng: normalizeLng(ne.lng - 360) }
                );
            }
            if (sw.lng < -180) {
                addPolygonCells(
                    { lat: sw.lat, lng: normalizeLng(sw.lng + 360) },
                    { lat: ne.lat, lng: normalizeLng(ne.lng + 360) }
                );
            }

            for (const h3id of h3s) {
                const isSelected = h3id === this.searchH3Id;

                let style = { color: "#3388ff", weight: 1, fillColor: "transparent", fillOpacity: 0 };

                const h3Info = this.h3Data[h3id];
                let level = '無資料';
                let goodAircraftCount = 0;
                let badAircraftCount = 0;

                if (h3Info) {
                    level = interferenceLevel(h3Info.count_good_aircraft, h3Info.count_bad_aircraft);
                    goodAircraftCount = h3Info.count_good_aircraft;
                    badAircraftCount = h3Info.count_bad_aircraft;
                    if (level === INTERFERENCE_HIGH) {
                        style.fillColor = "#ff3333";
                    } else if (level === INTERFERENCE_MED) {
                        style.fillColor = "#ffff33";
                    } else {
                        style.fillColor = "#33ff33";
                    }
                    style.fillOpacity = 0.5;
                    style.weight = 0.5;
                    style.color = style.fillColor;
                }

                if (isSelected) {
                    style.color = "orange";
                    style.weight = 3;
                    style.fillColor = "orange";
                    style.fillOpacity = 0.8;
                }

                let h3Bounds = wrapBoundary(h3.cellToBoundary(h3id));

                // 複製多邊形到 ±360 經度（確保 wrapAround 時可見）
                [-360, 0, 360].forEach(offset => {
                    const latLngs = h3Bounds.map(b => L.latLng(b[0], b[1] + offset));
                    const tooltipText = `
                        Cell ID: <b>${h3id}</b>
                        <br />
                        干擾等級: <b>${level}</b>
                        <br />
                        好航班: <b>${goodAircraftCount}</b>
                        <br />
                        壞航班: <b>${badAircraftCount}</b>
                    `;
                    L.polygon(latLngs, style)
                        .on('click', () => copyToClipboard(h3id))
                        .bindTooltip(tooltipText)
                        .addTo(hexLayer);
                });
            }
        },

        gotoLocation: function() {
            const [lat, lon] = (this.gotoLatLon || "").split(",").map(Number);
            if (Number.isFinite(lat) && Number.isFinite(lon) &&
                lat <= 90 && lat >= -90 && lon <= 180 && lon >= -180) {
                map.setView([lat, lon], 16);
            }
        },

        findH3: function() {
            if (!h3.isValidCell(this.searchH3Id)) {
                return;
            }
            const h3Boundary = h3.cellToBoundary(this.searchH3Id);

            let bounds = undefined;

            for (const [lat, lng] of h3Boundary) {
                if (bounds === undefined) {
                    bounds = new L.LatLngBounds([lat, lng], [lat, lng]);
                } else {
                    bounds.extend([lat, lng]);
                }
            }

            map.fitBounds(bounds);
        },

        loadData: function() {
            this.h3Data = {};
            this.updateMapDisplay();

            Papa.parse(`./data/${this.selectedFile}`, {
                download: true,
                header: true,
                complete: (results) => {
                    const processedData = {};
                    results.data.forEach(row => {
                        if (row.hex) {
                            processedData[row.hex] = {
                                count_good_aircraft: parseInt(row.count_good_aircraft),
                                count_bad_aircraft: parseInt(row.count_bad_aircraft),
                            };
                        }
                    });
                    this.h3Data = processedData;
                    this.updateMapDisplay();
                }
            });
        }
    },

    beforeMount() {},

    mounted() {
        document.addEventListener("DOMContentLoaded", () => {
            map = L.map('mapid', {
                minZoom: 6,
                maxZoom: 10,
                worldCopyJump: false // 保留，讓地圖可以自由滾動
            });
            
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                minZoom: 6,
                attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap contributors</a>',
            }).addTo(map);
            
            pointsLayer = L.layerGroup([]).addTo(map);

            const initialLat = queryParams.lat ?? 25.0330;
            const initialLng = queryParams.lng ?? 121.5654;
            const initialZoom = queryParams.zoom ?? 10;

            map.setView([initialLat, initialLng], initialZoom);

            map.on("zoomend", this.updateMapDisplay);
            map.on("moveend", this.updateMapDisplay);

            const { h3: h3IdFromQuery } = queryParams;
            if (h3IdFromQuery) {
                this.searchH3Id = h3IdFromQuery;
                window.setTimeout(() => this.findH3(), 50);
            }

            this.loadData();
        });
    }
});
