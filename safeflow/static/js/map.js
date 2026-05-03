document.addEventListener('DOMContentLoaded', async () => {
    try {
        const authResponse = await fetchWithAuth(`${API_BASE_URL}/auth/users/me`);
        if (!authResponse.ok) {
            if (window.location.pathname !== '/login' && window.location.pathname !== '/') window.location.href = '/login';
            throw new Error('Not authenticated');
        }
        const user = await authResponse.json();
        initializeMap(user);
    } catch (error) {
        console.error("Map init error:", error.message);
        if (!getToken() && window.location.pathname !== '/login') window.location.href = '/login';
    }
});

let mapInstance = null;
let currentStyle = 'dark';
const DEFAULT_LAT = 22.7196;
const DEFAULT_LNG = 75.8577;

function setMapStyle(style) {
    if (!mapInstance) return;
    currentStyle = style;
    const styles = {
        dark: 'mapbox://styles/mapbox/dark-v11',
        satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
    };
    mapInstance.setStyle(styles[style]);
    document.querySelectorAll('.map-style-toggle button').forEach(b => {
        b.classList.toggle('active', b.textContent.toLowerCase() === style);
    });
    mapInstance.once('style.load', () => {
        if (typeof reloadMapData === 'function') reloadMapData();
    });
}

