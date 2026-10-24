// ===== PROMOCIONES.JS =====
// Descuentos para pasajeros: automaticos (primer viaje) o con codigo.
//
// El panel solo DEFINE las promociones. Quien decide si un viaje lleva
// descuento, y cuanto, es el servidor (Cloud Functions): valida la promocion
// al pedir el viaje, la cobra al terminar y le abona el descuento al
// conductor como credito para su membresia. Por eso aqui `usos` y `gastado`
// solo se leen: los mueve el servidor.
//
// Documento promociones/{id}:
//   nombre, tipo ('auto' | 'codigo'), regla ('primer_viaje'), codigo,
//   modo ('pct' | 'fijo'), valor, tope, servicios ['economico','prioridad'],
//   ciudades [] (vacio = todas), inicio, fin, usosMax, usosPorPersona,
//   presupuesto, titulo, subtitulo, activa, usos, gastado.
import { db } from './app.js';
import { Auth } from './auth.js';
import {
  collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, getDoc,
  query, where, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const COL_PROMOS = collection(db, 'promociones');
const PRECIO_EJEMPLO = 208;

const puede = (accion) => window.Permisos?.puede('promociones', accion) ?? true;

let promos = [];        // [{ id, data }]
let ciudades = [];      // [{ id, nombre }]
let filtro = 'todas';
let editandoId = null;  // null = nueva
let form = null;        // estado del editor

// ===== UTILIDADES =====
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');
}

function aFecha(v) {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v.toDate === 'function') return v.toDate();
  return new Date(v);
}

function fechaCorta(d) {
  return d ? d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '';
}

// 'YYYY-MM-DD' de un Date en hora local (lo que espera <input type=date>).
function aInputFecha(d) {
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function deInputFecha(s, finDelDia) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return finDelDia ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
}

