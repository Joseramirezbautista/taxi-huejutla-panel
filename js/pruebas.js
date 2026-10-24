// ===== PRUEBAS.JS =====
if (!localStorage.getItem('taxi_admin_session')) {
  window.location.href = 'login.html';
}

const db = firebase.firestore();

let _mapa        = null;
let _puntos      = [];       // [{lat, lng}]
let _marcadores  = [];       // Leaflet markers
let _polyline    = null;
let _simTimer    = null;
let _simIndex    = 0;

// ── MAPA ──────────────────────────────────────────────────────────────────
// Este script se inyecta dinámicamente DESPUÉS de que Firebase Auth
// confirma la sesión (ver pruebas.html) — para entonces el evento 'load'
// de la ventana ya pasó hace rato, así que esperar a 'load' aquí nunca
// dispara nada (mapa en blanco, "Cargando..." fijo). El DOM ya existe
// completo en este punto, así que se inicializa directo.
function iniciarPruebas() {
  _mapa = L.map('mapa-prueba').setView([20.117, -98.731], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19
  }).addTo(_mapa);

  _mapa.on('click', e => agregarPunto(e.latlng.lat, e.latlng.lng));

  cargarTaxistas();
  cargarViajes();

  const fechaEl = document.getElementById('fecha-actual');
  if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
iniciarPruebas();

// ── CARGAR TAXISTAS ───────────────────────────────────────────────────────
function cargarTaxistas() {
  db.collection('taxistas').get().then(snap => {
    const sel = document.getElementById('sel-taxista');
    sel.innerHTML = '<option value="">— Selecciona taxista —</option>';
    snap.forEach(d => {
      const t = d.data();
      const nombre = ((t.nombre || '') + ' ' + (t.apellidos || '')).trim() || d.id;
      sel.innerHTML += `<option value="${d.id}">${nombre}</option>`;
    });
  }).catch(() => {});
}

// ── CARGAR VIAJES ACTIVOS ─────────────────────────────────────────────────
function cargarViajes() {
  db.collection('viajes')
    .where('estado', 'in', ['aceptado', 'en_camino'])
    .get().then(snap => {
      const sel = document.getElementById('sel-viaje');
      sel.innerHTML = '<option value="">Sin viaje activo</option>';
      snap.forEach(d => {
        const v = d.data();
        const label = `${v.origen || '—'} → ${v.destino || '—'}`;
        sel.innerHTML += `<option value="${d.id}">${label}</option>`;
      });
    }).catch(() => {});
}

