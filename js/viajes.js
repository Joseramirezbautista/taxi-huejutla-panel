// ===== VIAJES.JS =====
if (!localStorage.getItem('taxi_admin_session')) {
  window.location.href = 'login.html';
}

const db = firebase.firestore();

const puedeEditarViajes   = () => window.Permisos?.puede('viajes', 'editar')   ?? true;
const puedeEliminarViajes = () => window.Permisos?.puede('viajes', 'eliminar') ?? true;

let todosLosViajes = [];   // [{ id, ...data }]
let filtroEstado   = 'hoy';
let fechaDesde     = null;
let fechaHasta     = null;
const viajesMap    = new Map();

// ===== PAGINACIÓN =====
const VIAJES_POR_PAGINA = 15;
let paginaActual = 1;

// ===== MAP MATCHING (GPS → calles reales) =====
async function snappedRoute(rawPoints) {
  if (!rawPoints || rawPoints.length < 2) return null;

  // 1. Filtrar puntos outliers (saltos > 500 m entre puntos consecutivos)
  const filtered = [rawPoints[0]];
  for (let i = 1; i < rawPoints.length; i++) {
    const prev = filtered[filtered.length - 1];
    const curr = rawPoints[i];
    const d = calcDistanciaMetros(prev.lat, prev.lng, curr.lat, curr.lng);
    if (d < 500) filtered.push(curr);
  }
  if (filtered.length < 2) return filtered.map(p => [p.lat, p.lng]);

  // 2. Reducir a máx 100 puntos (límite del servidor OSRM público)
  let pts = filtered;
  if (filtered.length > 100) {
    const step = Math.ceil(filtered.length / 100);
    pts = filtered.filter((_, i) => i % step === 0);
    if (pts[pts.length - 1] !== filtered[filtered.length - 1])
      pts.push(filtered[filtered.length - 1]);
  }

  // 3. OSRM map matching → ajusta puntos a calles reales
  try {
    const coords   = pts.map(p => `${p.lng},${p.lat}`).join(';');
    const radiuses = pts.map(() => '50').join(';');
    const url = `https://router.project-osrm.org/match/v1/driving/${coords}?overview=full&geometries=geojson&radiuses=${radiuses}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.matchings?.length) {
      const coords2 = [];
      for (const m of data.matchings)
        coords2.push(...m.geometry.coordinates.map(([lng, lat]) => [lat, lng]));
      return coords2;
    }
  } catch {}

  // Fallback: puntos filtrados sin snap
  return filtered.map(p => [p.lat, p.lng]);
}

// ===== REVERSE GEOCODING =====
const _geocodeCache = new Map();

async function resolverOrigen(lat, lng) {
  if (!lat || !lng) return null;
  const key = `${parseFloat(lat).toFixed(4)},${parseFloat(lng).toFixed(4)}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    const road   = addr.road || '';
    const num    = addr.house_number || '';
    const suburb = addr.suburb || addr.neighbourhood || addr.quarter || '';
    const city   = addr.city || addr.town || addr.municipality || '';
    const parts  = [
      road ? (num ? `${road} ${num}` : road) : '',
      suburb,
      city && city !== suburb ? city : '',
    ].filter(Boolean);
    const result = parts.length ? parts.join(', ') : (data.display_name || null);
    if (result) _geocodeCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

// ===== HELPERS =====
function formatCurrency(n) {
  return '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Estrellas + 💬 si dejó comentario (tooltip con el texto, se ve completo en "Ver Ruta")
function renderCalificacion(v) {
  const cal = v.calificacionCliente;
  if (!cal) return '<span style="color:#bbb">—</span>';
  const llenas  = '★'.repeat(cal);
  const vacias  = '☆'.repeat(Math.max(0, 5 - cal));
  const comentario = v.comentarioCliente || '';
  const tip = comentario ? ` title="${escapeHtml(comentario)}"` : '';
  return `<span${tip} style="color:#f5c428;letter-spacing:1px;${comentario ? 'cursor:help;' : ''}">${llenas}${vacias}</span>` +
    (comentario ? ' <span title="Tiene comentario">💬</span>' : '');
}

function formatFecha(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function inicioDelDia(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function finDelDia(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

// ===== FILTRAR =====
function aplicarFiltros() {
  let lista = [...todosLosViajes];

  // Filtro estado
  if (filtroEstado === 'pendientes') {
    lista = lista.filter(v => (v.estado || '').toLowerCase() === 'pendiente');
  } else if (filtroEstado === 'en_curso') {
    lista = lista.filter(v => (v.estado || '').toLowerCase() === 'aceptado');
  } else if (filtroEstado === 'finalizados') {
    lista = lista.filter(v => (v.estado || '').toLowerCase() === 'finalizado');
  } else if (filtroEstado === 'hoy') {
    const inicio = inicioDelDia(new Date());
    const fin    = finDelDia(new Date());
    lista = lista.filter(v => {
      const ts = v.fechaSolicitud?.toDate?.() ?? null;
      return ts && ts >= inicio && ts <= fin;
    });
  }

  // Filtro por rango de fechas (se suma al filtro de estado)
  if (fechaDesde) {
    const inicio = inicioDelDia(fechaDesde);
    lista = lista.filter(v => {
      const ts = v.fechaSolicitud?.toDate?.() ?? null;
      return ts && ts >= inicio;
    });
  }
  if (fechaHasta) {
    const fin = finDelDia(fechaHasta);
    lista = lista.filter(v => {
      const ts = v.fechaSolicitud?.toDate?.() ?? null;
      return ts && ts <= fin;
    });
  }

  renderTabla(lista);
}

// ===== RENDER =====
function renderTabla(lista) {
  const tbody   = document.getElementById('viajes-tbody');
  const countEl = document.getElementById('count-viajes');
  const totalEl = document.getElementById('total-ingresos');

  if (countEl) countEl.textContent = lista.length;

  let totalTarifa = 0;
  lista.forEach(v => {
    if ((v.estado || '').toLowerCase() === 'finalizado') totalTarifa += v.tarifa || 0;
  });
  if (totalEl) totalEl.textContent = formatCurrency(totalTarifa);

  if (lista.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <div class="empty-icon">🗺️</div>
          <p>No se encontraron viajes con este filtro</p>
        </div>
      </td></tr>`;
    renderPager(0);
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(lista.length / VIAJES_POR_PAGINA));
  if (paginaActual > totalPaginas) paginaActual = totalPaginas;
  if (paginaActual < 1) paginaActual = 1;
  const inicio = (paginaActual - 1) * VIAJES_POR_PAGINA;
  const listaPagina = lista.slice(inicio, inicio + VIAJES_POR_PAGINA);

  const filas = [];
  listaPagina.forEach(v => {
    const estadoLower = (v.estado || '').toLowerCase();
    const badgeMap = {
      pendiente:   'badge-pendiente',
      aceptado:    'badge-en-viaje',
      en_camino:   'badge-en-viaje',
      finalizado:  'badge-finalizado',
      cancelado:   'badge-cancelado'
    };
    const labelMap = {
      pendiente:   'Pendiente',
      aceptado:    'En curso',
      en_camino:   'En camino',
      finalizado:  'Finalizado',
      cancelado:   'Cancelado'
    };
    const esGPS = v.origen === 'Mi ubicación (GPS)';
    const orig  = extraerOrigen(v);
    const origenHtml = esGPS && orig
      ? `<span id="origen-${v._id}" data-lat="${orig.lat}" data-lng="${orig.lng}" style="color:#aaa">📍 Resolviendo...</span>`
      : (v.origen || '—');
    filas.push(`
      <tr>
        <td class="td-bold">${origenHtml}</td>
        <td>${v.destino || '—'}</td>
        <td><strong>${formatCurrency(v.tarifa)}</strong></td>
        <td>${v.taxistaNombre || '—'}</td>
        <td>${v.clienteTelefono || v.clienteNombre || '—'}</td>
        <td><span class="badge ${badgeMap[estadoLower] || 'badge-pendiente'}">${labelMap[estadoLower] || v.estado || '—'}</span></td>
        <td style="color:#aaa;font-size:12.5px;">${formatFecha(v.fechaSolicitud)}</td>
        <td>${renderCalificacion(v)}</td>
        <td>
          <div class="btn-actions">
            ${tieneCoordenadas(v)
              ? `<button class="btn btn-outline btn-sm" onclick="verRuta('${v._id}')">🗺 Ruta</button>`
              : ''}
            ${puedeEditarViajes() ? `<button class="btn btn-outline btn-sm" onclick="editarEstado('${v._id}')">✏️ Estado</button>` : ''}
            ${puedeEliminarViajes() && estadoLower === 'pendiente'
              ? `<button class="btn btn-outline btn-sm" style="border-color:#e74c3c;color:#e74c3c;" onclick="eliminarViaje('${v._id}')">🗑️</button>`
              : ''}
          </div>
        </td>
      </tr>`);
  });
  tbody.innerHTML = filas.join('');
  renderPager(lista.length, totalPaginas);

  // Resolver direcciones GPS de forma asíncrona
  document.querySelectorAll('[data-lat][data-lng]').forEach(async el => {
    const lat = parseFloat(el.dataset.lat);
    const lng = parseFloat(el.dataset.lng);
    const dir = await resolverOrigen(lat, lng);
    if (dir && document.getElementById(el.id)) {
      el.textContent = dir;
      el.style.color = '';
    }
  });
}

// ===== PAGINADOR =====
function renderPager(totalItems, totalPaginas = 1) {
  const el = document.getElementById('viajes-pager');
  if (!el) return;
  if (totalItems === 0 || totalPaginas <= 1) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <button type="button" class="btn btn-outline btn-sm" id="pager-prev" ${paginaActual <= 1 ? 'disabled' : ''}>← Anterior</button>
    <span style="font-size:13px;color:#666;">Página ${paginaActual} de ${totalPaginas}</span>
    <button type="button" class="btn btn-outline btn-sm" id="pager-next" ${paginaActual >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>`;

  document.getElementById('pager-prev').addEventListener('click', () => {
    if (paginaActual > 1) { paginaActual--; aplicarFiltros(); }
  });
  document.getElementById('pager-next').addEventListener('click', () => {
    if (paginaActual < totalPaginas) { paginaActual++; aplicarFiltros(); }
  });
}

// ===== CARGA EN TIEMPO REAL =====
firebase.auth().onAuthStateChanged(function(user) {
  if (!user) { window.location.href = 'login.html'; return; }
  db.collection('viajes')
    .orderBy('fechaSolicitud', 'desc')
    .limit(500)
    .onSnapshot(snap => {
      viajesMap.clear();
      todosLosViajes = snap.docs.map(d => {
        const obj = { _id: d.id, ...d.data() };
        viajesMap.set(d.id, obj);
        return obj;
      });
      aplicarFiltros();
    });
});

// ===== FILTROS ESTADO =====
document.querySelectorAll('.filtro-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtroEstado = btn.dataset.filtro;
    paginaActual = 1;
    // Al elegir "hoy" limpiar el rango manual para no pisar
    if (filtroEstado === 'hoy') {
      fechaDesde = null;
      fechaHasta = null;
      const desde = document.getElementById('fecha-desde');
      const hasta = document.getElementById('fecha-hasta');
      if (desde) desde.value = '';
      if (hasta) hasta.value = '';
    }
    aplicarFiltros();
  });
});

// ===== FILTRO POR RANGO DE FECHAS =====
document.getElementById('btn-aplicar-fecha')?.addEventListener('click', () => {
  const desdeVal = document.getElementById('fecha-desde')?.value;
  const hastaVal = document.getElementById('fecha-hasta')?.value;
  fechaDesde = desdeVal ? new Date(desdeVal + 'T00:00:00') : null;
  fechaHasta = hastaVal ? new Date(hastaVal + 'T00:00:00') : null;
  paginaActual = 1;
  // Si aplica rango, quitar el preset "hoy"
  if (fechaDesde || fechaHasta) {
    if (filtroEstado === 'hoy') {
      filtroEstado = 'todos';
      document.querySelectorAll('.filtro-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filtro === 'todos');
      });
    }
  }
  aplicarFiltros();
});

document.getElementById('btn-limpiar-fecha')?.addEventListener('click', () => {
  fechaDesde = null;
  fechaHasta = null;
  paginaActual = 1;
  const desde = document.getElementById('fecha-desde');
  const hasta = document.getElementById('fecha-hasta');
  if (desde) desde.value = '';
  if (hasta) hasta.value = '';
  aplicarFiltros();
});

// ===== MAPA RUTA =====
let _map             = null;
let _markers         = [];
let _routeLine       = null;  // ruta principal (orig→dest o taxi→dest)
let _routeLinePickup = null;  // taxi→orig (solo cuando estado=aceptado)
let _taxiMarker      = null;
let _taxiUnsub       = null;
let _viajeUnsub      = null;
let _lastRoutePos    = null;
let _recalcPending   = false;
let _estadoActual    = null;

function getLatLng(field) {
  if (!field) return null;
  if (typeof field.latitude === 'number') return { lat: field.latitude, lng: field.longitude };
  if (typeof field.lat      === 'number') return { lat: field.lat,      lng: field.lng };
  return null;
}

function extraerOrigen(v) {
  // clienteLat/clienteLng = ubicación de recogida
  if (typeof v.clienteLat === 'number') return { lat: v.clienteLat, lng: v.clienteLng };
  if (typeof v.origenLat  === 'number') return { lat: v.origenLat,  lng: v.origenLng  };
  return getLatLng(v.origenCoordenadas || v.origen);
}

function extraerDestino(v) {
  if (typeof v.destinoLat === 'number') return { lat: v.destinoLat, lng: v.destinoLng };
  return getLatLng(v.destinoCoordenadas || v.destino);
}

function tieneCoordenadas(v) {
  return !!(extraerOrigen(v) && extraerDestino(v));
}

// Haversine: distancia en metros entre dos coordenadas
function calcDistanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Dibuja/reemplaza la ruta según la fase del viaje
async function recalcularRuta(fromLat, fromLng, orig, dest, estado) {
  if (_recalcPending) return;
  _recalcPending = true;
  _lastRoutePos = { lat: fromLat, lng: fromLng };

  if (estado === 'aceptado') {
    // Fase 1: taxista va a recoger al pasajero
    // Línea naranja punteada: taxi → origen
    if (_routeLinePickup) { _map.removeLayer(_routeLinePickup); _routeLinePickup = null; }
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${orig.lng},${orig.lat}?overview=full&geometries=geojson`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.routes?.[0]) {
        const coords = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        _routeLinePickup = L.polyline(coords, {
          color: '#CC2222', weight: 4, opacity: .9, dashArray: '10 6'
        }).addTo(_map);
      }
    } catch {
      _routeLinePickup = L.polyline([[fromLat, fromLng], [orig.lat, orig.lng]],
        { color: '#CC2222', weight: 3, dashArray: '10 6', opacity: .7 }).addTo(_map);
    }
    // Línea verde: origen → destino (ruta del pasajero, se calcula solo la primera vez)
    if (!_routeLine) {
      try {
        const url2 = `https://router.project-osrm.org/route/v1/driving/${orig.lng},${orig.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
        const res2  = await fetch(url2);
        const data2 = await res2.json();
        if (data2.routes?.[0]) {
          const coords2 = data2.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
          _routeLine = L.polyline(coords2, { color: '#3B6D11', weight: 4, opacity: .85 }).addTo(_map);
        }
      } catch {
        _routeLine = L.polyline([[orig.lat, orig.lng], [dest.lat, dest.lng]],
          { color: '#3B6D11', weight: 3, dashArray: '8 6', opacity: .7 }).addTo(_map);
      }
    }
  } else {
    // Fase 2: pasajero a bordo, taxi va al destino
    if (_routeLinePickup) { _map.removeLayer(_routeLinePickup); _routeLinePickup = null; }
    if (_routeLine) { _map.removeLayer(_routeLine); _routeLine = null; }
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.routes?.[0]) {
        const coords = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        _routeLine = L.polyline(coords, { color: '#3B6D11', weight: 4, opacity: .85 }).addTo(_map);
      }
    } catch {
      _routeLine = L.polyline([[fromLat, fromLng], [dest.lat, dest.lng]],
        { color: '#3B6D11', weight: 3, dashArray: '8 6', opacity: .7 }).addTo(_map);
    }
  }
  _recalcPending = false;
}

