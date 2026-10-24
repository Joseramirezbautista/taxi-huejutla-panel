// ===== ZONAS.JS =====
// Compat SDK

if (!localStorage.getItem('taxi_admin_session')) {
  window.location.href = 'login.html';
}

const db = firebase.firestore();

firebase.auth().onAuthStateChanged(function(user) {
  if (!user) { window.location.href = 'login.html'; }
});

// ===== LOGOUT =====
document.getElementById('btn-logout')?.addEventListener('click', () => {
  localStorage.removeItem('taxi_admin_session');
  firebase.auth().signOut().finally(function() { window.location.href = 'login.html'; });
});

// ===== FECHA =====
const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ===== RADIO DE NOTIFICACIÓN =====

function actualizarRadioUI(km) {
  const slider = document.getElementById('radio-slider');
  const input  = document.getElementById('radio-input');
  const badge  = document.getElementById('radio-badge');
  if (slider) slider.value = Math.min(km, 20);
  if (input)  input.value  = km;
  if (badge)  badge.textContent = km + ' km';
}

function cargarRadio() {
  db.collection('configuracion').doc('app').get().then(docSnap => {
    const km = docSnap.exists ? (docSnap.data().radioKm || 5) : 5;
    actualizarRadioUI(km);
  }).catch(() => actualizarRadioUI(5));
}

