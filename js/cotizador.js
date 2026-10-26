// ===== COTIZADOR.JS =====
// Cotiza un viaje con LA MISMA formula que la app del pasajero
// (configuracion/tarifas: base + km x porKm + minutos x porMinuto, con
// tarifa minima; Prioridad = x1.3) y simula promociones.
//
// Tambien crea viajes de PRUEBA reales: un documento en viajes/ igual al que
// crea la app del pasajero, marcado con esPrueba. El servidor lo despacha
// como cualquier otro (alerta a conductores, Centro de viajes, promociones).
//
// La ruta sale de OSRM (gratis, el mismo que ya usa el panel). La app usa
// Google, asi que la distancia puede variar un poco.
import { db, auth } from './app.js';
import { Auth } from './auth.js';
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, onSnapshot,
  query, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js';

Auth.protect();

const MULTIPLICADOR_PRIORIDAD = 1.3; // igual que la app del pasajero
const $ = (id) => document.getElementById(id);

let tarifas = { base: 25, porKm: 9, porMinuto: 0.5, minima: 40 }; // los de la app si no hay config
let promos = []; // [{ id, data }]
let servicio = 'x';
let puntoActivo = 'origen';
const puntos = { origen: null, destino: null }; // { lat, lng, texto }
let ruta = null; // { metros, segundos, linea }

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== MAPA =====
const mapa = L.map('mapa-cot').setView([20.1170, -98.7312], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap',
}).addTo(mapa);
setTimeout(() => mapa.invalidateSize(), 200);