function initializeMap(loggedInUser) {
    mapboxgl.accessToken = MAPBOX_TOKEN;

    mapInstance = new mapboxgl.Map({
        container: 'map',
        style: 'mapbox://styles/mapbox/dark-v11',
        center: [DEFAULT_LNG, DEFAULT_LAT],
        zoom: 12
    });

    mapInstance.addControl(new mapboxgl.NavigationControl(), 'top-left');
    mapInstance.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-left');

    let allPoints = [];
    let cameraMarkers = [];
    let zoneMarkers = [];
    let routeLayerAdded = false;
    let liveStatuses = {};

    function el(id) { return document.getElementById(id); }

    function getZoneColor(type) {
        const colors = { overcrowded: '#ef4444', lockdown: '#f59e0b', conflict: '#374151', safe: '#22c55e', camera_active: '#3b82f6' };
        return colors[type] || '#6b7280';
    }

    function getCamCoords(cam) {
        const lat = (cam.latitude != null && cam.latitude !== 0) ? cam.latitude : DEFAULT_LAT + (Math.random() - 0.5) * 0.04;
        const lng = (cam.longitude != null && cam.longitude !== 0) ? cam.longitude : DEFAULT_LNG + (Math.random() - 0.5) * 0.04;
        return [lng, lat];
    }

    async function fetchLiveStatuses() {
        try {
            const res = await fetchWithAuth(`${API_BASE_URL}/cameras/live_statuses/`);
            if (res.ok) {
                const statuses = await res.json();
                liveStatuses = {};
                Object.entries(statuses).forEach(([id, data]) => {
                    liveStatuses[parseInt(id)] = data;
                });
            }
        } catch (e) { console.warn("Live status fetch error:", e); }
    }

    function showCameraDetails(cam) {
        el('noCamSelected').style.display = 'none';
        el('camDetailsArea').style.display = 'block';
        el('camLiveBadge').style.display = 'flex';

        const feedUrl = `${API_BASE_URL}/stream/video_feed/${cam.id}`;
        el('camFeedPreview').src = feedUrl;
        el('camFeedPreview').onerror = function() { this.style.display = 'none'; };
        el('camFeedPreview').onload = function() { this.style.display = 'block'; };

        el('camDetailName').textContent = `${cam.area_name} - ${cam.name}`;
        el('camDetailLocation').textContent = `📍 ${cam.area_name}, Indore, MP`;

        const status = liveStatuses[cam.id];
        const isOnline = status ? status.is_active : cam.is_active;
        el('camDetailStatus').textContent = isOnline ? 'Online' : 'Offline';
        el('camDetailStatus').className = 'cam-detail-val ' + (isOnline ? 'online' : 'alert');

        const mode = typeof cam.mode === 'object' ? cam.mode.value : cam.mode;
        el('camDetailMode').textContent = mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : 'General';

        const density = status && status.density != null ? status.density : null;
        const personCount = status && status.person_count != null ? status.person_count : null;
        if (density != null) {
            el('camDetailDensity').textContent = density.toFixed(2) + ' p/m²';
            el('camDetailDensity').className = 'cam-detail-val' + (density > 1 ? ' alert' : '');
        } else {
            el('camDetailDensity').textContent = personCount != null ? `${personCount} persons` : '--';
            el('camDetailDensity').className = 'cam-detail-val';
        }

        el('camDetailUpdated').textContent = status && status.last_updated
            ? new Date(status.last_updated).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
            : 'Just now';

        el('camDetailLink').href = '/dashboard';
    }

    async function loadZones() {
        try {
            const res = await fetchWithAuth(`${API_BASE_URL}/zones/`);
            if (!res.ok) return;
            const zones = await res.json();
            let safeCount = 0, overcrowdedCount = 0;

            zones.forEach(zone => {
                const color = getZoneColor(zone.type);
                if (zone.type === 'safe') safeCount++;
                if (zone.type === 'overcrowded') overcrowdedCount++;

                const markerEl = document.createElement('div');
                markerEl.style.cssText = `width:24px;height:24px;background:${color};border-radius:50%;border:2px solid rgba(255,255,255,0.3);box-shadow:0 0 10px ${color}80;cursor:pointer;`;

                const popup = new mapboxgl.Popup({ offset: 15, className: 'dark-popup' }).setHTML(
                    `<div style="min-width:150px;">
                        <strong style="color:var(--text);font-size:0.95em;">${zone.name}</strong>
                        <div style="margin-top:6px;font-size:0.82em;">
                            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;"></span>
                            ${zone.type.charAt(0).toUpperCase() + zone.type.slice(1)}
                        </div>
                        ${zone.description ? `<p style="margin-top:4px;font-size:0.8em;color:var(--text3);">${zone.description}</p>` : ''}
                        ${zone.radius ? `<p style="font-size:0.78em;color:var(--text3);margin-top:4px;">Radius: ${zone.radius}m</p>` : ''}
                    </div>`
                );

                const marker = new mapboxgl.Marker({ element: markerEl })
                    .setLngLat([zone.longitude, zone.latitude])
                    .setPopup(popup)
                    .addTo(mapInstance);
                zoneMarkers.push(marker);
                allPoints.push({ name: `Zone: ${zone.name}`, lat: zone.latitude, lon: zone.longitude, type: 'zone' });
            });

            if (el('mapStatSafe')) el('mapStatSafe').textContent = safeCount;
            if (el('mapStatOvercrowded')) {
                el('mapStatOvercrowded').textContent = overcrowdedCount;
                if (el('mapStatOvercrowdedSub')) {
                    el('mapStatOvercrowdedSub').textContent = overcrowdedCount > 0 ? '● Requires Attention' : '● All Clear';
                    el('mapStatOvercrowdedSub').className = 'stat-sub ' + (overcrowdedCount > 0 ? 'red' : 'green');
                }
            }
        } catch (e) { console.error("Error loading zones:", e); }
    }

    async function loadCameras() {
        try {
            const res = await fetchWithAuth(`${API_BASE_URL}/cameras/`);
            if (!res.ok) return;
            const cameras = await res.json();
            let activeCount = 0;

            cameras.forEach((cam, idx) => {
                const coords = getCamCoords(cam);
                const isOnline = liveStatuses[cam.id] ? liveStatuses[cam.id].is_active : cam.is_active;
                if (isOnline) activeCount++;

                const density = liveStatuses[cam.id] ? liveStatuses[cam.id].density : null;
                const isOvercrowded = density != null && density > 1.5;

                const markerEl = document.createElement('div');
                const bgColor = isOvercrowded ? 'rgba(239,68,68,0.9)' : 'rgba(59,130,246,0.9)';
                const borderColor = isOvercrowded ? 'rgba(239,68,68,0.4)' : 'rgba(59,130,246,0.4)';
                const glowColor = isOvercrowded ? 'rgba(239,68,68,0.3)' : 'rgba(59,130,246,0.3)';

                markerEl.style.cssText = `width:34px;height:34px;background:${bgColor};border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px solid ${borderColor};box-shadow:0 0 14px ${glowColor};transition:transform 0.2s;`;
                markerEl.innerHTML = '<svg width="16" height="16" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
                markerEl.title = `${cam.name} - ${cam.area_name}`;

                markerEl.addEventListener('mouseenter', () => { markerEl.style.transform = 'scale(1.15)'; });
                markerEl.addEventListener('mouseleave', () => { markerEl.style.transform = 'scale(1)'; });

                const marker = new mapboxgl.Marker({ element: markerEl, anchor: 'center' })
                    .setLngLat(coords)
                    .addTo(mapInstance);

                markerEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showCameraDetails(cam);
                    mapInstance.flyTo({ center: coords, zoom: 15, duration: 1000 });
                });

                cameraMarkers.push(marker);
                allPoints.push({ name: `Cam: ${cam.name} (${cam.area_name})`, lat: coords[1], lon: coords[0], type: 'camera', id: cam.id });
            });

            if (el('mapStatCameras')) el('mapStatCameras').textContent = activeCount;
        } catch (e) { console.error("Error loading cameras:", e); }
    }

    function populateRoutingSelects() {
        const start = el('routeStartSelect');
        const end = el('routeEndSelect');
        if (!start || !end) return;
        start.innerHTML = '<option value="">Select start location</option>';
        end.innerHTML = '<option value="">Select end location</option>';
        allPoints.sort((a, b) => a.name.localeCompare(b.name));
        allPoints.forEach(p => {
            const opt = document.createElement('option');
            opt.value = `${p.lon},${p.lat}`;
            opt.textContent = p.name;
            start.appendChild(opt.cloneNode(true));
            end.appendChild(opt);
        });
    }

    async function findRoute(startCoords, endCoords) {
        if (routeLayerAdded) {
            if (mapInstance.getLayer('route-line')) mapInstance.removeLayer('route-line');
            if (mapInstance.getLayer('route-outline')) mapInstance.removeLayer('route-outline');
            if (mapInstance.getSource('route')) mapInstance.removeSource('route');
            routeLayerAdded = false;
        }
        try {
            const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${startCoords};${endCoords}?geometries=geojson&overview=full&steps=true&access_token=${MAPBOX_TOKEN}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Directions API failed');
            const data = await res.json();
            if (!data.routes || data.routes.length === 0) { alert('No route found.'); return; }

            const route = data.routes[0];
            mapInstance.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: route.geometry } });
            mapInstance.addLayer({ id: 'route-outline', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#155e2a', 'line-width': 10, 'line-opacity': 0.4 } });
            mapInstance.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#22c55e', 'line-width': 5, 'line-opacity': 0.9 } });
            routeLayerAdded = true;

            const coords = route.geometry.coordinates;
            const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
            mapInstance.fitBounds(bounds, { padding: 80, duration: 1200 });

            const distKm = (route.distance / 1000).toFixed(1);
            const timeMin = Math.round(route.duration / 60);
            const pathEl = el('alternatePaths');
            const instrEl = el('pathInstructions');
            if (pathEl && instrEl) {
                pathEl.style.display = 'block';
                let html = `<li style="padding:8px 0;color:var(--text);font-size:0.9em;font-weight:600;">📍 Route: ${distKm} km, ~${timeMin} min</li>`;
                if (route.legs && route.legs[0] && route.legs[0].steps) {
                    route.legs[0].steps.slice(0, 8).forEach((step, i) => {
                        html += `<li style="padding:4px 0 4px 12px;color:var(--text2);font-size:0.82em;border-left:2px solid var(--border);">${i + 1}. ${step.maneuver.instruction} <span style="color:var(--text3);">(${(step.distance / 1000).toFixed(1)}km)</span></li>`;
                    });
                }
                instrEl.innerHTML = html;
            }
        } catch (e) {
            console.error("Route error:", e);
            alert("Could not find route: " + e.message);
        }
    }

    if (el('findRouteButton')) {
        el('findRouteButton').addEventListener('click', () => {
            const start = el('routeStartSelect')?.value;
            const end = el('routeEndSelect')?.value;
            if (!start || !end) { alert('Select both start and end points.'); return; }
            if (start === end) { alert('Start and end must be different.'); return; }
            findRoute(start, end);
        });
    }

    function updateTimeStats() {
        const now = new Date();
        if (el('mapStatTime')) el('mapStatTime').textContent = now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
        if (el('mapStatTimeSub')) el('mapStatTimeSub').textContent = '● Just now';
    }

    window.reloadMapData = async function () {
        allPoints = [];
        cameraMarkers.forEach(m => m.remove());
        cameraMarkers = [];
        zoneMarkers.forEach(m => m.remove());
        zoneMarkers = [];
        await fetchLiveStatuses();
        await Promise.all([loadZones(), loadCameras()]);
        populateRoutingSelects();
        updateTimeStats();
    };

    mapInstance.on('load', async () => {
        await fetchLiveStatuses();
        await Promise.all([loadZones(), loadCameras()]);
        populateRoutingSelects();
        updateTimeStats();

        if (allPoints.length > 0) {
            const bounds = allPoints.reduce((b, p) => b.extend([p.lon, p.lat]),
                new mapboxgl.LngLatBounds([allPoints[0].lon, allPoints[0].lat], [allPoints[0].lon, allPoints[0].lat]));
            mapInstance.fitBounds(bounds, { padding: 80, duration: 1500, maxZoom: 14 });
        }

        setInterval(async () => {
            await fetchLiveStatuses();
            updateTimeStats();
        }, 30000);
    });
}