function numOVacio(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ===== ESTADO DE UNA PROMOCION =====
// El orden importa: una vencida o agotada lo es aunque este activa.
function estadoDe(p) {
  const ahora = new Date();
  const fin = aFecha(p.fin);
  const inicio = aFecha(p.inicio);
  if (fin && fin < ahora) return 'vencida';
  if (p.usosMax && (p.usos || 0) >= p.usosMax) return 'agotada';
  if (p.presupuesto && (p.gastado || 0) >= p.presupuesto) return 'agotada';
  if (!p.activa) return 'pausada';
  if (inicio && inicio > ahora) return 'programada';
  return 'activa';
}

const ETIQUETA_ESTADO = {
  activa: 'Activa', programada: 'Programada', pausada: 'Pausada', agotada: 'Agotada', vencida: 'Vencida',
};

function textoDescuento(p) {
  if (p.modo === 'fijo') return `${pesos(p.valor)} fijo`;
  return p.tope ? `${p.valor} % hasta ${pesos(p.tope)}` : `${p.valor} %`;
}

function descuentoPara(p, precio) {
  const v = Number(p.valor) || 0;
  let d = p.modo === 'pct' ? Math.round(precio * v / 100) : v;
  if (p.modo === 'pct' && p.tope) d = Math.min(d, Number(p.tope));
  return Math.max(0, Math.min(d, precio));
}

function textoAplica(p) {
  const s = p.servicios || [];
  const servicio = s.length === 2 ? 'Económico y Prioridad'
    : s.includes('prioridad') ? 'Prioridad' : 'Económico';
  const cds = (p.ciudades || []);
  const lugar = cds.length === 0 ? 'Todas las ciudades'
    : cds.map((id) => ciudades.find((c) => c.id === id)?.nombre || id).join(', ');
  return `${servicio} · ${lugar}`;
}

function textoVigencia(p) {
  const i = aFecha(p.inicio);
  const f = aFecha(p.fin);
  if (i && f) return `${fechaCorta(i)} – ${fechaCorta(f)}`;
  if (i) return `Desde ${fechaCorta(i)} · sin fin`;
  return 'Sin fechas';
}

// ===== LISTA =====
function renderLista() {
  const conEstado = promos.map((x) => ({ ...x, estado: estadoDe(x.data) }));

  const activas = conEstado.filter((x) => x.estado === 'activa').length;
  $('st-activas').textContent = activas;
  $('st-activas-sub').textContent = `de ${conEstado.length} promociones`;
  $('st-usos').textContent = conEstado.reduce((a, x) => a + (x.data.usos || 0), 0).toLocaleString('es-MX');
  const gastado = conEstado.reduce((a, x) => a + (x.data.gastado || 0), 0);
  const presupuesto = conEstado
    .filter((x) => x.estado === 'activa' || x.estado === 'programada')
    .reduce((a, x) => a + (x.data.presupuesto || 0), 0);
  $('st-gastado').textContent = pesos(gastado);
  $('st-gastado-sub').textContent = presupuesto
    ? `presupuesto de las vigentes: ${pesos(presupuesto)}`
    : 'sin presupuesto definido';
  $('st-gastado-barra').style.width = presupuesto ? `${Math.min(100, gastado / presupuesto * 100)}%` : '0%';

  const visibles = filtro === 'todas' ? conEstado : conEstado.filter((x) => x.estado === filtro);
  const tbody = $('tbody-promos');
  if (visibles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#999;padding:28px;">${
      promos.length === 0 ? 'Aún no hay promociones. Crea la primera con “+ Nueva promoción”.' : 'Sin promociones en este filtro.'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = visibles.map(({ id, data: p, estado }) => {
    const pct = p.presupuesto ? Math.min(100, Math.round((p.gastado || 0) / p.presupuesto * 100)) : 0;
    const colorBarra = pct >= 100 ? '#9A9A9A' : pct >= 80 ? '#D97706' : 'var(--green)';
    const tipo = p.tipo === 'codigo'
      ? `<span class="promo-tipo codigo">${esc(p.codigo)}</span>`
      : '<span class="promo-tipo auto">Automática · primer viaje</span>';
    const usos = p.usosMax ? `${p.usos || 0} de ${p.usosMax}` : `${p.usos || 0}`;
    const presupuestoTxt = p.presupuesto
      ? `${pesos(p.gastado || 0)} de ${pesos(p.presupuesto)}<div class="promo-barra"><div style="width:${pct}%;background:${colorBarra}"></div></div>`
      : `${pesos(p.gastado || 0)} <span class="promo-muted">· sin límite</span>`;
    const pausable = estado !== 'agotada' && estado !== 'vencida';
    const botonPausa = pausable && puede('editar')
      ? `<button type="button" class="btn btn-sm ${p.activa ? 'btn-outline' : 'btn-success'}" data-pausar="${id}">${p.activa ? 'Pausar' : 'Reanudar'}</button>`
      : '';
    const botonEditar = puede('editar')
      ? `<button type="button" class="btn btn-outline btn-sm" data-editar="${id}">Editar</button>` : '';
    return `<tr>
      <td><div style="font-weight:600;color:var(--dark);">${esc(p.nombre)}</div>${tipo}</td>
      <td style="font-weight:600;white-space:nowrap;">${esc(textoDescuento(p))}</td>
      <td style="font-size:13px;color:#555;">${esc(textoAplica(p))}</td>
      <td style="font-size:13px;color:#555;white-space:nowrap;">${esc(textoVigencia(p))}</td>
      <td style="font-size:13px;white-space:nowrap;">${usos}${p.usosPorPersona ? `<div class="promo-muted">${p.usosPorPersona} por persona</div>` : ''}</td>
      <td style="font-size:12.5px;">${presupuestoTxt}</td>
      <td><span class="promo-estado ${estado}">${ETIQUETA_ESTADO[estado]}</span></td>
      <td class="promo-acciones">${botonEditar}${botonPausa}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-editar]').forEach((b) =>
    b.addEventListener('click', () => abrirEditor(b.dataset.editar)));
  tbody.querySelectorAll('[data-pausar]').forEach((b) =>
    b.addEventListener('click', () => alternarPausa(b.dataset.pausar, b)));
}

async function alternarPausa(id, btn) {
  if (!puede('editar')) return alert('No tienes permiso para editar promociones.');
  const p = promos.find((x) => x.id === id);
  if (!p) return;
  btn.disabled = true;
  try {
    await updateDoc(doc(db, 'promociones', id), {
      activa: !p.data.activa,
      actualizadoEn: serverTimestamp(),
    });
  } catch (e) {
    alert('No se pudo cambiar: ' + e.message);
    btn.disabled = false;
  }
}

// ===== EDITOR =====
function formNuevo() {
  return {
    tipo: 'auto', nombre: 'Primer viaje', codigo: '',
    modo: 'pct', valor: 50, tope: 40,
    eco: true, prio: true, ciudades: [],
    inicio: aInputFecha(new Date()), fin: '',
    usosMax: '', usosPorPersona: 1, presupuesto: 4000,
    titulo: 'Tu primer viaje con 50 % de descuento',
    subtitulo: 'Hasta $40 · se aplica solo al pedir',
    activa: true,
  };
}

function formDesde(p) {
  return {
    tipo: p.tipo || 'auto', nombre: p.nombre || '', codigo: p.codigo || '',
    modo: p.modo || 'pct', valor: p.valor ?? '', tope: p.tope ?? '',
    eco: (p.servicios || []).includes('economico'), prio: (p.servicios || []).includes('prioridad'),
    ciudades: [...(p.ciudades || [])],
    inicio: aInputFecha(aFecha(p.inicio)), fin: aInputFecha(aFecha(p.fin)),
    usosMax: p.usosMax ?? '', usosPorPersona: p.usosPorPersona ?? 1, presupuesto: p.presupuesto ?? '',
    titulo: p.titulo || '', subtitulo: p.subtitulo || '',
    activa: p.activa !== false,
  };
}

function abrirEditor(id) {
  if (id ? !puede('editar') : !puede('crear')) {
    return alert('No tienes permiso para esto.');
  }
  editandoId = id || null;
  const existente = id ? promos.find((x) => x.id === id) : null;
  form = existente ? formDesde(existente.data) : formNuevo();
  $('editor-titulo').textContent = existente ? 'Editar promoción' : 'Nueva promoción';
  $('btn-eliminar').style.display = existente && puede('eliminar') ? '' : 'none';
  ocultarError();
  pintarFormulario();
  $('vista-lista').style.display = 'none';
  $('vista-editor').style.display = '';
  $('btn-nueva').style.display = 'none';
  window.scrollTo({ top: 0 });
}

function cerrarEditor() {
  editandoId = null;
  form = null;
  $('vista-editor').style.display = 'none';
  $('vista-lista').style.display = '';
  if (puede('crear')) $('btn-nueva').style.display = '';
}

function pintarFormulario() {
  document.querySelectorAll('[data-tipo]').forEach((b) =>
    b.classList.toggle('sel', b.dataset.tipo === form.tipo));
  $('wrap-codigo').style.display = form.tipo === 'codigo' ? '' : 'none';
  $('wrap-regla').style.display = form.tipo === 'auto' ? '' : 'none';
  $('f-nombre').value = form.nombre;
  $('f-codigo').value = form.codigo;

  document.querySelectorAll('[data-modo]').forEach((b) =>
    b.classList.toggle('sel', b.dataset.modo === form.modo));
  $('lbl-valor').textContent = form.modo === 'pct' ? 'Porcentaje (%)' : 'Monto ($)';
  $('wrap-tope').style.display = form.modo === 'pct' ? '' : 'none';
  $('f-valor').value = form.valor;
  $('f-tope').value = form.tope;

  $('chk-eco').checked = form.eco;
  $('chk-prio').checked = form.prio;
  pintarCiudades();

  $('f-inicio').value = form.inicio;
  $('f-fin').value = form.fin;
  $('f-usos').value = form.usosMax;
  $('f-persona').value = form.usosPorPersona;
  $('f-presupuesto').value = form.presupuesto;
  $('f-titulo').value = form.titulo;
  $('f-subtitulo').value = form.subtitulo;
  $('chk-activa').checked = form.activa;
  pintarVistaPrevia();
}

function pintarCiudades() {
  const cont = $('f-ciudades');
  const chips = [{ id: '', nombre: 'Todas las ciudades' }, ...ciudades];
  cont.innerHTML = chips.map((c) => {
    const sel = c.id === '' ? form.ciudades.length === 0 : form.ciudades.includes(c.id);
    return `<button type="button" class="promo-chip ${sel ? 'sel' : ''}" data-ciudad="${esc(c.id)}" aria-pressed="${sel}">${esc(c.nombre)}</button>`;
  }).join('');
  cont.querySelectorAll('[data-ciudad]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.ciudad;
    if (!id) form.ciudades = [];
    else if (form.ciudades.includes(id)) form.ciudades = form.ciudades.filter((x) => x !== id);
    else form.ciudades = [...form.ciudades, id];
    pintarCiudades();
  }));
}

function pintarVistaPrevia() {
  const desc = descuentoPara({ modo: form.modo, valor: form.valor, tope: numOVacio(form.tope) }, PRECIO_EJEMPLO);
  const paga = PRECIO_EJEMPLO - desc;
  $('pv-titulo').textContent = form.titulo || 'Título de la cinta';
  $('pv-sub').textContent = form.subtitulo || '';
  $('pv-orig').textContent = pesos(PRECIO_EJEMPLO);
  $('pv-precio').textContent = pesos(paga);
  $('ej-titulo').textContent = `Ejemplo con un viaje de ${pesos(PRECIO_EJEMPLO)}`;
  $('ej-desc').textContent = '−' + pesos(desc);
  $('ej-paga').textContent = pesos(paga);
  $('ej-credito').textContent = pesos(desc);
  $('ej-nota').textContent = `El conductor cobra ${pesos(paga)} y recibe ${pesos(desc)} de crédito para su membresía.`;
}

function leerFormulario() {
  form.nombre = $('f-nombre').value.trim();
  form.codigo = $('f-codigo').value.trim().toUpperCase();
  form.valor = $('f-valor').value;
  form.tope = $('f-tope').value;
  form.eco = $('chk-eco').checked;
  form.prio = $('chk-prio').checked;
  form.inicio = $('f-inicio').value;
  form.fin = $('f-fin').value;
  form.usosMax = $('f-usos').value;
  form.usosPorPersona = $('f-persona').value;
  form.presupuesto = $('f-presupuesto').value;
  form.titulo = $('f-titulo').value.trim();
  form.subtitulo = $('f-subtitulo').value.trim();
  form.activa = $('chk-activa').checked;
}

function mostrarError(msg) {
  const el = $('form-error');
  el.textContent = msg;
  el.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function ocultarError() {
  $('form-error').style.display = 'none';
}

// Devuelve el documento a guardar, o lanza un Error con el problema en
// palabras del administrador.
function validar() {
  leerFormulario();
  if (!form.nombre) throw new Error('Ponle un nombre a la promoción.');
  if (form.tipo === 'codigo') {
    if (!/^[A-Z0-9]{4,20}$/.test(form.codigo)) {
      throw new Error('El código debe tener de 4 a 20 letras o números, sin espacios.');
    }
    const repetido = promos.find((x) => x.id !== editandoId && x.data.tipo === 'codigo' &&
      (x.data.codigo || '').toUpperCase() === form.codigo);
    if (repetido) throw new Error(`Ya existe otra promoción con el código ${form.codigo}.`);
  }
  const valor = numOVacio(form.valor);
  if (!valor || valor <= 0) throw new Error('El descuento debe ser mayor que cero.');
  if (form.modo === 'pct' && valor > 100) throw new Error('El porcentaje no puede pasar de 100.');
  const tope = form.modo === 'pct' ? numOVacio(form.tope) : null;
  if (tope !== null && tope <= 0) throw new Error('El tope debe ser mayor que cero, o déjalo vacío.');
  if (!form.eco && !form.prio) throw new Error('Elige al menos un servicio: Económico o Prioridad.');
  const inicio = deInputFecha(form.inicio, false);
  const fin = deInputFecha(form.fin, true);
  if (!inicio) throw new Error('Pon la fecha en que empieza.');
  if (fin && fin < inicio) throw new Error('La fecha de fin es antes que la de inicio.');
  const usosMax = numOVacio(form.usosMax);
  if (usosMax !== null && usosMax < 1) throw new Error('Los usos máximos deben ser 1 o más, o déjalo vacío.');
  const porPersona = numOVacio(form.usosPorPersona);
  if (!porPersona || porPersona < 1) throw new Error('Los usos por persona deben ser 1 o más.');
  const presupuesto = numOVacio(form.presupuesto);
  if (presupuesto !== null && presupuesto <= 0) throw new Error('El presupuesto debe ser mayor que cero, o déjalo vacío.');
  if (!form.titulo) throw new Error('Escribe el título que verá el pasajero.');

  const datos = {
    nombre: form.nombre,
    tipo: form.tipo,
    modo: form.modo,
    valor: Math.round(valor),
    tope: tope === null ? null : Math.round(tope),
    servicios: [form.eco && 'economico', form.prio && 'prioridad'].filter(Boolean),
    ciudades: form.ciudades,
    inicio: Timestamp.fromDate(inicio),
    fin: fin ? Timestamp.fromDate(fin) : null,
    usosMax: usosMax === null ? null : Math.round(usosMax),
    usosPorPersona: Math.round(porPersona),
    presupuesto: presupuesto === null ? null : Math.round(presupuesto),
    titulo: form.titulo,
    subtitulo: form.subtitulo,
    activa: form.activa,
    actualizadoEn: serverTimestamp(),
  };
  if (form.tipo === 'codigo') {
    datos.codigo = form.codigo;
    datos.regla = null;
  } else {
    datos.codigo = null;
    datos.regla = 'primer_viaje';
  }
  return datos;
}

async function guardar() {
  let datos;
  try {
    datos = validar();
  } catch (e) {
    return mostrarError(e.message);
  }
  ocultarError();
  const btn = $('btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    if (editandoId) {
      await updateDoc(doc(db, 'promociones', editandoId), datos);
    } else {
      await addDoc(COL_PROMOS, { ...datos, usos: 0, gastado: 0, creadoEn: serverTimestamp() });
    }
    cerrarEditor();
  } catch (e) {
    mostrarError('No se pudo guardar: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar promoción';
  }
}

async function eliminar() {
  if (!editandoId || !puede('eliminar')) return;
  const p = promos.find((x) => x.id === editandoId);
  if (p && (p.data.usos || 0) > 0) {
    return mostrarError('Esta promoción ya se usó en viajes. Mejor páusala para que quede el registro de lo gastado.');
  }
  if (!confirm(`¿Eliminar la promoción "${p?.data.nombre || ''}"? No se puede deshacer.`)) return;
  try {
    await deleteDoc(doc(db, 'promociones', editandoId));
    cerrarEditor();
  } catch (e) {
    mostrarError('No se pudo eliminar: ' + e.message);
  }
}

// ===== EVENTOS DEL EDITOR =====
document.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => {
  leerFormulario();
  form.tipo = b.dataset.tipo;
  pintarFormulario();
}));
document.querySelectorAll('[data-modo]').forEach((b) => b.addEventListener('click', () => {
  leerFormulario();
  form.modo = b.dataset.modo;
  pintarFormulario();
}));
['f-valor', 'f-tope', 'f-titulo', 'f-subtitulo'].forEach((id) =>
  $(id).addEventListener('input', () => { leerFormulario(); pintarVistaPrevia(); }));
$('f-codigo').addEventListener('input', (e) => {
  const pos = e.target.selectionStart;
  e.target.value = e.target.value.toUpperCase().replace(/\s+/g, '');
  e.target.setSelectionRange(pos, pos);
});

$('btn-nueva').addEventListener('click', () => abrirEditor(null));
$('btn-volver').addEventListener('click', cerrarEditor);
$('btn-cancelar').addEventListener('click', cerrarEditor);
$('btn-guardar').addEventListener('click', guardar);
$('btn-eliminar').addEventListener('click', eliminar);

document.querySelectorAll('[data-filtro]').forEach((b) => b.addEventListener('click', () => {
  filtro = b.dataset.filtro;
  document.querySelectorAll('[data-filtro]').forEach((x) => x.classList.toggle('activo', x === b));
  renderLista();
}));

// ===== DATOS EN VIVO =====
onSnapshot(COL_PROMOS, (snap) => {
  promos = snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => (aFecha(b.data.creadoEn)?.getTime() || 0) - (aFecha(a.data.creadoEn)?.getTime() || 0));
  renderLista();
}, (e) => {
  $('tbody-promos').innerHTML = `<tr><td colspan="8" style="text-align:center;color:#c00;padding:28px;">No se pudieron cargar: ${esc(e.message)}</td></tr>`;
});

// Lo que se les debe a los conductores por viajes con descuento.
onSnapshot(query(collection(db, 'taxistas'), where('creditoMembresia', '>', 0)), (snap) => {
  const total = snap.docs.reduce((a, d) => a + (d.data().creditoMembresia || 0), 0);
  $('st-credito').textContent = pesos(total);
  $('st-credito-sub').textContent = `a ${snap.size} conductor${snap.size === 1 ? '' : 'es'}`;
}, () => {
  $('st-credito').textContent = '—';
});

getDoc(doc(db, 'configuracion', 'ciudades')).then((snap) => {
  ciudades = (snap.exists() ? (snap.data().lista || []) : [])
    .filter((c) => c && c.id)
    .map((c) => ({ id: c.id, nombre: c.nombre || c.id }));
  renderLista();
  if (form) pintarCiudades();
}).catch(() => {});

const fechaEl = $('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}