const icono = (color, cuadrado) => L.divIcon({
  className: '',
  html: `<div style="width:18px;height:18px;border-radius:${cuadrado ? '4px' : '50%'};background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
  iconSize: [18, 18], iconAnchor: [9, 9],
});
const marcadores = {
  origen: L.marker([0, 0], { icon: icono('#2F8F46', false) }),
  destino: L.marker([0, 0], { icon: icono('#C1443C', true) }),
};
let lineaRuta = null;

function activar(cual) {
  puntoActivo = cual;
  $('punto-origen').classList.toggle('activo', cual === 'origen');
  $('punto-destino').classList.toggle('activo', cual === 'destino');
  $('ayuda-mapa').innerHTML = `Toca el mapa para poner el <b>${cual}</b>.`;
}
$('inp-origen').addEventListener('focus', () => activar('origen'));
$('inp-destino').addEventListener('focus', () => activar('destino'));

async function nombreDe(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es&zoom=17`);
    const j = await r.json();
    const a = j.address || {};
    const partes = [a.road && (a.house_number ? `${a.road} ${a.house_number}` : a.road), a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean);
    return partes.length ? partes.join(', ') : (j.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  } catch {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

async function ponerPunto(cual, lat, lng, texto) {
  puntos[cual] = { lat, lng, texto: texto || '' };
  marcadores[cual].setLatLng([lat, lng]).addTo(mapa);
  const inp = $(cual === 'origen' ? 'inp-origen' : 'inp-destino');
  if (!texto) {
    inp.value = 'Buscando dirección...';
    puntos[cual].texto = await nombreDe(lat, lng);
  }
  inp.value = puntos[cual].texto;
  if (cual === 'origen' && !puntos.destino) activar('destino');
  await calcularRuta();
}

mapa.on('click', (e) => ponerPunto(puntoActivo, e.latlng.lat, e.latlng.lng));

document.querySelectorAll('[data-buscar]').forEach((b) => b.addEventListener('click', () => buscar(b.dataset.buscar)));
// ===== SUGERENCIAS MIENTRAS ESCRIBES =====
// Photon (OpenStreetMap) esta hecho para autocompletar; Nominatim lo prohibe
// en sus reglas de uso, por eso el boton Buscar sigue usando Nominatim y las
// sugerencias usan Photon. Se pide 350 ms despues de dejar de teclear, con 3
// letras o mas, y se prefieren lugares cerca de lo que se ve en el mapa.
const sugerencias = { origen: [], destino: [] };
const activa = { origen: -1, destino: -1 };
const temporizador = {};
let consulta = 0;

function cajaSug(cual) {
  const inp = $(cual === 'origen' ? 'inp-origen' : 'inp-destino');
  let caja = inp.parentElement.querySelector('.cot-sug');
  if (!caja) {
    caja = document.createElement('div');
    caja.className = 'cot-sug';
    caja.setAttribute('role', 'listbox');
    inp.parentElement.appendChild(caja);
  }
  return caja;
}

function cerrarSug(cual) {
  sugerencias[cual] = [];
  activa[cual] = -1;
  cajaSug(cual).style.display = 'none';
}

function textoLugar(p) {
  const calle = p.street ? (p.housenumber ? `${p.street} ${p.housenumber}` : p.street) : '';
  const titulo = p.name || calle || p.district || p.city || '';
  const detalle = [p.name && calle ? calle : '', p.district || p.locality, p.city || p.county, p.state]
    .filter((x) => x && x !== titulo).join(', ');
  return { titulo, detalle };
}

function pintarSug(cual) {
  const caja = cajaSug(cual);
  const lista = sugerencias[cual];
  if (!lista.length) { caja.style.display = 'none'; return; }
  caja.innerHTML = lista.map((s, i) => `<button type="button" role="option" class="${i === activa[cual] ? 'activa' : ''}" data-sug="${cual}:${i}">
    <b>${esc(s.titulo)}</b>${s.detalle ? `<span>${esc(s.detalle)}</span>` : ''}</button>`).join('');
  caja.style.display = 'block';
}

async function pedirSug(cual, q) {
  const id = ++consulta;
  try {
    const c = mapa.getCenter();
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat}&lon=${c.lng}`);
    const j = await r.json();
    if (id !== consulta) return; // ya se escribio otra cosa
    sugerencias[cual] = (j.features || [])
      .filter((f) => (f.properties?.countrycode || 'MX') === 'MX')
      .map((f) => ({ ...textoLugar(f.properties || {}), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }))
      .filter((s) => s.titulo);
    activa[cual] = -1;
    pintarSug(cual);
  } catch {
    cerrarSug(cual);
  }
}

async function elegirSug(cual, i) {
  const s = sugerencias[cual][i];
  if (!s) return;
  cerrarSug(cual);
  activar(cual);
  mapa.setView([s.lat, s.lng], 15);
  await ponerPunto(cual, s.lat, s.lng, s.detalle ? `${s.titulo}, ${s.detalle}` : s.titulo);
}

['origen', 'destino'].forEach((cual) => {
  const inp = $(cual === 'origen' ? 'inp-origen' : 'inp-destino');
  inp.setAttribute('autocomplete', 'off');
  inp.addEventListener('input', () => {
    clearTimeout(temporizador[cual]);
    const q = inp.value.trim();
    if (q.length < 3) { cerrarSug(cual); return; }
    temporizador[cual] = setTimeout(() => pedirSug(cual, q), 350);
  });
  inp.addEventListener('keydown', (e) => {
    const n = sugerencias[cual].length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); activa[cual] = (activa[cual] + 1) % n; pintarSug(cual); return; }
    if (e.key === 'ArrowUp' && n) { e.preventDefault(); activa[cual] = (activa[cual] - 1 + n) % n; pintarSug(cual); return; }
    if (e.key === 'Escape') { cerrarSug(cual); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (n) { elegirSug(cual, activa[cual] >= 0 ? activa[cual] : 0); return; }
      buscar(cual);
    }
  });
  // Al salir del campo se cierra la lista (con un respiro para que el clic
  // en una sugerencia alcance a registrarse).
  inp.addEventListener('blur', () => setTimeout(() => cerrarSug(cual), 200));
});
document.addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-sug]');
  if (!b) return;
  e.preventDefault();
  const [cual, i] = b.dataset.sug.split(':');
  elegirSug(cual, Number(i));
});

async function buscar(cual) {
  const inp = $(cual === 'origen' ? 'inp-origen' : 'inp-destino');
  const q = inp.value.trim();
  if (!q) return;
  activar(cual);
  try {
    const c = mapa.getCenter();
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=es&countrycodes=mx&viewbox=${c.lng - 0.5},${c.lat + 0.5},${c.lng + 0.5},${c.lat - 0.5}`);
    const j = await r.json();
    if (!j.length) { inp.value = q; return alert('No se encontró esa dirección. Prueba con otra o toca el mapa.'); }
    const lat = Number(j[0].lat), lng = Number(j[0].lon);
    mapa.setView([lat, lng], 15);
    await ponerPunto(cual, lat, lng, q);
  } catch {
    alert('No se pudo buscar la dirección.');
  }
}

