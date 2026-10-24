// ===== HISTORIAL-CLIENTE.JS =====
if (!localStorage.getItem('taxi_admin_session')) {
  window.location.href = 'login.html';
}

const db         = firebase.firestore();
const params     = new URLSearchParams(window.location.search);
const CLIENTE_ID = params.get('id') || sessionStorage.getItem('historial_cliente_id');

if (!CLIENTE_ID || CLIENTE_ID === 'null' || CLIENTE_ID === 'undefined') {
  window.location.href = 'clientes.html';
}

let todosLosViajes = [];
let filtroActivo   = 'todos';
const viajesMap    = new Map();

// ===== HELPERS =====
function formatCurrency(n) {
  return '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFecha(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

const badgeMap = {
  pendiente:  'badge-pendiente',
  aceptado:   'badge-en-viaje',
  en_camino:  'badge-en-viaje',
  finalizado: 'badge-finalizado',
  cancelado:  'badge-cancelado',
};
const labelMap = {
  pendiente:  'Pendiente',
  aceptado:   'En curso',
  en_camino:  'En camino',
  finalizado: 'Finalizado',
  cancelado:  'Cancelado',
};

// ===== CARGAR DATOS (esperar auth) =====
firebase.auth().onAuthStateChanged(function(user) {
  if (!user) { window.location.href = 'login.html'; return; }

  db.collection('clientes').doc(CLIENTE_ID).get().then(snap => {
    if (!snap.exists) return;
    const c      = snap.data();
    const nombre = ((c.nombre || '') + ' ' + (c.apellidos || '')).trim() || '—';

    // Avatar / foto
    const foto    = document.getElementById('h-foto');
    const initEl  = document.getElementById('h-initials');
    if (c.fotoUrl) {
      foto.src           = c.fotoUrl;
      foto.style.display = 'block';
      initEl.style.display = 'none';
    } else {
      initEl.textContent   = initials(nombre);
      initEl.style.display = 'inline';
    }

    document.getElementById('h-nombre').textContent = nombre;
    document.getElementById('h-sub').textContent    =
      [c.telefono, c.correo, c.colonia].filter(Boolean).join('  ·  ') || '—';

    const badge = document.getElementById('h-badge');
    badge.textContent = c.bloqueado ? 'Bloqueado' : 'Activo';
    badge.className   = c.bloqueado ? 'badge badge-suspendido' : 'badge badge-activo';

    document.getElementById('h-calificacion').textContent =
      '⭐ ' + (parseFloat(c.calificaciones) || 0).toFixed(1);
    document.getElementById('card-cliente').style.display = '';
  });

  db.collection('viajes')
    .where('clienteId', '==', CLIENTE_ID)
    .onSnapshot(snap => {
      viajesMap.clear();
      todosLosViajes = snap.docs.map(d => {
        const obj = { _id: d.id, ...d.data() };
        viajesMap.set(d.id, obj);
        return obj;
      });
      todosLosViajes.sort((a, b) => {
        const ta = a.fechaSolicitud?.toDate?.()?.getTime() ?? 0;
        const tb = b.fechaSolicitud?.toDate?.()?.getTime() ?? 0;
        return tb - ta;
      });
      actualizarStats();
      aplicarFiltros();
    }, err => {
      console.error('Error cargando viajes:', err);
      document.getElementById('tbody-historial').innerHTML =
        `<tr><td colspan="7" style="color:#E24B4A;padding:20px;text-align:center;">Error al cargar: ${err.message}</td></tr>`;
    });
});

// ===== STATS =====
function actualizarStats() {
  const finalizados = todosLosViajes.filter(v => (v.estado || '').toLowerCase() === 'finalizado');
  const cancelados  = todosLosViajes.filter(v => (v.estado || '').toLowerCase() === 'cancelado');
  const gastado     = finalizados.reduce((s, v) => s + (v.tarifa || 0), 0);

  document.getElementById('h-total').textContent     = todosLosViajes.length;
  document.getElementById('h-gastado').textContent   = formatCurrency(gastado);
  document.getElementById('h-cancelados').textContent = cancelados.length;
}

// ===== FILTRAR =====
function aplicarFiltros() {
  let lista = [...todosLosViajes];
  if (filtroActivo !== 'todos') {
    lista = lista.filter(v => (v.estado || '').toLowerCase() === filtroActivo);
  }
  renderTabla(lista);
}

// ===== RENDER =====
function renderTabla(lista) {
  const tbody   = document.getElementById('tbody-historial');
  const countEl = document.getElementById('count-viajes');
  const totalEl = document.getElementById('total-gastado');

  if (countEl) countEl.textContent = lista.length;

  const totalFin = lista
    .filter(v => (v.estado || '').toLowerCase() === 'finalizado')
    .reduce((s, v) => s + (v.tarifa || 0), 0);
  if (totalEl) totalEl.textContent = formatCurrency(totalFin);

  if (lista.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <div class="empty-icon">🗺️</div>
          <p>No hay viajes con este filtro</p>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  lista.forEach(v => {
    const estado = (v.estado || '').toLowerCase();
    const ruta   = tieneCoordenadas(v);
    tbody.innerHTML += `
      <tr>
        <td class="td-bold">${v.origen  || '—'}</td>
        <td>${v.destino || '—'}</td>
        <td>
          <div style="font-size:13px;">${v.taxistaNombre || '—'}</div>
        </td>
        <td><strong>${formatCurrency(v.tarifa)}</strong></td>
        <td><span class="badge ${badgeMap[estado] || 'badge-pendiente'}">${labelMap[estado] || v.estado || '—'}</span></td>
        <td style="color:#aaa;font-size:12.5px;">${formatFecha(v.fechaSolicitud)}</td>
        <td>${ruta ? `<button type="button" class="btn btn-outline btn-sm" onclick="verRuta('${v._id}')">🗺 Ruta</button>` : ''}</td>
      </tr>`;
  });
}

// ===== FILTROS UI =====
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtroActivo = btn.dataset.filtro;
    aplicarFiltros();
  });
});

