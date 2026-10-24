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
['origen', 'destino'].forEach((cual) => {
  $(cual === 'origen' ? 'inp-origen' : 'inp-destino').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') buscar(cual);
  });
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