async function calcularRuta() {
  if (!puntos.origen || !puntos.destino) { pintar(); return; }
  $('badge-ruta').textContent = 'Calculando...';
  try {
    const o = puntos.origen, d = puntos.destino;
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`);
    const j = await r.json();
    const rt = j.routes?.[0];
    if (!rt) throw new Error('sin ruta');
    ruta = { metros: rt.distance, segundos: rt.duration, linea: rt.geometry.coordinates.map(([x, y]) => [y, x]) };
    if (lineaRuta) mapa.removeLayer(lineaRuta);
    lineaRuta = L.polyline(ruta.linea, { color: '#E8A33D', weight: 5 }).addTo(mapa);
    mapa.fitBounds(lineaRuta.getBounds(), { padding: [30, 30] });
    $('badge-ruta').textContent = `${(ruta.metros / 1000).toFixed(1)} km`;
  } catch {
    ruta = null;
    $('badge-ruta').textContent = 'Sin ruta';
  }
  pintar();
}

// ===== LIMPIAR =====
// Borra origen, destino y ruta para cotizar otro viaje sin recargar la
// pagina. Servicio, promocion, radio y nombre se quedan como estaban.
function limpiar() {
  for (const cual of ['origen', 'destino']) {
    puntos[cual] = null;
    mapa.removeLayer(marcadores[cual]);
    $(cual === 'origen' ? 'inp-origen' : 'inp-destino').value = '';
  }
  if (lineaRuta) { mapa.removeLayer(lineaRuta); lineaRuta = null; }
  ruta = null;
  $('badge-ruta').textContent = 'Sin ruta';
  $('aviso-crear').style.display = 'none';
  activar('origen');
  pintar();
}
$('btn-limpiar').addEventListener('click', limpiar);

// ===== CONDUCTORES EN LINEA =====
// Se ven en el mapa para poner el origen de la prueba junto a uno de ellos:
// asi el tramo conductor -> pasajero de la alerta queda corto, como en un
// viaje real. Se leen una vez (boton Actualizar), no en vivo: cada
// movimiento de GPS seria una lectura mas.
const capaConductores = L.layerGroup().addTo(mapa);
let conductores = [];
let yaEncuadrado = false;
const ESTADO_COND = { disponible: ['En línea', '#EAF3DE', '#27500A'], ocupado: ['En viaje', '#FAEEDA', '#633806'] };

const iconoConductor = (nombre) => L.divIcon({
  className: '',
  html: `<div style="display:flex;flex-direction:column;align-items:center;">
    <div style="background:#1a1a2e;color:#F5C842;font:700 11px Inter,sans-serif;padding:2px 8px;border-radius:9px;white-space:nowrap;">${esc(nombre)}</div>
    <div style="width:16px;height:16px;border-radius:50%;background:#F5C842;border:3px solid #1a1a2e;margin-top:2px;"></div></div>`,
  iconSize: [140, 42], iconAnchor: [70, 40],
});

function haceCuanto(ts) {
  const d = ts?.toDate?.();
  if (!d) return 'sin hora';
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  return min < 1 ? 'ubicación de hace menos de 1 min' : min < 60 ? `ubicación de hace ${min} min` : `ubicación de hace ${Math.round(min / 60)} h`;
}

async function cargarConductores() {
  $('btn-actualizar-cond').disabled = true;
  try {
    const snap = await getDocs(query(collection(db, 'taxistas'), where('estado', 'in', ['disponible', 'ocupado'])));
    conductores = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number');
    pintarConductores();
  } catch (e) {
    $('lista-conductores').innerHTML = `<div class="cot-muted" style="color:#c00;">No se pudieron cargar: ${esc(e.message)}</div>`;
  } finally {
    $('btn-actualizar-cond').disabled = false;
  }
}

function pintarConductores() {
  capaConductores.clearLayers();
  $('badge-conductores').textContent = conductores.length;
  if (!conductores.length) {
    $('lista-conductores').innerHTML = '<div class="cot-muted">No hay conductores en línea ahora. Pon un teléfono de conductor en línea y toca Actualizar.</div>';
    return;
  }
  for (const c of conductores) {
    const nombre = (c.nombre || 'Conductor').split(/\s+/)[0];
    L.marker([c.lat, c.lng], { icon: iconoConductor(nombre) })
      .bindPopup(`<b>${esc(c.nombre || 'Conductor')}</b><br><span style="font-size:12px;color:#666;">${esc(haceCuanto(c.ultimaUbicacion))}</span><br>
        <button type="button" class="btn btn-primary btn-sm" style="margin-top:8px;" data-origen-junto="${esc(c.id)}">Poner origen junto a él</button>`)
      .addTo(capaConductores);
  }
  $('lista-conductores').innerHTML = conductores.map((c) => {
    const [et, bg, fg] = ESTADO_COND[c.estado] || [c.estado, '#f2f2f2', '#555'];
    return `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;border:1px solid #efefef;border-radius:10px;padding:10px 12px;">
      <div style="min-width:0;">
        <div style="font-weight:600;font-size:13.5px;">${esc(c.nombre || 'Conductor')}
          <span class="cot-estado" style="background:${bg};color:${fg};margin-left:6px;">${esc(et)}</span></div>
        <div class="cot-muted">${esc(haceCuanto(c.ultimaUbicacion))}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button type="button" class="btn btn-outline btn-sm" data-centrar="${esc(c.id)}">Ver</button>
        <button type="button" class="btn btn-primary btn-sm" data-origen-junto="${esc(c.id)}">Origen junto a él</button>
      </div>
    </div>`;
  }).join('');
  // La primera vez, el mapa se centra en los conductores (si aun no hay puntos).
  if (!yaEncuadrado && !puntos.origen) {
    yaEncuadrado = true;
    const limites = L.latLngBounds(conductores.map((c) => [c.lat, c.lng]));
    mapa.fitBounds(limites.pad(0.4), { maxZoom: 15 });
  }
}

// Origen a ~30 m del conductor: lo bastante cerca para un tramo corto, sin
// quedar encima de su marcador.
async function origenJuntoA(id) {
  const c = conductores.find((x) => x.id === id);
  if (!c) return;
  mapa.closePopup();
  const lat = c.lat + 0.00027;
  mapa.setView([lat, c.lng], 16);
  await ponerPunto('origen', lat, c.lng);
  activar('destino');
}

document.addEventListener('click', (e) => {
  const junto = e.target.closest('[data-origen-junto]');
  if (junto) return origenJuntoA(junto.dataset.origenJunto);
  const ver = e.target.closest('[data-centrar]');
  if (ver) {
    const c = conductores.find((x) => x.id === ver.dataset.centrar);
    if (c) mapa.setView([c.lat, c.lng], 16);
  }
});
$('btn-actualizar-cond').addEventListener('click', cargarConductores);
cargarConductores();

// ===== COTIZACION (misma formula que la app) =====
function tarifaPorRuta(km, min) {
  const total = tarifas.base + km * tarifas.porKm + min * tarifas.porMinuto;
  return Math.min(9999, Math.max(tarifas.minima, Math.round(total)));
}

// Igual que calcularDescuento en el servidor.
function descuentoDe(p, precio) {
  if (!p) return 0;
  const valor = Number(p.valor) || 0;
  let d = p.modo === 'pct' ? Math.round(precio * valor / 100) : Math.round(valor);
  if (p.modo === 'pct' && p.tope) d = Math.min(d, Math.round(p.tope));
  if (p.presupuesto) d = Math.min(d, Math.max(0, Math.round(p.presupuesto - (p.gastado || 0))));
  const aplica = (p.servicios || ['economico', 'prioridad']).includes(servicio === 'prioridad' ? 'prioridad' : 'economico');
  return aplica ? Math.max(0, Math.min(d, precio)) : 0;
}

function cotizacion() {
  if (!ruta) return null;
  const km = ruta.metros / 1000;
  const min = Math.ceil(ruta.segundos / 60);
  const base = tarifaPorRuta(km, min);
  const tarifa = servicio === 'prioridad' ? Math.round(base * MULTIPLICADOR_PRIORIDAD) : base;
  const promo = promos.find((x) => x.id === $('sel-promo').value)?.data || null;
  const descuento = descuentoDe(promo, tarifa);
  return { km, min, base, tarifa, descuento, promo, paga: tarifa - descuento };
}

function pintar() {
  const c = cotizacion();
  $('btn-crear').disabled = !c || !puntos.origen || !puntos.destino;
  if (!c) {
    ['r-km', 'r-min', 'r-calculo', 'r-tarifa', 'r-desc', 'r-paga'].forEach((id) => { $(id).textContent = '—'; });
    $('r-nota').textContent = 'Pon origen y destino para cotizar.';
    return;
  }
  $('r-km').textContent = `${c.km.toFixed(1)} km`;
  $('r-min').textContent = `~${c.min} min`;
  $('r-calculo').textContent = pesos(c.base);
  $('r-tarifa').textContent = pesos(c.tarifa) + (servicio === 'prioridad' ? ' (×1.3)' : '');
  $('r-desc').textContent = c.descuento ? '−' + pesos(c.descuento) : '$0';
  $('r-paga').textContent = pesos(c.paga);
  $('r-nota').textContent = c.descuento
    ? `El conductor cobra ${pesos(c.paga)} y recibe ${pesos(c.descuento)} de crédito para su membresía.`
    : `Tarifas: base ${pesos(tarifas.base)} · ${pesos(tarifas.porKm)}/km · ${pesos(tarifas.porMinuto)}/min · mínima ${pesos(tarifas.minima)}.`;
}

document.querySelectorAll('[data-servicio]').forEach((b) => b.addEventListener('click', () => {
  servicio = b.dataset.servicio;
  document.querySelectorAll('[data-servicio]').forEach((x) => x.classList.toggle('sel', x === b));
  pintar();
}));
$('sel-promo').addEventListener('change', pintar);

// ===== CREAR VIAJE DE PRUEBA =====
function aviso(texto, ok) {
  const el = $('aviso-crear');
  el.textContent = texto;
  el.className = 'cot-aviso ' + (ok ? 'ok' : 'error');
  el.style.display = 'block';
}

$('btn-crear').addEventListener('click', async () => {
  if (!(window.Permisos?.puede('cotizador', 'crear') ?? true)) return aviso('No tienes permiso para crear viajes de prueba.');
  const c = cotizacion();
  const uid = auth.currentUser?.uid;
  if (!c || !uid) return aviso('Falta la ruta o la sesión.');
  const nombre = $('inp-nombre').value.trim() || 'Prueba (panel)';
  const btn = $('btn-crear');
  btn.disabled = true;
  btn.textContent = 'Creando...';
  try {
    // Mismos campos que crea la app del pasajero (ver _pedirTaxi). El
    // descuento NO se manda: lo pone el servidor. Si la promocion simulada
    // es de codigo, se manda el codigo como lo haria el pasajero.
    await addDoc(collection(db, 'viajes'), {
      clienteId: uid,
      clienteNombre: nombre,
      clienteTelefono: '',
      pasajero: { nombre, telefono: '' },
      clienteLat: puntos.origen.lat,
      clienteLng: puntos.origen.lng,
      destinoLat: puntos.destino.lat,
      destinoLng: puntos.destino.lng,
      origen: puntos.origen.texto,
      destino: puntos.destino.texto,
      destinoDireccion: '',
      tarifa: c.tarifa,
      tipoServicio: servicio,
      metodoPago: 'efectivo',
      estado: 'pendiente',
      taxistaId: null,
      fechaSolicitud: serverTimestamp(),
      rutaCotizadaMetros: ruta.metros,
      rutaCotizadaSegundos: ruta.segundos,
      esPrueba: true,
      // Solo para pruebas: el servidor lo respeta unicamente si el viaje lo
      // creo un admin. 0 = sin limite de distancia ni de ciudad.
      ...($('sel-radio').value !== '' ? { radioPruebaKm: Number($('sel-radio').value) } : {}),
      ...(c.promo?.tipo === 'codigo' && c.promo.codigo ? { codigoPromo: c.promo.codigo } : {}),
    });
    const r = $('sel-radio').value;
    aviso('Viaje de prueba creado. ' + (r === '' ? 'A los conductores cercanos les llega la alerta.'
      : r === '0' ? 'Se busca cualquier conductor en línea, sin importar la distancia.'
      : `Se buscan conductores a ${r} km o menos.`), true);
  } catch (e) {
    aviso('No se pudo crear: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear viaje de prueba';
  }
});

// ===== LISTA DE VIAJES DE PRUEBA =====
const ESTADOS = {
  pendiente: ['Buscando', '#FAEEDA', '#633806'],
  aceptado: ['Aceptado', '#EAF3DE', '#27500A'],
  en_camino: ['En camino', '#EAF3DE', '#27500A'],
  en_destino: ['En destino', '#EAF3DE', '#27500A'],
  finalizado: ['Terminado', '#f2f2f2', '#555'],
  cancelado: ['Cancelado', '#FCEBEB', '#791F1F'],
};

function pintarPruebas(docs) {
  $('badge-pruebas').textContent = docs.length;
  const tbody = $('tbody-pruebas');
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:24px;">Aún no has creado viajes de prueba.</td></tr>';
    return;
  }
  tbody.innerHTML = docs.map((d) => {
    const v = d.data();
    const [etiqueta, fondo, tinta] = ESTADOS[v.estado] || [v.estado, '#f2f2f2', '#555'];
    const fecha = v.fechaSolicitud?.toDate?.();
    const extra = v.estado === 'pendiente' && v.sinTaxistas ? ' · sin taxistas'
      : v.estado === 'pendiente' && v.ronda ? ` · ronda ${v.ronda}` : '';
    const activo = ['pendiente', 'aceptado', 'en_camino', 'en_destino'].includes(v.estado);
    return `<tr>
      <td style="white-space:nowrap;">${fecha ? fecha.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
      <td style="font-size:12.5px;">${esc(v.origen)}<br><span style="color:#888;">→ ${esc(v.destino)}</span></td>
      <td style="white-space:nowrap;">${pesos(v.tarifa)}${v.descuento ? `<div style="font-size:12px;color:var(--badge-active-text);">−${pesos(v.descuento)}</div>` : ''}</td>
      <td><span class="cot-estado" style="background:${fondo};color:${tinta};">${esc(etiqueta)}${esc(extra)}</span></td>
      <td>${esc(v.taxistaNombre || '—')}</td>
      <td style="text-align:right;">${activo ? `<button type="button" class="btn btn-danger btn-sm" data-cancelar="${d.id}">Cancelar</button>` : ''}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-cancelar]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Cancelar este viaje de prueba?')) return;
    b.disabled = true;
    try {
      await updateDoc(doc(db, 'viajes', b.dataset.cancelar), {
        estado: 'cancelado',
        canceladoPor: 'admin',
        fechaCancelacion: serverTimestamp(),
      });
    } catch (e) {
      alert('No se pudo cancelar: ' + e.message);
      b.disabled = false;
    }
  }));
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  onSnapshot(
    query(collection(db, 'viajes'), where('clienteId', '==', user.uid), where('esPrueba', '==', true)),
    (snap) => {
      const docs = [...snap.docs].sort((a, b) =>
        (b.data().fechaSolicitud?.toMillis?.() || 0) - (a.data().fechaSolicitud?.toMillis?.() || 0)).slice(0, 20);
      pintarPruebas(docs);
    },
    (e) => { $('tbody-pruebas').innerHTML = `<tr><td colspan="6" style="color:#c00;padding:20px;">${esc(e.message)}</td></tr>`; },
  );
});