function limpiarMapa() {
  _markers.forEach(m => _map.removeLayer(m));
  _markers = [];
  if (_routeLine)        { _map.removeLayer(_routeLine);        _routeLine        = null; }
  if (_routeLinePickup)  { _map.removeLayer(_routeLinePickup);  _routeLinePickup  = null; }
  if (_taxiMarker)       { _map.removeLayer(_taxiMarker);       _taxiMarker       = null; }
  if (_taxiUnsub)        { _taxiUnsub();  _taxiUnsub  = null; }
  if (_viajeUnsub)       { _viajeUnsub(); _viajeUnsub = null; }
  _lastRoutePos  = null;
  _recalcPending = false;
  _estadoActual  = null;
}

function mkTaxiIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="taxi-marker-icon">🚕</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function setLiveIndicator(on) {
  const el = document.getElementById('mapa-live-badge');
  if (el) el.style.display = on ? 'flex' : 'none';
}

function mkIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

window.verRuta = async function(id) {
  const v = viajesMap.get(id);
  if (!v) return;

  const orig = extraerOrigen(v);
  const dest = extraerDestino(v);
  if (!orig || !dest) { alert('Sin coordenadas registradas'); return; }

  const origenEl = document.getElementById('mapa-origen');
  origenEl.textContent = v.origen || `${orig.lat.toFixed(5)}, ${orig.lng.toFixed(5)}`;
  if (v.origen === 'Mi ubicación (GPS)') {
    origenEl.textContent = '📍 Resolviendo...';
    resolverOrigen(orig.lat, orig.lng).then(dir => {
      if (dir) origenEl.textContent = dir;
    });
  }
  document.getElementById('mapa-destino').textContent  = v.destino || `${dest.lat.toFixed(5)}, ${dest.lng.toFixed(5)}`;
  document.getElementById('mapa-taxista').textContent  = v.taxistaNombre || '—';
  document.getElementById('mapa-tarifa').textContent   = formatCurrency(v.tarifa);
  document.getElementById('mapa-telefono').textContent = '—';
  document.getElementById('mapa-placas').textContent   = '—';
  document.getElementById('mapa-calificacion').textContent =
    v.calificacionCliente ? `${'★'.repeat(v.calificacionCliente)}${'☆'.repeat(5 - v.calificacionCliente)} (${v.calificacionCliente}/5)` : '—';
  document.getElementById('mapa-comentario').textContent = v.comentarioCliente || '—';

  const fmtHoraFecha = ts => {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  document.getElementById('mapa-hora-inicio').textContent = fmtHoraFecha(v.fechaSolicitud);
  document.getElementById('mapa-hora-fin').textContent    = fmtHoraFecha(v.fechaFin);

  if (v.taxistaId) {
    db.collection('taxistas').doc(v.taxistaId).get().then(snap => {
      if (!snap.exists) return;
      const t = snap.data();
      const nombreCompleto = ((t.nombre || '') + ' ' + (t.apellidos || '')).trim();
      if (nombreCompleto) document.getElementById('mapa-taxista').textContent = nombreCompleto;
      document.getElementById('mapa-telefono').textContent = t.telefono || '—';
      document.getElementById('mapa-placas').textContent   = t.vehiculo?.placas || '—';
    });
  }

  document.getElementById('modal-mapa').style.display = 'flex';

  await new Promise(r => setTimeout(r, 50)); // esperar que el modal sea visible

  if (!_map) {
    _map = L.map('leaflet-map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_map);
  }

  _map.invalidateSize();
  limpiarMapa();

  const mOrig = L.marker([orig.lat, orig.lng], { icon: mkIcon('#3B6D11') })
    .bindPopup('<b>Origen</b>').addTo(_map);
  const mDest = L.marker([dest.lat, dest.lng], { icon: mkIcon('#A32D2D') })
    .bindPopup('<b>Destino</b>').addTo(_map);
  _markers = [mOrig, mDest];

  _map.fitBounds([[orig.lat, orig.lng], [dest.lat, dest.lng]], { padding: [50, 50] });

  // Ruta real grabada por el GPS del taxista
  const rutaReal = Array.isArray(v.rutaRecorrida) ? v.rutaRecorrida : [];
  const leyendaLabel = document.getElementById('leyenda-ruta-label');
  if (rutaReal.length >= 2) {
    if (leyendaLabel) leyendaLabel.textContent = 'Cargando ruta...';
    const coords = await snappedRoute(rutaReal);
    if (coords && coords.length >= 2) {
      if (leyendaLabel) leyendaLabel.textContent = `Ruta real`;
      _routeLine = L.polyline(coords, { color: '#3B6D11', weight: 4, opacity: .9 }).addTo(_map);
      _map.fitBounds(_routeLine.getBounds(), { padding: [50, 50] });
    }
  } else {
    // Fallback: ruta sugerida por OSRM si no hay ruta real
    if (leyendaLabel) leyendaLabel.textContent = 'Ruta sugerida';
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${orig.lng},${orig.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.routes?.[0]) {
        const coords = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        _routeLine = L.polyline(coords, { color: '#3B6D11', weight: 4, opacity: .6, dashArray: '8 5' }).addTo(_map);
        _map.fitBounds(_routeLine.getBounds(), { padding: [50, 50] });
      }
    } catch {
      _routeLine = L.polyline([[orig.lat, orig.lng], [dest.lat, dest.lng]],
        { color: '#3B6D11', weight: 3, dashArray: '8 6', opacity: .7 }).addTo(_map);
    }
  }

  // Seguimiento en tiempo real del taxista + recálculo de ruta cada 100 m
  const estadosActivos = ['en_camino', 'aceptado', 'ocupado'];
  if (v.taxistaId && estadosActivos.includes((v.estado || '').toLowerCase())) {
    setLiveIndicator(true);
    _estadoActual = (v.estado || '').toLowerCase();

    // Escuchar cambios de estado del viaje (aceptado → en_camino)
    _viajeUnsub = db.collection('viajes').doc(v._id).onSnapshot(vSnap => {
      if (!vSnap.exists) return;
      const nuevoEstado = (vSnap.data().estado || '').toLowerCase();
      if (nuevoEstado !== _estadoActual) {
        _estadoActual = nuevoEstado;
        // Al cambiar de fase, forzar recálculo inmediato desde posición actual
        if (_taxiMarker) {
          const pos = _taxiMarker.getLatLng();
          _lastRoutePos = null;
          recalcularRuta(pos.lat, pos.lng, orig, dest, _estadoActual);
        }
      }
    });

    // Escuchar posición del taxista
    _taxiUnsub = db.collection('taxistas').doc(v.taxistaId)
      .onSnapshot(snap => {
        if (!snap.exists) return;
        const t = snap.data();
        if (typeof t.lat !== 'number' || typeof t.lng !== 'number') return;

        // Mover marcador del taxi
        const popupText = _estadoActual === 'aceptado' ? 'En camino al pasajero' : 'En camino';
        if (!_taxiMarker) {
          _taxiMarker = L.marker([t.lat, t.lng], { icon: mkTaxiIcon(), zIndexOffset: 1000 })
            .bindPopup(`<b>${v.taxistaNombre || 'Taxista'}</b><br>${popupText}`)
            .addTo(_map);
        } else {
          _taxiMarker.setLatLng([t.lat, t.lng]);
        }

        // Recalcular ruta si el taxi se movió ≥ 100 m desde la última vez
        const distancia = _lastRoutePos
          ? calcDistanciaMetros(t.lat, t.lng, _lastRoutePos.lat, _lastRoutePos.lng)
          : Infinity;
        if (distancia >= 100) {
          recalcularRuta(t.lat, t.lng, orig, dest, _estadoActual);
        }
      });
  }
};

window.cerrarMapa = function() {
  document.getElementById('modal-mapa').style.display = 'none';
  if (_taxiUnsub)  { _taxiUnsub();  _taxiUnsub  = null; }
  if (_viajeUnsub) { _viajeUnsub(); _viajeUnsub = null; }
  setLiveIndicator(false);
};

// ===== EDITAR ESTADO =====
let _editandoViajeId = null;

window.editarEstado = function(id) {
  if (!puedeEditarViajes()) return alert('No tienes permiso para editar viajes.');
  const v = viajesMap.get(id);
  if (!v) return;
  _editandoViajeId = id;

  const labelMap = {
    pendiente:  'Pendiente',
    aceptado:   'En curso',
    en_camino:  'En camino',
    finalizado: 'Finalizado',
    cancelado:  'Cancelado',
  };
  const estadoActual = (v.estado || 'pendiente').toLowerCase();

  document.getElementById('vest-info').innerHTML =
    `<span class="vest-info-row"><b>Origen:</b> ${v.origen || '—'}</span>` +
    `<span class="vest-info-row"><b>Destino:</b> ${v.destino || '—'}</span>` +
    `<span class="vest-info-row"><b>Taxista:</b> ${v.taxistaNombre || '—'}</span>` +
    `<span class="vest-info-row"><b>Estado actual:</b> ${labelMap[estadoActual] || estadoActual}</span>`;

  document.getElementById('vest-select').value = estadoActual;
  document.getElementById('modal-estado').style.display = 'flex';
};

window.cerrarModalEstado = function() {
  document.getElementById('modal-estado').style.display = 'none';
  _editandoViajeId = null;
};

window.guardarEstado = async function() {
  if (!_editandoViajeId) return;
  const nuevoEstado = document.getElementById('vest-select').value;
  const btn = document.getElementById('vest-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    await db.collection('viajes').doc(_editandoViajeId).update({ estado: nuevoEstado });
    cerrarModalEstado();
  } catch (e) {
    alert('Error al guardar: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
};

// Cerrar con Escape o clic fuera
document.getElementById('modal-estado')?.addEventListener('click', e => {
  if (e.target.id === 'modal-estado') cerrarModalEstado();
});

// ===== ELIMINAR VIAJE INDIVIDUAL =====
async function eliminarViaje(id) {
  if (!puedeEliminarViajes()) return alert('No tienes permiso para eliminar viajes.');
  if (!confirm('¿Eliminar este viaje pendiente? Esta acción no se puede deshacer.')) return;
  try {
    await db.collection('viajes').doc(id).delete();
    todosLosViajes = todosLosViajes.filter(v => v._id !== id);
    aplicarFiltro();
  } catch (e) {
    alert('Error al eliminar: ' + e.message);
  }
}

// ===== LIMPIAR PENDIENTES ABANDONADOS =====
document.getElementById('btn-limpiar-pendientes')?.addEventListener('click', () => {
  if (!puedeEliminarViajes()) return alert('No tienes permiso para eliminar viajes.');
  document.getElementById('limpiar-resultado').style.display = 'none';
  document.getElementById('modal-limpiar').style.display = 'flex';
});

function cerrarModalLimpiar() {
  document.getElementById('modal-limpiar').style.display = 'none';
}

async function limpiarPendientes() {
  const btn = document.getElementById('btn-confirmar-limpiar');
  const resultado = document.getElementById('limpiar-resultado');
  btn.disabled = true;
  btn.textContent = 'Eliminando...';

  try {
    // Traer todos los pendientes y filtrar en cliente
    // (evita índice compuesto y encuentra viajes sin fechaSolicitud)
    const snap = await db.collection('viajes')
      .where('estado', '==', 'pendiente')
      .get();

    const hace15min = new Date(Date.now() - 15 * 60 * 1000);
    const aEliminar = snap.docs.filter(doc => {
      const fecha = doc.data().fechaSolicitud?.toDate?.();
      // Eliminar si no tiene fecha O si tiene más de 15 min
      return !fecha || fecha < hace15min;
    });

    if (aEliminar.length === 0) {
      resultado.style.display = 'block';
      resultado.style.background = 'rgba(39,174,96,0.15)';
      resultado.style.color = '#27ae60';
      resultado.textContent = 'No hay viajes pendientes abandonados para eliminar.';
      btn.disabled = false;
      btn.textContent = 'Eliminar';
      return;
    }

    // Firestore batch tiene límite de 500 operaciones
    const chunks = [];
    for (let i = 0; i < aEliminar.length; i += 500)
      chunks.push(aEliminar.slice(i, i + 500));

    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    resultado.style.display = 'block';
    resultado.style.background = 'rgba(231,76,60,0.15)';
    resultado.style.color = '#e74c3c';
    resultado.textContent = `✓ ${aEliminar.length} viaje(s) pendiente(s) eliminado(s).`;
    btn.disabled = false;
    btn.textContent = 'Eliminar';
    setTimeout(cerrarModalLimpiar, 2000);

  } catch (e) {
    resultado.style.display = 'block';
    resultado.style.background = 'rgba(231,76,60,0.15)';
    resultado.style.color = '#e74c3c';
    resultado.textContent = 'Error: ' + e.message;
    btn.disabled = false;
    btn.textContent = 'Eliminar';
  }
}

document.getElementById('modal-limpiar')?.addEventListener('click', e => {
  if (e.target.id === 'modal-limpiar') cerrarModalLimpiar();
});

// ===== LOGOUT =====
document.getElementById('btn-logout')?.addEventListener('click', () => {
  localStorage.removeItem('taxi_admin_session');
  firebase.auth().signOut().finally(function() { window.location.href = 'login.html'; });
});

// ===== FECHA TOPBAR =====
const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
