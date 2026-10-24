// ===== DASHBOARD.JS =====
import { db } from './app.js';
import { Auth } from './auth.js';
import {
  collection, query, where, onSnapshot,
  orderBy, limit, Timestamp, doc, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

// ===== HELPERS =====
function formatCurrency(n) {
  return '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function badgeClass(estado) {
  const map = {
    activo: 'badge-activo', disponible: 'badge-disponible',
    pendiente: 'badge-pendiente',
    aceptado: 'badge-en-viaje', en_camino: 'badge-en-viaje',
    'en-viaje': 'badge-en-viaje', 'en_viaje': 'badge-en-viaje',
    finalizado: 'badge-finalizado', cancelado: 'badge-cancelado',
    suspendido: 'badge-suspendido', rechazado: 'badge-rechazado',
  };
  return map[(estado || '').toLowerCase()] || 'badge-pendiente';
}

function badgeLabel(estado) {
  const map = {
    pendiente: 'Pendiente', aceptado: 'Aceptado', en_camino: 'En camino',
    finalizado: 'Finalizado', cancelado: 'Cancelado',
  };
  return map[(estado || '').toLowerCase()] || estado || '—';
}

function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// Anima el stat cuando cambia de valor
function setStat(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const next = String(value);
  if (el.textContent !== '—' && el.textContent !== next) {
    el.classList.remove('stat-updated');
    void el.offsetWidth;
    el.classList.add('stat-updated');
    setTimeout(() => el.classList.remove('stat-updated'), 700);
  }
  el.textContent = next;
}

// ===== ESTADÍSTICAS EN TIEMPO REAL =====
function initStats() {
  const hoyInicio = new Date();
  hoyInicio.setHours(0, 0, 0, 0);
  const hoyFin = new Date();
  hoyFin.setHours(23, 59, 59, 999);

  // Taxistas en línea (disponible + activo)
  onSnapshot(
    query(collection(db, 'taxistas'), where('estado', 'in', ['activo', 'disponible', 'en-viaje', 'en_viaje'])),
    snap => setStat('stat-activos', snap.size)
  );

  // Pendientes de aprobación — resalta la card si hay alguno
  onSnapshot(
    query(collection(db, 'taxistas'), where('estado', '==', 'pendiente')),
    snap => {
      setStat('stat-pendientes', snap.size);
      document.getElementById('card-pendientes')?.classList.toggle('stat-card-alert', snap.size > 0);
    }
  );

  // Viajes del día + ingresos + en viaje ahora
  onSnapshot(
    query(
      collection(db, 'viajes'),
      where('fechaSolicitud', '>=', Timestamp.fromDate(hoyInicio)),
      where('fechaSolicitud', '<=', Timestamp.fromDate(hoyFin))
    ),
    snap => {
      let ingresos = 0;
      let enViaje  = 0;
      snap.forEach(d => {
        const v      = d.data();
        const estado = (v.estado || '').toLowerCase();
        if (estado === 'finalizado')                          ingresos += v.tarifa || 0;
        if (['aceptado', 'en_camino'].includes(estado))      enViaje++;
      });
      setStat('stat-viajes', snap.size);
      setStat('stat-ingresos', formatCurrency(ingresos));
      setStat('stat-en-viaje', enViaje);
      document.getElementById('card-en-viaje')?.classList.toggle('stat-card-highlight', enViaje > 0);
    }
  );
}

// ===== VIAJES EN CURSO AHORA =====
function initViajesEnCurso() {
  const tbody = document.getElementById('tbody-en-curso');
  const badge = document.getElementById('badge-en-curso');
  if (!tbody) return;

  const q = query(
    collection(db, 'viajes'),
    where('estado', 'in', ['pendiente', 'aceptado', 'en_camino']),
    orderBy('fechaSolicitud', 'desc')
  );

  onSnapshot(q, snap => {
    if (badge) badge.textContent = snap.size;

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:#bbb;">
        No hay viajes en curso ahora mismo</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    snap.forEach(docSnap => {
      const d      = docSnap.data();
      const estado = (d.estado || '').toLowerCase();
      const tr     = document.createElement('tr');
      tr.className = 'dash-live-row';
      tr.innerHTML = `
        <td class="td-bold">${d.origen  || '—'}</td>
        <td>${d.destino || '—'}</td>
        <td>${d.taxistaNombre  || '—'}</td>
        <td>${d.clienteNombre || d.clienteTelefono || '—'}</td>
        <td><span class="badge ${badgeClass(estado)}">${badgeLabel(estado)}</span></td>
        <td style="color:#aaa;font-size:12.5px">${formatTime(d.fechaSolicitud)}</td>`;
      tbody.appendChild(tr);
    });
  });
}

// ===== ACTIVIDAD RECIENTE =====
function initViajesRecientes() {
  const tbody = document.getElementById('tbody-viajes');
  if (!tbody) return;

  const q = query(
    collection(db, 'viajes'),
    orderBy('fechaSolicitud', 'desc'),
    limit(10)
  );

  onSnapshot(q, snap => {
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:#bbb;">
        Sin actividad reciente</td></tr>`;
      return;
    }
    tbody.innerHTML = '';
    snap.forEach(docSnap => {
      const d      = docSnap.data();
      const estado = (d.estado || '').toLowerCase();
      const tr     = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-bold">${d.origen  || '—'}</td>
        <td>${d.destino || '—'}</td>
        <td>${d.taxistaNombre || '—'}</td>
        <td><span class="badge ${badgeClass(estado)}">${badgeLabel(estado)}</span></td>
        <td><strong>${formatCurrency(d.tarifa)}</strong></td>
        <td style="color:#aaa;font-size:12.5px">${formatTime(d.fechaSolicitud)}</td>`;
      tbody.appendChild(tr);
    });
  });
}