window.guardarRadio = function() {
  if (!(window.Permisos?.puede('zonas', 'editar') ?? true)) return alert('No tienes permiso para editar zonas.');
  const km = parseFloat(document.getElementById('radio-input').value);
  if (!km || km < 0.5) { alert('Ingresa un valor válido (mínimo 0.5 km)'); return; }
  const btn    = document.getElementById('btn-guardar-radio');
  const status = document.getElementById('radio-status');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  db.collection('configuracion').doc('app').set({ radioKm: km }, { merge: true })
    .then(() => {
      status.textContent = '✅ Radio actualizado a ' + km + ' km';
      status.style.color = '#3B6D11';
      actualizarRadioUI(km);
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(e => {
      status.textContent = '❌ Error: ' + e.message;
      status.style.color = '#dc2626';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    });
};

document.getElementById('radio-slider')?.addEventListener('input', e => {
  const val = parseFloat(e.target.value);
  document.getElementById('radio-input').value = val;
  document.getElementById('radio-badge').textContent = val + ' km';
});

document.getElementById('radio-input')?.addEventListener('input', e => {
  const val = parseFloat(e.target.value);
  if (!isNaN(val) && val >= 0.5) {
    document.getElementById('radio-slider').value = Math.min(val, 20);
    document.getElementById('radio-badge').textContent = val + ' km';
  }
});

cargarRadio();
setTimeout(iniciarMapaCentro, 100);

// ===== CENTRO DEL MAPA =====
let _mapaCentro    = null;
let _marcadorCentro = null;
let _circuloBusqueda = null;

function dibujarCirculoBusqueda(lat, lng, km) {
  if (_circuloBusqueda) { _mapaCentro.removeLayer(_circuloBusqueda); _circuloBusqueda = null; }
  _circuloBusqueda = L.circle([lat, lng], {
    radius: km * 1000,
    color: '#3B6D11',
    fillColor: '#3B6D11',
    fillOpacity: 0.08,
    weight: 2,
    dashArray: '8 5'
  }).bindPopup(`<b>Radio de búsqueda</b><br>${km} km`).addTo(_mapaCentro);
  _mapaCentro.fitBounds(_circuloBusqueda.getBounds(), { padding: [20, 20] });
}

function iniciarMapaCentro() {
  _mapaCentro = L.map('mapa-centro').setView([20.1170, -98.7312], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(_mapaCentro);
  setTimeout(() => _mapaCentro.invalidateSize(), 200);

  _marcadorCentro = L.marker([20.1170, -98.7312], { draggable: true })
    .addTo(_mapaCentro)
    .bindPopup('Centro del mapa')
    .openPopup();

  _marcadorCentro.on('dragend', e => {
    const pos = e.target.getLatLng();
    document.getElementById('centro-lat').value = pos.lat.toFixed(5);
    document.getElementById('centro-lng').value = pos.lng.toFixed(5);
    const km = parseFloat(document.getElementById('radio-busqueda-input').value) || 150;
    dibujarCirculoBusqueda(pos.lat, pos.lng, km);
  });

  _mapaCentro.on('click', e => {
    _marcadorCentro.setLatLng(e.latlng);
    document.getElementById('centro-lat').value = e.latlng.lat.toFixed(5);
    document.getElementById('centro-lng').value = e.latlng.lng.toFixed(5);
    const km = parseFloat(document.getElementById('radio-busqueda-input').value) || 150;
    dibujarCirculoBusqueda(e.latlng.lat, e.latlng.lng, km);
  });

  // Actualizar círculo al cambiar el input de radio
  document.getElementById('radio-busqueda-input')?.addEventListener('input', () => {
    const km  = parseFloat(document.getElementById('radio-busqueda-input').value) || 150;
    const lat = parseFloat(document.getElementById('centro-lat').value) || 20.1170;
    const lng = parseFloat(document.getElementById('centro-lng').value) || -98.7312;
    dibujarCirculoBusqueda(lat, lng, km);
  });

  // Cargar valores guardados desde Firebase
  db.collection('configuracion').doc('app').get().then(snap => {
    const d    = snap.exists ? snap.data() : {};
    const lat  = d.centroLat       || 20.1170;
    const lng  = d.centroLng       || -98.7312;
    const radio = d.radioBusquedaKm || 50;
    document.getElementById('centro-lat').value           = lat;
    document.getElementById('centro-lng').value           = lng;
    document.getElementById('radio-busqueda-input').value = radio;
    _marcadorCentro.setLatLng([lat, lng]);
    dibujarCirculoBusqueda(lat, lng, radio);
  });
}

window.guardarCentro = function() {
  if (!(window.Permisos?.puede('zonas', 'editar') ?? true)) return alert('No tienes permiso para editar zonas.');
  const lat   = parseFloat(document.getElementById('centro-lat').value);
  const lng   = parseFloat(document.getElementById('centro-lng').value);
  const radio = parseFloat(document.getElementById('radio-busqueda-input').value);
  const status = document.getElementById('centro-status');

  if (isNaN(lat) || isNaN(lng) || isNaN(radio)) {
    alert('Ingresa valores válidos'); return;
  }

  db.collection('configuracion').doc('app')
    .set({ centroLat: lat, centroLng: lng, radioBusquedaKm: radio }, { merge: true })
    .then(() => {
      status.textContent = '✅ Guardado';
      status.style.color = '#3B6D11';
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(e => {
      status.textContent = '❌ Error: ' + e.message;
      status.style.color = '#dc2626';
    });
};

// ===== CIUDADES DE DESPACHO =====
// Catálogo leído por Cloud Functions (despacho) y por la app del taxista
// (para etiquetar su ciudad actual en cada GPS tick) desde
// configuracion/ciudades → { lista: [{ id, nombre, lat, lng }, ...] }.
// Si el documento no existe todavía, se precarga este catálogo por defecto
// (principales ciudades de Hidalgo, de mayor a menor población) — el admin
// solo tiene que revisarlo y presionar Guardar una vez.
const CIUDADES_DEFAULT = [
  { id: 'pachuca',         nombre: 'Pachuca de Soto',          lat: 20.1011, lng: -98.7591 },
  { id: 'mineral_reforma', nombre: 'Mineral de la Reforma',    lat: 20.0989, lng: -98.7291 },
  { id: 'tulancingo',      nombre: 'Tulancingo de Bravo',      lat: 20.0873, lng: -98.3687 },
  { id: 'tizayuca',        nombre: 'Tizayuca',                 lat: 19.8347, lng: -98.9827 },
  { id: 'tula',            nombre: 'Tula de Allende',          lat: 20.0559, lng: -99.3378 },
  { id: 'huejutla',        nombre: 'Huejutla de Reyes',        lat: 21.1397, lng: -98.4197 },
  { id: 'tepeji',          nombre: 'Tepeji del Río de Ocampo', lat: 19.9061, lng: -99.3417 },
  { id: 'actopan',         nombre: 'Actopan',                  lat: 20.2686, lng: -98.9436 },
  { id: 'ixmiquilpan',     nombre: 'Ixmiquilpan',              lat: 20.4842, lng: -99.2161 },
  { id: 'apan',            nombre: 'Apan',                     lat: 19.7167, lng: -98.4500 },
];

function idDesdeNombreCiudad(nombre) {
  const base = (nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || ('ciudad_' + Date.now());
}

let _ciudadesEnEdicion = [];

function filaCiudadHTML(c, i) {
  const nombreEsc = (c.nombre || '').replace(/"/g, '&quot;');
  return `
    <div class="ciudad-fila" data-idx="${i}" style="display:flex;gap:8px;align-items:center;">
      <input type="text" class="ciudad-nombre" value="${nombreEsc}" placeholder="Nombre de la ciudad"
        style="flex:1;border:1px solid #e0e0e0;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;">
      <input type="number" class="ciudad-lat" value="${c.lat ?? ''}" step="0.0001" placeholder="Latitud"
        style="width:120px;border:1px solid #e0e0e0;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;">
      <input type="number" class="ciudad-lng" value="${c.lng ?? ''}" step="0.0001" placeholder="Longitud"
        style="width:120px;border:1px solid #e0e0e0;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;">
      <button type="button" onclick="eliminarFilaCiudad(${i})" title="Eliminar"
        style="border:none;background:none;color:#dc2626;font-size:18px;cursor:pointer;padding:4px 8px;">✕</button>
    </div>`;
}

function renderCiudades() {
  const cont = document.getElementById('ciudades-lista');
  if (!cont) return;
  cont.innerHTML = _ciudadesEnEdicion.map(filaCiudadHTML).join('');
}

window.agregarFilaCiudad = function() {
  if (!(window.Permisos?.puede('zonas', 'editar') ?? true)) return alert('No tienes permiso para editar zonas.');
  _ciudadesEnEdicion.push({ nombre: '', lat: '', lng: '' });
  renderCiudades();
};

window.eliminarFilaCiudad = function(i) {
  if (!(window.Permisos?.puede('zonas', 'editar') ?? true)) return alert('No tienes permiso para editar zonas.');
  _ciudadesEnEdicion.splice(i, 1);
  renderCiudades();
};

function cargarCiudades() {
  db.collection('configuracion').doc('ciudades').get().then(snap => {
    const lista = snap.exists ? (snap.data().lista || []) : null;
    _ciudadesEnEdicion = (lista && lista.length > 0) ? lista.slice() : CIUDADES_DEFAULT.slice();
    renderCiudades();
  }).catch(() => {
    _ciudadesEnEdicion = CIUDADES_DEFAULT.slice();
    renderCiudades();
  });
}

window.guardarCiudades = function() {
  if (!(window.Permisos?.puede('zonas', 'editar') ?? true)) return alert('No tienes permiso para editar zonas.');
  const filas = document.querySelectorAll('#ciudades-lista .ciudad-fila');
  const lista = [];
  filas.forEach(fila => {
    const nombre = fila.querySelector('.ciudad-nombre').value.trim();
    const lat = parseFloat(fila.querySelector('.ciudad-lat').value);
    const lng = parseFloat(fila.querySelector('.ciudad-lng').value);
    if (!nombre || isNaN(lat) || isNaN(lng)) return; // fila incompleta, se omite
    lista.push({ id: idDesdeNombreCiudad(nombre), nombre, lat, lng });
  });
  if (lista.length === 0) {
    alert('Agrega al menos una ciudad con nombre, latitud y longitud válidos.');
    return;
  }

  const btn    = document.getElementById('btn-guardar-ciudades');
  const status = document.getElementById('ciudades-status');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  db.collection('configuracion').doc('ciudades').set({ lista }, { merge: true })
    .then(() => {
      status.textContent = `✅ ${lista.length} ciudades guardadas`;
      status.style.color = '#3B6D11';
      _ciudadesEnEdicion = lista;
      renderCiudades();
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(e => {
      status.textContent = '❌ Error: ' + e.message;
      status.style.color = '#dc2626';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Guardar catálogo';
    });
};

cargarCiudades();