// ===== MAPA =====
let _map = null, _markers = [], _routeLine = null;

function extraerOrigen(v) {
  if (typeof v.clienteLat === 'number') return { lat: v.clienteLat, lng: v.clienteLng };
  if (typeof v.origenLat  === 'number') return { lat: v.origenLat,  lng: v.origenLng  };
  return null;
}
function extraerDestino(v) {
  if (typeof v.destinoLat === 'number') return { lat: v.destinoLat, lng: v.destinoLng };
  return null;
}
function tieneCoordenadas(v) { return !!(extraerOrigen(v) && extraerDestino(v)); }

function mkIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
}

window.verRuta = async function(id) {
  const v = viajesMap.get(id);
  if (!v) return;
  const orig = extraerOrigen(v);
  const dest = extraerDestino(v);
  if (!orig || !dest) { alert('Sin coordenadas registradas'); return; }

  document.getElementById('mapa-origen').textContent  = v.origen  || `${orig.lat.toFixed(5)}, ${orig.lng.toFixed(5)}`;
  document.getElementById('mapa-destino').textContent = v.destino || `${dest.lat.toFixed(5)}, ${dest.lng.toFixed(5)}`;
  document.getElementById('mapa-taxista').textContent = v.taxistaNombre || '—';
  document.getElementById('mapa-tarifa').textContent  = formatCurrency(v.tarifa);
  document.getElementById('modal-mapa').style.display = 'flex';

  await new Promise(r => setTimeout(r, 50));

  if (!_map) {
    _map = L.map('leaflet-map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_map);
  }
  _map.invalidateSize();
  _markers.forEach(m => _map.removeLayer(m));
  _markers = [];
  if (_routeLine) { _map.removeLayer(_routeLine); _routeLine = null; }

  const mOrig = L.marker([orig.lat, orig.lng], { icon: mkIcon('#3B6D11') }).bindPopup('<b>Origen</b>').addTo(_map);
  const mDest = L.marker([dest.lat, dest.lng], { icon: mkIcon('#A32D2D') }).bindPopup('<b>Destino</b>').addTo(_map);
  _markers = [mOrig, mDest];
  _map.fitBounds([[orig.lat, orig.lng], [dest.lat, dest.lng]], { padding: [50, 50] });

  try {
    const res  = await fetch(`https://router.project-osrm.org/route/v1/driving/${orig.lng},${orig.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`);
    const data = await res.json();
    if (data.routes?.[0]) {
      const coords = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      _routeLine = L.polyline(coords, { color: '#3B6D11', weight: 4, opacity: .85 }).addTo(_map);
      _map.fitBounds(_routeLine.getBounds(), { padding: [50, 50] });
    }
  } catch {
    _routeLine = L.polyline([[orig.lat, orig.lng], [dest.lat, dest.lng]],
      { color: '#3B6D11', weight: 3, dashArray: '8 6', opacity: .7 }).addTo(_map);
  }
};

window.cerrarMapa = function() {
  document.getElementById('modal-mapa').style.display = 'none';
};

// ===== LOGOUT + FECHA =====
document.getElementById('btn-logout')?.addEventListener('click', () => {
  localStorage.removeItem('taxi_admin_session');
  firebase.auth().signOut().finally(function() { window.location.href = 'login.html'; });
});

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
