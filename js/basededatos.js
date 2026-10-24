// ===== BASEDEDATOS.JS =====
import { Auth } from './auth.js';
import { db } from './app.js';
import {
  collection, query, limit, where,
  getDocs, getDoc, doc, setDoc, deleteDoc, writeBatch, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const puedeCrearBD    = () => window.Permisos?.puede('basededatos', 'crear')    ?? true;
const puedeEditarBD   = () => window.Permisos?.puede('basededatos', 'editar')   ?? true;
const puedeEliminarBD = () => window.Permisos?.puede('basededatos', 'eliminar') ?? true;

document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ===== COLECCIONES DISPONIBLES =====
const COLECCIONES = [
  { id: 'taxistas',           label: 'Taxistas',            icon: '🧑‍✈️' },
  { id: 'clientes',           label: 'Clientes',             icon: '👤' },
  { id: 'viajes',             label: 'Viajes',                icon: '🗺️' },
  { id: 'viajes_programados', label: 'Viajes programados',    icon: '📅' },
  { id: 'zonas',              label: 'Zonas',                  icon: '📍' },
  { id: 'configuracion',      label: 'Configuración',          icon: '⚙️' },
  { id: 'app_config',         label: 'App config',             icon: '🧩' },
];
const DOCS_POR_PAGINA = 15;

let coleccionActual = null;
let docsActuales     = [];   // [{ id, data }]
let paginaActual     = 1;
let busqueda         = '';
let modalDocId       = null; // id del doc abierto en el modal (null = nuevo)
let pendingDeleteId  = null;
let pendingDeleteCol = null;

// ===== TABS =====
function renderTabs() {
  const el = document.getElementById('bd-tabs');
  el.innerHTML = COLECCIONES.map(c => `
    <button type="button" class="visor-tab${c.id === coleccionActual ? ' active' : ''}"
      onclick="cambiarColeccion('${c.id}', this)">${c.icon} ${c.label}</button>
  `).join('');
}

window.cambiarColeccion = function(id, el) {
  coleccionActual = id;
  paginaActual    = 1;
  busqueda        = '';
  const buscarInp = document.getElementById('bd-buscar');
  if (buscarInp) buscarInp.value = '';
  document.querySelectorAll('.visor-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  cargarColeccion(id);
};

window.recargarColeccion = function() {
  if (coleccionActual) cargarColeccion(coleccionActual);
};

// ===== CARGA =====
async function cargarColeccion(nombre) {
  const tbody = document.getElementById('bd-tbody');
  tbody.innerHTML = `<tr class="loading-row"><td colspan="3">Cargando ${nombre}...</td></tr>`;

  try {
    const snap = await getDocs(query(collection(db, nombre), limit(300)));
    docsActuales = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    render();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:24px;text-align:center;color:#dc2626;">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

document.getElementById('bd-buscar')?.addEventListener('input', (e) => {
  busqueda     = e.target.value.trim().toLowerCase();
  paginaActual = 1;
  render();
});

// ===== RENDER LISTA =====
function render() {
  const tbody   = document.getElementById('bd-tbody');
  const countEl = document.getElementById('bd-count');

  let lista = docsActuales;
  if (busqueda) lista = lista.filter(d => d.id.toLowerCase().includes(busqueda));

  if (countEl) countEl.textContent = `${lista.length} documentos`;

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:24px;text-align:center;color:#bbb;">Sin documentos</td></tr>`;
    renderPager(0, 1);
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(lista.length / DOCS_POR_PAGINA));
  if (paginaActual > totalPaginas) paginaActual = totalPaginas;
  if (paginaActual < 1) paginaActual = 1;
  const inicio = (paginaActual - 1) * DOCS_POR_PAGINA;
  const pagina = lista.slice(inicio, inicio + DOCS_POR_PAGINA);

  const filas = pagina.map(({ id, data }) => {
    const preview = escapeHtml(JSON.stringify(serializarParaJson(data)));
    const previewCorta = preview.length > 140 ? preview.slice(0, 140) + '…' : preview;
    return `
      <tr>
        <td style="font-family:monospace;font-size:12px;color:#666;word-break:break-all;">${escapeHtml(id)}</td>
        <td style="font-family:monospace;font-size:11.5px;color:#999;">${previewCorta}</td>
        <td>
          <div class="btn-actions">
            <button type="button" class="btn btn-outline btn-sm" onclick="abrirModalDoc('${escapeAttr(id)}')">✏️ Ver/Editar</button>
            ${puedeEliminarBD() ? `<button type="button" class="btn btn-danger btn-sm" onclick="eliminarDesdeLista('${escapeAttr(id)}')">🗑</button>` : ''}
          </div>
        </td>
      </tr>`;
  });

  tbody.innerHTML = filas.join('');
  renderPager(lista.length, totalPaginas);
}

function renderPager(totalItems, totalPaginas) {
  const el = document.getElementById('bd-pager');
  if (!el) return;
  if (totalItems === 0 || totalPaginas <= 1) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <button type="button" class="btn btn-outline btn-sm" id="bd-pager-prev" ${paginaActual <= 1 ? 'disabled' : ''}>← Anterior</button>
    <span style="font-size:13px;color:#666;">Página ${paginaActual} de ${totalPaginas}</span>
    <button type="button" class="btn btn-outline btn-sm" id="bd-pager-next" ${paginaActual >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>`;

  document.getElementById('bd-pager-prev').addEventListener('click', () => {
    if (paginaActual > 1) { paginaActual--; render(); }
  });
  document.getElementById('bd-pager-next').addEventListener('click', () => {
    if (paginaActual < totalPaginas) { paginaActual++; render(); }
  });
}

// ===== SERIALIZACIÓN (Timestamp ↔ JSON) =====
function serializarParaJson(data) {
  if (data === null || data === undefined) return data;
  if (typeof data?.toDate === 'function') return { __ts__: data.toDate().toISOString() };
  if (Array.isArray(data)) return data.map(serializarParaJson);
  if (typeof data === 'object') {
    const out = {};
    for (const k of Object.keys(data)) out[k] = serializarParaJson(data[k]);
    return out;
  }
  return data;
}

function deserializarDesdeJson(data) {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(deserializarDesdeJson);
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === '__ts__' && typeof data.__ts__ === 'string') {
      return Timestamp.fromDate(new Date(data.__ts__));
    }
    const out = {};
    for (const k of keys) out[k] = deserializarDesdeJson(data[k]);
    return out;
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(str) {
  return String(str).replace(/'/g, '&#39;');
}

// ===== MODAL VER/EDITAR =====
window.abrirModalDoc = async function(id) {
  if (!coleccionActual) return;
  if (!id && !puedeCrearBD()) return alert('No tienes permiso para crear documentos.');
  modalDocId = id;
  const idInput    = document.getElementById('doc-id-input');
  const jsonArea   = document.getElementById('doc-json');
  const titleEl    = document.getElementById('modal-doc-title');
  const delBtn     = document.getElementById('btn-eliminar-doc');
  const guardarBtn = document.getElementById('btn-guardar-doc');
  const statusEl   = document.getElementById('doc-status');
  statusEl.textContent = '';
  statusEl.style.color = '';

  if (id) {
    const soloLectura = !puedeEditarBD();
    titleEl.textContent   = `Documento — ${coleccionActual}` + (soloLectura ? ' (solo lectura)' : '');
    idInput.value         = id;
    idInput.disabled      = true;
    delBtn.style.display  = puedeEliminarBD() ? '' : 'none';
    if (guardarBtn) guardarBtn.style.display = soloLectura ? 'none' : '';
    jsonArea.readOnly = soloLectura;
    jsonArea.value = 'Cargando...';
    document.getElementById('modal-doc').style.display = 'flex';
    try {
      const snap = await getDoc(doc(db, coleccionActual, id));
      if (!snap.exists()) {
        jsonArea.value = '';
        statusEl.textContent = 'Este documento ya no existe.';
        statusEl.style.color = '#A32D2D';
        return;
      }
      jsonArea.value = JSON.stringify(serializarParaJson(snap.data()), null, 2);
    } catch (e) {
      statusEl.textContent = 'Error al cargar: ' + e.message;
      statusEl.style.color = '#A32D2D';
    }
  } else {
    titleEl.textContent   = `Nuevo documento — ${coleccionActual}`;
    idInput.value          = '';
    idInput.disabled       = false;
    delBtn.style.display   = 'none';
    if (guardarBtn) guardarBtn.style.display = '';
    jsonArea.readOnly = false;
    jsonArea.value = '{\n  \n}';
    document.getElementById('modal-doc').style.display = 'flex';
  }
};

window.cerrarModalDoc = function() {
  document.getElementById('modal-doc').style.display = 'none';
  modalDocId = null;
};

window.guardarDoc = async function() {
  const idInput  = document.getElementById('doc-id-input');
  const jsonArea = document.getElementById('doc-json');
  const statusEl = document.getElementById('doc-status');

  const esNuevo = !modalDocId;
  if (esNuevo && !puedeCrearBD()) return alert('No tienes permiso para crear documentos.');
  if (!esNuevo && !puedeEditarBD()) return alert('No tienes permiso para editar documentos.');

  let parsed;
  try {
    parsed = JSON.parse(jsonArea.value);
  } catch (e) {
    statusEl.textContent = 'JSON inválido: ' + e.message;
    statusEl.style.color = '#A32D2D';
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    statusEl.textContent = 'El documento debe ser un objeto JSON { ... }';
    statusEl.style.color = '#A32D2D';
    return;
  }

  const targetId = modalDocId || idInput.value.trim();
  const data     = deserializarDesdeJson(parsed);

  statusEl.textContent = 'Guardando...';
  statusEl.style.color = '';
  try {
    const ref = targetId
      ? doc(db, coleccionActual, targetId)
      : doc(collection(db, coleccionActual));
    await setDoc(ref, data);
    statusEl.textContent = 'Guardado correctamente.';
    statusEl.style.color = 'var(--green)';
    await cargarColeccion(coleccionActual);
    setTimeout(() => window.cerrarModalDoc(), 600);
  } catch (e) {
    statusEl.textContent = 'Error al guardar: ' + e.message;
    statusEl.style.color = '#A32D2D';
  }
};

// ===== ELIMINAR =====
window.eliminarDesdeLista = function(id) {
  if (!puedeEliminarBD()) return alert('No tienes permiso para eliminar documentos.');
  pendingDeleteId  = id;
  pendingDeleteCol = coleccionActual;
  abrirModalDocReset();
};

window.pedirConfirmacionEliminar = function() {
  if (!puedeEliminarBD()) return alert('No tienes permiso para eliminar documentos.');
  if (!modalDocId) return;
  pendingDeleteId  = modalDocId;
  pendingDeleteCol = coleccionActual;
  abrirModalDocReset();
};

function abrirModalDocReset() {
  document.getElementById('doc-reset-confirm-input').value = '';
  const stat = document.getElementById('doc-reset-status');
  stat.textContent = '';
  stat.style.color = '';
  document.getElementById('modal-doc-reset').style.display = 'flex';
}

window.cerrarModalDocReset = function() {
  document.getElementById('modal-doc-reset').style.display = 'none';
  pendingDeleteId  = null;
  pendingDeleteCol = null;
};

window.ejecutarEliminarDoc = async function() {
  const input    = document.getElementById('doc-reset-confirm-input');
  const statusEl = document.getElementById('doc-reset-status');
  if (input.value.trim() !== 'CONFIRMAR') {
    statusEl.textContent = 'Escribe CONFIRMAR para continuar.';
    statusEl.style.color = '#A32D2D';
    return;
  }
  if (!pendingDeleteId || !pendingDeleteCol) return;

  statusEl.textContent = 'Eliminando...';
  statusEl.style.color = '';
  try {
    await deleteDoc(doc(db, pendingDeleteCol, pendingDeleteId));
    window.cerrarModalDocReset();
    window.cerrarModalDoc();
    await cargarColeccion(coleccionActual);
  } catch (e) {
    statusEl.textContent = 'Error al eliminar: ' + e.message;
    statusEl.style.color = '#A32D2D';
  }
};

// ===== ZONA DE PELIGRO =====
const RESET_OPS = {
  'viajes-fin':     { label: 'viajes finalizados y cancelados',    col: 'viajes',   cond: [where('estado', 'in', ['finalizado','cancelado'])] },
  'clientes-bloq':  { label: 'clientes bloqueados',                col: 'clientes', cond: [where('bloqueado', '==', true)] },
  'viajes-todos':   { label: 'TODOS los viajes',                   col: 'viajes',   cond: [], nuclear: true },
  'clientes-todos': { label: 'TODOS los clientes',                 col: 'clientes', cond: [], nuclear: true },
  'taxistas-susp':  { label: 'taxistas suspendidos y rechazados',  col: 'taxistas', cond: [where('estado', 'in', ['suspendido','rechazado'])] },
  'taxistas-todos': { label: 'TODOS los taxistas',                 col: 'taxistas', cond: [], nuclear: true },
  'zonas-inact':    { label: 'zonas inactivas',                    col: 'zonas',    cond: [where('activa', '==', false)] },
};

const CNT_IDS = {
  'viajes-fin':     'bd-cnt-viajes-fin',
  'clientes-bloq':  'bd-cnt-clientes-bloq',
  'viajes-todos':   'bd-cnt-viajes-todos',
  'clientes-todos': 'bd-cnt-clientes-todos',
  'taxistas-susp':  'bd-cnt-taxistas-susp',
  'taxistas-todos': 'bd-cnt-taxistas-todos',
  'zonas-inact':    'bd-cnt-zonas-inact',
};

let _resetTipoActual = null;

window.togglePeligro = function() {
  if (!puedeEliminarBD()) return alert('No tienes permiso para esta acción.');
  const card = document.getElementById('zona-peligro-card');
  const abrir = card.style.display === 'none';
  card.style.display = abrir ? '' : 'none';
  if (abrir) calcularConteosDanger();
};

async function calcularConteosDanger() {
  for (const [tipo, op] of Object.entries(RESET_OPS)) {
    const el = document.getElementById(CNT_IDS[tipo]);
    if (!el) continue;
    try {
      const colRef = collection(db, op.col);
      const q      = op.cond.length ? query(colRef, ...op.cond) : colRef;
      const snap   = await getDocs(q);
      el.textContent = `${snap.size} documento${snap.size !== 1 ? 's' : ''}`;
    } catch {
      el.textContent = 'Error al calcular';
    }
  }
}

window.confirmarReset = function(tipo) {
  const op = RESET_OPS[tipo];
  if (!op) return;
  _resetTipoActual = tipo;

  const desc = document.getElementById('bd-reset-desc');
  const inp  = document.getElementById('bd-reset-confirm-input');
  const stat = document.getElementById('bd-reset-status');
  const cnt  = document.getElementById(CNT_IDS[tipo])?.textContent || '';

  if (desc) desc.innerHTML =
    `Se eliminarán permanentemente <strong>${cnt}</strong> de <strong>${op.label}</strong>.` +
    (op.nuclear ? '<br><br><strong style="color:#dc2626">Esta acción no se puede deshacer.</strong>' : '');
  if (inp)  inp.value = '';
  if (stat) { stat.textContent = ''; stat.style.color = ''; }

  document.getElementById('bd-modal-reset').style.display = 'flex';
  setTimeout(() => inp?.focus(), 100);
};

window.cerrarModalReset = function() {
  document.getElementById('bd-modal-reset').style.display = 'none';
  _resetTipoActual = null;
};

window.ejecutarReset = async function() {
  if (!puedeEliminarBD()) return alert('No tienes permiso para esta acción.');
  const inp  = document.getElementById('bd-reset-confirm-input');
  const stat = document.getElementById('bd-reset-status');
  const btn  = document.getElementById('bd-btn-ejecutar-reset');

  if ((inp?.value || '').trim().toUpperCase() !== 'CONFIRMAR') {
    if (stat) { stat.textContent = '❌ Debes escribir CONFIRMAR exactamente'; stat.style.color = '#dc2626'; }
    return;
  }

  const op = RESET_OPS[_resetTipoActual];
  if (!op) return;

  btn.disabled = true; btn.textContent = 'Eliminando...';
  if (stat) { stat.textContent = 'Procesando...'; stat.style.color = '#888'; }

  try {
    const colRef = collection(db, op.col);
    const q      = op.cond.length ? query(colRef, ...op.cond) : colRef;
    const snap   = await getDocs(q);
    const docs   = snap.docs;
    const CHUNK  = 400;

    for (let i = 0; i < docs.length; i += CHUNK) {
      const batch = writeBatch(db);
      docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    if (stat) { stat.textContent = `✅ ${docs.length} documentos eliminados`; stat.style.color = '#3B6D11'; }
    setTimeout(() => {
      window.cerrarModalReset();
      calcularConteosDanger();
      if (coleccionActual === op.col) cargarColeccion(coleccionActual);
    }, 1500);
  } catch (e) {
    if (stat) { stat.textContent = `❌ Error: ${e.message}`; stat.style.color = '#dc2626'; }
  } finally {
    btn.disabled = false; btn.textContent = 'Eliminar definitivamente';
  }
};

// ===== BLOQUEO DE ACCESO =====
// Sin persistencia: cada vez que se entra o se regresa a esta página hay que
// volver a verificar la contraseña. `pageshow` cubre el caso de volver con
// el botón "atrás" del navegador (bfcache), que si no, restauraría la
// página ya desbloqueada sin volver a ejecutar este script.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

function initPage() {
  renderTabs();
  window.cambiarColeccion(COLECCIONES[0].id, document.querySelector('.visor-tab'));
}

function unlockPage() {
  const overlay = document.getElementById('bd-lock-overlay');
  if (overlay) overlay.style.display = 'none';
  initPage();
}

async function intentarDesbloquear() {
  const inp  = document.getElementById('bd-lock-password');
  const stat = document.getElementById('bd-lock-status');
  const btn  = document.getElementById('bd-lock-btn');
  const pass = inp.value;

  if (!pass) {
    stat.textContent = 'Ingresa tu contraseña';
    stat.style.color = '#A32D2D';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verificando...';
  const res = await Auth.verificarPasswordActual(pass);
  btn.disabled = false;
  btn.textContent = 'Desbloquear';

  if (res.ok) {
    unlockPage();
  } else {
    stat.textContent = res.msg || 'Contraseña incorrecta';
    stat.style.color = '#A32D2D';
    inp.value = '';
    inp.focus();
  }
}

document.getElementById('bd-lock-btn')?.addEventListener('click', intentarDesbloquear);
document.getElementById('bd-lock-password')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') intentarDesbloquear();
});
setTimeout(() => document.getElementById('bd-lock-password')?.focus(), 100);