// ── AGREGAR PUNTO ─────────────────────────────────────────────────────────
function agregarPunto(lat, lng) {
  const n = _puntos.length + 1;
  _puntos.push({ lat, lng });

  const m = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="background:#3B6D11;color:#fff;border-radius:50%;width:24px;height:24px;
             display:flex;align-items:center;justify-content:center;font-size:11px;
             font-weight:bold;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${n}</div>`,
      iconSize: [24, 24], iconAnchor: [12, 12]
    })
  }).addTo(_mapa).bindPopup(`Punto ${n}<br>${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  _marcadores.push(m);

  actualizarPolyline();
  actualizarListaPuntos();
}

function actualizarPolyline() {
  if (_polyline) { _mapa.removeLayer(_polyline); _polyline = null; }
  if (_puntos.length >= 2) {
    _polyline = L.polyline(_puntos.map(p => [p.lat, p.lng]), {
      color: '#3B6D11', weight: 3, dashArray: '8 4', opacity: 0.7
    }).addTo(_mapa);
    _mapa.fitBounds(_polyline.getBounds(), { padding: [40, 40] });
  }
}

function actualizarListaPuntos() {
  const el = document.getElementById('puntos-lista');
  if (_puntos.length === 0) {
    el.innerHTML = '<span style="color:#bbb;font-size:12px;">Haz clic en el mapa para agregar puntos de la ruta...</span>';
    return;
  }
  // Ruta real trazada: son demasiados puntos para listarlos uno a uno.
  if (_puntos.length > 20) {
    el.innerHTML = `<span style="color:#555;font-size:12px;">
      🧭 ${_puntos.length} puntos de ruta real (origen → destino).
      <button onclick="limpiarPuntos()" style="border:none;background:none;color:#1565C0;cursor:pointer;text-decoration:underline;font-size:12px;">Limpiar y volver a marcar</button>
    </span>`;
    return;
  }
  el.innerHTML = _puntos.map((p, i) => `
    <span class="punto-tag">
      📍 ${i + 1}: ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}
      <button onclick="eliminarPunto(${i})" title="Eliminar">✕</button>
    </span>
  `).join('');
}

// ── RUTA REAL (Directions API vía Cloud Function) ───────────────────────────
function distanciaHaversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function puntoEnDistancia(puntos, acumuladas, objetivo) {
  for (let i = 1; i < acumuladas.length; i++) {
    if (acumuladas[i] >= objetivo) {
      const segInicio = acumuladas[i - 1];
      const segFin = acumuladas[i];
      const t = segFin > segInicio ? (objetivo - segInicio) / (segFin - segInicio) : 0;
      const a = puntos[i - 1], b = puntos[i];
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
  }
  return puntos[puntos.length - 1];
}

// Divide la polyline real en puntos espaciados uniformemente en el TIEMPO
// (no solo en distancia), asumiendo velocidad promedio constante = la que
// ya calculó Directions API para toda la ruta. Así, reproducir estos
// puntos cada `intervaloSegundos` hace que el recorrido tarde lo mismo
// que tardaría de verdad, con movimiento suave (sin saltos entre calles).
function interpolarRutaPorTiempo(puntosRuta, duracionSegundos, intervaloSegundos) {
  const acumuladas = [0];
  for (let i = 1; i < puntosRuta.length; i++) {
    acumuladas.push(acumuladas[i - 1] + distanciaHaversineM(puntosRuta[i - 1], puntosRuta[i]));
  }
  const distanciaReal = acumuladas[acumuladas.length - 1] || 0;
  if (distanciaReal === 0) return puntosRuta;

  const numPasos = Math.max(2, Math.ceil(duracionSegundos / intervaloSegundos));
  const resultado = [];
  for (let i = 0; i <= numPasos; i++) {
    const objetivo = distanciaReal * (i / numPasos);
    resultado.push(puntoEnDistancia(puntosRuta, acumuladas, objetivo));
  }
  return resultado;
}

window.trazarRutaReal = async function () {
  if (_puntos.length < 2) {
    alert('Marca al menos 2 puntos en el mapa: el primero será el origen y el último el destino.');
    return;
  }
  const origen = _puntos[0];
  const destino = _puntos[_puntos.length - 1];
  const intervalo = parseInt(document.getElementById('intervalo').value, 10) || 10;

  const btn = document.getElementById('btn-trazar');
  btn.disabled = true;
  setLog('🧭 Consultando ruta real…');

  try {
    const fn = firebase.functions().httpsCallable('obtenerRutaSimulada');
    const res = await fn({ origen, destino });
    const { puntos, distanciaMetros, duracionSegundos } = res.data;

    const nuevos = interpolarRutaPorTiempo(puntos, duracionSegundos, intervalo);

    // Reemplaza los puntos manuales por la ruta real interpolada
    _marcadores.forEach(m => _mapa.removeLayer(m));
    _marcadores = [];
    _puntos = nuevos;
    nuevos.forEach(p => {
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:#1565C0;border-radius:50%;width:8px;height:8px;border:1px solid #fff;"></div>`,
          iconSize: [8, 8], iconAnchor: [4, 4]
        })
      }).addTo(_mapa);
      _marcadores.push(m);
    });
    actualizarPolyline();
    actualizarListaPuntos();

    const km = (distanciaMetros / 1000).toFixed(1);
    const min = Math.round(duracionSegundos / 60);
    setLog(`✅ Ruta real: ${km} km · ~${min} min · ${nuevos.length} puntos cada ${intervalo}s`);
  } catch (e) {
    setLog(`❌ Error trazando ruta: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
};

window.eliminarPunto = function(i) {
  _puntos.splice(i, 1);
  _marcadores.forEach(m => _mapa.removeLayer(m));
  _marcadores = [];
  _puntos.forEach((p, j) => {
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="background:#3B6D11;color:#fff;border-radius:50%;width:24px;height:24px;
               display:flex;align-items:center;justify-content:center;font-size:11px;
               font-weight:bold;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${j+1}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12]
      })
    }).addTo(_mapa);
    _marcadores.push(m);
  });
  actualizarPolyline();
  actualizarListaPuntos();
};

window.limpiarPuntos = function() {
  _puntos = [];
  _marcadores.forEach(m => _mapa.removeLayer(m));
  _marcadores = [];
  if (_polyline) { _mapa.removeLayer(_polyline); _polyline = null; }
  actualizarListaPuntos();
  setLog('Ruta limpiada');
};

// ── SIMULACIÓN ────────────────────────────────────────────────────────────
window.iniciarSimulacion = function() {
  if (!(window.Permisos?.puede('pruebas', 'editar') ?? true)) return alert('No tienes permiso para usar el simulador.');
  const taxistaId = document.getElementById('sel-taxista').value;
  const viajeId   = document.getElementById('sel-viaje').value;
  const intervalo = parseInt(document.getElementById('intervalo').value) * 1000;

  if (!taxistaId) { alert('Selecciona un taxista'); return; }
  if (_puntos.length < 2) { alert('Agrega al menos 2 puntos en el mapa'); return; }

  _simIndex = 0;
  document.getElementById('btn-iniciar').disabled = true;
  document.getElementById('btn-detener').disabled = false;
  setEstado(true);
  setLog(`Iniciando simulación con ${_puntos.length} puntos...`);

  _simTimer = setInterval(async () => {
    if (_simIndex >= _puntos.length) {
      detenerSimulacion();
      setLog('✅ Simulación completada');
      return;
    }

    const punto = _puntos[_simIndex];
    _simIndex++;

    try {
      await db.collection('taxistas').doc(taxistaId).update({
        lat: punto.lat,
        lng: punto.lng,
        ultimaUbicacion: firebase.firestore.FieldValue.serverTimestamp(),
      });

      if (viajeId) {
        await db.collection('viajes').doc(viajeId).update({
          rutaRecorrida: firebase.firestore.FieldValue.arrayUnion({ lat: punto.lat, lng: punto.lng }),
        });
      }

      setLog(`📍 Punto ${_simIndex}/${_puntos.length} → ${punto.lat.toFixed(5)}, ${punto.lng.toFixed(5)}`);
    } catch (e) {
      setLog(`❌ Error: ${e.message}`);
    }
  }, intervalo);
};

window.detenerSimulacion = function() {
  if (_simTimer) { clearInterval(_simTimer); _simTimer = null; }
  document.getElementById('btn-iniciar').disabled = false;
  document.getElementById('btn-detener').disabled = true;
  setEstado(false);
  setLog('■ Simulación detenida en punto ' + _simIndex + '/' + _puntos.length);
};

function setEstado(activo) {
  const dot   = document.getElementById('sim-dot');
  const label = document.getElementById('sim-estado');
  dot.className   = 'prueba-status' + (activo ? ' activo' : '');
  label.textContent = activo ? 'Simulando...' : 'Detenido';
}

function setLog(msg) {
  document.getElementById('sim-log').textContent = msg;
}

// ── LOGOUT ────────────────────────────────────────────────────────────────
document.getElementById('btn-logout')?.addEventListener('click', () => {
  localStorage.removeItem('taxi_admin_session');
  firebase.auth().signOut().finally(function() { window.location.href = 'login.html'; });
});