// ===== TAXISTAS PENDIENTES =====
function initPendientes() {
  const tbody = document.getElementById('tbody-pendientes');
  const badge = document.getElementById('badge-pendientes');
  if (!tbody) return;

  const q = query(collection(db, 'taxistas'), where('estado', '==', 'pendiente'));
  onSnapshot(q, snap => {
    if (badge) badge.textContent = snap.size;
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="5" style="padding:24px;text-align:center;color:#bbb;">
        Sin solicitudes pendientes</td></tr>`;
      return;
    }
    tbody.innerHTML = '';
    snap.forEach(docSnap => {
      const d  = docSnap.data();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="driver-info">
            <div class="driver-avatar">${initials(d.nombre)}</div>
            <div>
              <div class="driver-name">${d.nombre || '—'}</div>
              <div class="driver-phone">${d.telefono || ''}</div>
            </div>
          </div>
        </td>
        <td><strong>${d.vehiculo?.placas || '—'}</strong></td>
        <td>${d.vehiculo?.marca ? `${d.vehiculo.marca} ${d.vehiculo.modelo || ''}`.trim() : '—'}</td>
        <td><span class="badge badge-pendiente">Pendiente</span></td>
        <td>
          <div class="btn-actions">
            ${window.Permisos?.puede('taxistas', 'editar') ?? true ? `
            <button class="btn btn-success btn-sm" onclick="aprobarTaxista('${docSnap.id}')">✓ Aprobar</button>
            <button class="btn btn-danger btn-sm"  onclick="rechazarTaxista('${docSnap.id}')">✕ Rechazar</button>` : ''}
          </div>
        </td>`;
      tbody.appendChild(tr);
    });
  });
}

// ===== MAPA EN VIVO (Leaflet / OpenStreetMap) =====
let _lmap     = null;
let _lMarkers = new Map();   // taxistaId → L.marker
let _lUnsub   = null;
let _lCluster = null;
let _lFitDone = false;
const _GPS_STALE = 15 * 60 * 1000;
const _VIVOS_SET = new Set(['disponible', 'activo', 'en_viaje', 'en_camino', 'ocupado']);

function _tiempoDesde(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60000) return 'hace un momento';
  const m = Math.floor(d / 60000);
  return m < 60 ? `hace ${m} min` : `hace ${Math.floor(m / 60)} h`;
}

