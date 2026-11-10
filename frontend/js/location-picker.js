/* ===========================================================
   TutorLink — shared location picker (GPS + map pin)
   Used by student-complete-profile.html and teacher-complete-profile.html.
   Needs Leaflet (window.L) loaded before it is OPENED (not before this file loads).
   The map modal markup is injected into the page the first time it is needed.
   =========================================================== */
(function () {
  'use strict';

  var BRAND = '#7C5CFC';
  var DEFAULT_CENTER = [28.9845, 77.7064]; // Meerut, UP: only used when nothing else is known
  var NOMINATIM = 'https://nominatim.openstreetmap.org';

  function $(id) { return document.getElementById(id); }
  function hasLeaflet() { return typeof window.L !== 'undefined' && typeof window.L.map === 'function'; }

  // OpenStreetMap Nominatim is free and needs no key. Replace with a paid geocoder if usage grows.
  async function reverseGeocode(lat, lng) {
    var url = NOMINATIM + '/reverse?format=jsonv2&lat=' + encodeURIComponent(lat) +
      '&lon=' + encodeURIComponent(lng) + '&zoom=18&addressdetails=1';
    var res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Could not look up that address.');
    var data = await res.json();
    var a = data.address || {};
    var displayArea = data.display_name ? String(data.display_name).split(',')[0].trim() : 'Unknown area';
    return {
      area: a.suburb || a.neighbourhood || a.residential || a.hamlet || a.quarter ||
        a.village || a.town || a.city_district || a.municipality || a.road || a.city || displayArea,
      district: a.state_district || a.county || a.city || a.state || '—',
      pincode: a.postcode || '------',
      display: data.display_name || ''
    };
  }

  var MODAL_HTML =
    '<div class="modal-backdrop" id="tlpBackdrop">' +
      '<div class="modal modal-map" role="dialog" aria-modal="true" aria-labelledby="tlpTitle">' +
        '<div class="modal-header">' +
          '<div><h3 id="tlpTitle">Set your location</h3><p id="tlpSub">Drag the pin, or click anywhere on the map, to place it exactly.</p></div>' +
          '<button type="button" class="modal-close" id="tlpClose" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="map-search-row">' +
            '<input type="text" id="tlpSearch" placeholder="Search for an area, e.g. Shastri Nagar, Meerut" aria-label="Search for a place" maxlength="120">' +
            '<button type="button" id="tlpSearchBtn" class="btn btn-outline btn-sm">Search</button>' +
          '</div>' +
          '<div class="map-wrap">' +
            '<div id="tlpMap"></div>' +
            '<span class="map-zoom-hint">Scroll or pinch to zoom</span>' +
            '<button type="button" id="tlpLocate" class="map-locate-btn" title="Use my current location" aria-label="Use my current location">📍</button>' +
          '</div>' +
          '<div id="tlpAccuracy" class="accuracy-note" style="display:none;" role="status"></div>' +
          '<div class="map-hint">Tip: search for your area, then drag the pin to fine-tune the spot.</div>' +
          '<div class="map-picked-address" id="tlpAddress" aria-live="polite">Move the pin to see the address here.</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-outline btn-sm" id="tlpCancel">Cancel</button>' +
          '<button type="button" class="btn btn-primary" id="tlpConfirm">Confirm this location</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function create(options) {
    options = options || {};
    var notify = typeof options.notify === 'function' ? options.notify : function () {};
    var getCurrent = typeof options.getCurrent === 'function' ? options.getCurrent : function () { return null; };
    var onConfirm = typeof options.onConfirm === 'function' ? options.onConfirm : async function () {};

    var map = null, marker = null, circle = null;
    var pending = null; // { lat, lng }
    var geocodeTimer = null, geocodeSeq = 0;
    var built = false;
    var lastFocus = null;

    function build() {
      if (built) return;
      built = true;
      var holder = document.createElement('div');
      holder.innerHTML = MODAL_HTML;
      document.body.appendChild(holder.firstElementChild);

      $('tlpClose').addEventListener('click', close);
      $('tlpCancel').addEventListener('click', close);
      $('tlpBackdrop').addEventListener('click', function (e) { if (e.target === $('tlpBackdrop')) close(); });
      $('tlpSearchBtn').addEventListener('click', search);
      $('tlpSearch').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); search(); }
      });
      $('tlpConfirm').addEventListener('click', confirm);
      $('tlpLocate').addEventListener('click', locateInsideMap);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && $('tlpBackdrop').classList.contains('open')) close();
      });
    }

    function pinIcon() {
      return L.divIcon({
        className: 'custom-pin',
        html: '<svg width="32" height="42" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 27 17 27s17-14.3 17-27C34 7.6 26.4 0 17 0z" fill="' + BRAND + '"/>' +
          '<circle cx="17" cy="17" r="7" fill="#fff"/></svg>',
        iconSize: [32, 42],
        iconAnchor: [16, 42]
      });
    }

    function setAccuracy(accuracy) {
      var note = $('tlpAccuracy');
      if (!accuracy) { note.style.display = 'none'; note.textContent = ''; return; }
      var m = Math.round(accuracy);
      note.style.display = 'flex';
      if (m <= 30) { note.className = 'accuracy-note good'; note.textContent = '✓ GPS accuracy: about ' + m + ' m. This pin should already be very close.'; }
      else if (m <= 100) { note.className = 'accuracy-note fair'; note.textContent = '⚠ GPS accuracy: about ' + m + ' m. Drag the pin to your exact spot for the best result.'; }
      else { note.className = 'accuracy-note poor'; note.textContent = '⚠ GPS accuracy: about ' + m + ' m (weak signal). Please drag the pin precisely onto your location.'; }
    }

    function clearCircle() {
      if (circle && map) map.removeLayer(circle);
      circle = null;
      setAccuracy(null);
    }

    function drawCircle(lat, lng, accuracy) {
      clearCircle();
      if (!accuracy || !map) return;
      circle = L.circle([lat, lng], { radius: accuracy, color: BRAND, fillColor: BRAND, fillOpacity: 0.12, weight: 1 }).addTo(map);
      setAccuracy(accuracy);
    }

    function preview(lat, lng) {
      pending = { lat: lat, lng: lng };
      var box = $('tlpAddress');
      box.textContent = 'Looking up address…';
      clearTimeout(geocodeTimer);
      var seq = ++geocodeSeq; // an older answer must never overwrite a newer one
      geocodeTimer = setTimeout(async function () {
        try {
          var a = await reverseGeocode(lat, lng);
          if (seq === geocodeSeq) box.textContent = a.area + ', ' + a.district + ' — ' + a.pincode;
        } catch (e) {
          if (seq === geocodeSeq) box.textContent = 'Pin placed. The address lookup failed, but the location is still usable.';
        }
      }, 450);
    }

    function open(opts) {
      if (!hasLeaflet()) {
        notify('The map could not load. Check your connection and refresh the page.', true);
        return false;
      }
      build();
      opts = opts || {};
      lastFocus = document.activeElement;
      $('tlpTitle').textContent = opts.title || 'Set your location';
      $('tlpSub').textContent = opts.sub || 'Drag the pin, or click anywhere on the map, to place it exactly.';
      $('tlpBackdrop').classList.add('open');

      var cur = getCurrent();
      var hasStart = typeof opts.lat === 'number' && typeof opts.lng === 'number';
      var startLat = hasStart ? opts.lat : (cur ? cur.lat : DEFAULT_CENTER[0]);
      var startLng = hasStart ? opts.lng : (cur ? cur.lng : DEFAULT_CENTER[1]);
      var zoom = (hasStart || cur) ? 17 : 14;

      if (!map) {
        map = L.map('tlpMap').setView([startLat, startLng], zoom);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
        marker = L.marker([startLat, startLng], { draggable: true, icon: pinIcon() }).addTo(map);
        marker.on('dragend', function () {
          var p = marker.getLatLng();
          clearCircle();
          preview(p.lat, p.lng);
        });
        map.on('click', function (e) {
          marker.setLatLng(e.latlng);
          clearCircle();
          preview(e.latlng.lat, e.latlng.lng);
        });
      } else {
        map.setView([startLat, startLng], zoom);
        marker.setLatLng([startLat, startLng]);
        setTimeout(function () { map.invalidateSize(); }, 60);
      }

      drawCircle(startLat, startLng, opts.accuracy);
      preview(startLat, startLng);
      setTimeout(function () { var c = $('tlpClose'); if (c) c.focus(); }, 60);
      return true;
    }

    function close() {
      $('tlpBackdrop').classList.remove('open');
      if (lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus(); } catch (e) { /* element is gone */ } }
    }

    async function search() {
      var q = $('tlpSearch').value.trim();
      if (!q || !map) return;
      var btn = $('tlpSearchBtn');
      btn.disabled = true;
      try {
        var res = await fetch(NOMINATIM + '/search?format=jsonv2&q=' + encodeURIComponent(q) + '&limit=1');
        if (!res.ok) throw new Error('search failed');
        var results = await res.json();
        if (!Array.isArray(results) || !results.length) { notify('No matching place found.', true); return; }
        var lat = parseFloat(results[0].lat), lng = parseFloat(results[0].lon);
        if (!isFinite(lat) || !isFinite(lng)) { notify('No matching place found.', true); return; }
        map.setView([lat, lng], 16);
        marker.setLatLng([lat, lng]);
        clearCircle();
        preview(lat, lng);
      } catch (e) {
        notify('Search failed. Please try again.', true);
      } finally {
        btn.disabled = false;
      }
    }

    function locateInsideMap() {
      var btn = $('tlpLocate');
      if (!navigator.geolocation) { notify('Geolocation is not supported by your browser.', true); return; }
      btn.textContent = '…';
      btn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          btn.textContent = '📍';
          btn.disabled = false;
          var c = pos.coords;
          map.setView([c.latitude, c.longitude], 17);
          marker.setLatLng([c.latitude, c.longitude]);
          drawCircle(c.latitude, c.longitude, c.accuracy);
          preview(c.latitude, c.longitude);
        },
        function () {
          btn.textContent = '📍';
          btn.disabled = false;
          notify('Could not fetch your location. Please drag the pin manually.', true);
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    }

    async function confirm() {
      if (!pending) return;
      var btn = $('tlpConfirm');
      btn.disabled = true;
      btn.classList.add('btn-loading');
      try {
        await onConfirm(pending.lat, pending.lng);
        close();
      } catch (e) {
        notify((e && e.message) || 'Could not save this location.', true);
      } finally {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
      }
    }

    // GPS fix first, then the map so the person can fine-tune the pin.
    function useGps(btn, statusEl) {
      function say(text) { if (statusEl) statusEl.textContent = text; }
      if (!navigator.geolocation) { say('Geolocation is not supported by your browser. Set your spot on the map instead.'); return; }
      btn.disabled = true;
      btn.classList.add('btn-loading');
      say('Getting a precise GPS fix… this can take a few seconds.');
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          btn.disabled = false;
          btn.classList.remove('btn-loading');
          var c = pos.coords;
          if (!hasLeaflet()) {
            // No map library: trust the GPS fix rather than leave the person stuck.
            say('Saving your GPS location…');
            Promise.resolve(onConfirm(c.latitude, c.longitude)).catch(function (e) {
              notify((e && e.message) || 'Could not save this location.', true);
            });
            return;
          }
          say('GPS fix found. Confirm it on the map.');
          open({
            lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
            title: 'Confirm your exact location',
            sub: 'We centred the pin on your GPS fix. Drag it to your doorstep for the best match accuracy.'
          });
        },
        function (err) {
          btn.disabled = false;
          btn.classList.remove('btn-loading');
          var messages = {
            1: 'Location access denied. Allow location for this site in your browser settings, then try again.',
            2: 'Could not detect your location right now. Try again, or set it on the map.',
            3: 'Location request timed out. Try again, ideally outdoors or near a window.'
          };
          say(messages[err.code] || 'Could not get your location. Set it on the map instead.');
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    }

    return { open: open, close: close, useGps: useGps, reverseGeocode: reverseGeocode };
  }

  window.TLLocationPicker = { create: create, reverseGeocode: reverseGeocode };
})();