// ===== DATOS =====
getDoc(doc(db, 'configuracion', 'tarifas')).then((s) => {
  if (s.exists()) {
    const d = s.data();
    tarifas = {
      base: Number(d.base ?? tarifas.base),
      porKm: Number(d.porKm ?? tarifas.porKm),
      porMinuto: Number(d.porMinuto ?? tarifas.porMinuto),
      minima: Number(d.minima ?? tarifas.minima),
    };
  }
  pintar();
}).catch(() => pintar());

getDocs(collection(db, 'promociones')).then((s) => {
  const ahora = new Date();
  promos = s.docs.map((d) => ({ id: d.id, data: d.data() }))
    // Mismo criterio que promoVigente en el servidor.
    .filter(({ data: p }) => p.activa
      && !(p.inicio && p.inicio.toDate() > ahora)
      && !(p.fin && p.fin.toDate() < ahora)
      && !(p.usosMax && (p.usos || 0) >= p.usosMax)
      && !(p.presupuesto && (p.gastado || 0) >= p.presupuesto));
  const sel = $('sel-promo');
  promos.forEach(({ id, data: p }) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${p.nombre}${p.tipo === 'codigo' ? ` (${p.codigo})` : ' (automática)'}`;
    sel.appendChild(o);
  });
}).catch(() => {});

const fechaEl = $('fecha-actual');
if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
pintar();