function _mkTaxiIcon(estado) {
  const verde = ['disponible', 'activo'].includes(estado);
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3));cursor:pointer;">
      <div style="font-size:28px;line-height:1;">🚕</div>
      <div style="position:absolute;bottom:0;right:-3px;width:11px;height:11px;border-radius:50%;
        background:${verde ? '#3B6D11' : '#E89B1A'};border:2px solid #fff;"></div>
    </div>`,
    iconSize: [34, 38], iconAnchor: [17, 38], popupAnchor: [0, -42],
  });
}

function _popupHtml(t, nombre, estado, tsText) {
  const verde = ['disponible', 'activo'].includes(estado);
  const color = verde ? '#3B6D11' : '#E89B1A';
  const label = verde ? 'Disponible' : 'En viaje';
  return `<div style="font-family:Inter,system-ui,sans-serif;min-width:180px;padding:4px 2px;">
    <div style="font-weight:700;font-size:14px;color:#1a1a2e;margin-bottom:6px;">${nombre}</div>
    <div style="font-size:12.5px;color:#555;line-height:1.8;">
      📞 ${t.telefono || '—'}<br>
      🚗 ${t.vehiculo?.placas || '—'}<br>
      ⭐ ${parseFloat(t.calificacion || 0).toFixed(1)}
      ${tsText ? `<br><span style="color:#aaa;font-size:11px;">GPS: ${tsText}</span>` : ''}
    </div>
    <span style="display:inline-block;margin-top:8px;padding:3px 10px;border-radius:20px;
      background:${color};color:#fff;font-size:11px;font-weight:600;">${label}</span>
  </div>`;
}

function _iniciarSeguimientoLeaflet() {
  if (_lUnsub) _lUnsub();
  const lg = _lCluster || _lmap;

  _lUnsub = onSnapshot(
    query(collection(db, 'taxistas'), where('activo', '==', true)),
    snap => {
      const presentes = new Set();
      const bounds    = [];
      let enLinea     = 0;

      snap.forEach(docSnap => {
        const t      = docSnap.data();
        const estado = (t.estado || '').toLowerCase();
        if (!_VIVOS_SET.has(estado)) return;
        if (typeof t.lat !== 'number' || typeof t.lng !== 'number') return;
        const tsMs = t.ultimaActualizacion?.toMillis?.() ?? t.ultimaUbicacion?.toMillis?.() ?? null;
        if (tsMs && (Date.now() - tsMs) > _GPS_STALE) return;

        const id     = docSnap.id;
        presentes.add(id); enLinea++;
        bounds.push([t.lat, t.lng]);

        const nombre  = ((t.nombre || '') + ' ' + (t.apellidos || '')).trim() || '—';
        const tsText  = tsMs ? _tiempoDesde(tsMs) : '';
        const popup   = _popupHtml(t, nombre, estado, tsText);
        const icon    = _mkTaxiIcon(estado);

        if (_lMarkers.has(id)) {
          const m = _lMarkers.get(id);
          m.setLatLng([t.lat, t.lng]);
          m.setIcon(icon);
          m.getPopup()?.setContent(popup);
        } else {
          const m = L.marker([t.lat, t.lng], { icon }).bindPopup(popup);
          _lMarkers.set(id, m);
          lg.addLayer(m);
        }
      });

      _lMarkers.forEach((marker, id) => {
        if (!presentes.has(id)) { lg.removeLayer(marker); _lMarkers.delete(id); }
      });

      if (bounds.length && !_lFitDone) {
        _lmap.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
        _lFitDone = true;
      }

      const countEl = document.getElementById('mapa-count');
      if (countEl) countEl.textContent = `${enLinea} taxista${enLinea !== 1 ? 's' : ''} en línea`;
    }
  );
}

function initMapaDashboard() {
  const el = document.getElementById('mapa-dashboard');
  if (!el || typeof L === 'undefined') return;

  el.textContent = '';
  _lmap = L.map(el, { zoomControl: true }).setView([21.1392, -98.4206], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(_lmap);

  if (typeof L.markerClusterGroup === 'function') {
    _lCluster = L.markerClusterGroup({
      maxClusterRadius: 50,
      iconCreateFunction: c => L.divIcon({
        html: `<div style="background:#1a1a2e;color:#fff;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;font-family:Inter,sans-serif;">${c.getChildCount()}</div>`,
        className: '', iconSize: [34, 34],
      }),
    });
    _lmap.addLayer(_lCluster);
  }

  _iniciarSeguimientoLeaflet();
}

// ===== ACCIONES =====
window.aprobarTaxista = async (id) => {
  if (!(window.Permisos?.puede('taxistas', 'editar') ?? true)) return alert('No tienes permiso para editar taxistas.');
  await updateDoc(doc(db, 'taxistas', id), { activo: true, estado: 'activo' });
};
window.rechazarTaxista = async (id) => {
  if (!(window.Permisos?.puede('taxistas', 'editar') ?? true)) return alert('No tienes permiso para editar taxistas.');
  await updateDoc(doc(db, 'taxistas', id), { activo: false, estado: 'rechazado' });
};

// ===== LOGOUT =====
document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

// ===== FECHA =====
const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ===== INIT =====
initStats();
initMapaDashboard();
initViajesEnCurso();
initViajesRecientes();
initPendientes();
