// ===== TAXISTAS.JS =====
// Gestión completa de taxistas con Firebase

import { db, app } from './app.js';
import { Auth } from './auth.js';
import {
  collection, query, onSnapshot, orderBy, where, getDocs,
  doc, updateDoc, getDoc, setDoc, deleteField, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-functions.js';

Auth.protect();

const puedeEditarTaxistas   = () => window.Permisos?.puede('taxistas', 'editar')   ?? true;
const puedeEliminarTaxistas = () => window.Permisos?.puede('taxistas', 'eliminar') ?? true;

let todosLosTaxistas = [];
let filtroActivo = 'todos';
let filtroCiudad = 'todas';
let busqueda = '';
let taxistaActualId = null;
let viajesCount = {}; // { taxistaId: count }
let catalogoCiudades = []; // [{id, nombre, lat, lng}, ...]

function nombreCiudad(id) {
  if (!id) return '—';
  const c = catalogoCiudades.find(c => c.id === id);
  return c ? c.nombre : id;
}

// ===== FOTOS =====
const CAMPOS_FOTO = [
  { key: 'fotoPerfil',      label: 'Foto de perfil' },
  { key: 'fotoUrl',         label: 'Foto de perfil' },
  { key: 'fotoLicencia',    label: 'Licencia de conducir' },
  { key: 'fotoINE',         label: 'INE / Identificación' },
  { key: 'fotoVehiculo',    label: 'Foto del vehículo' },
  { key: 'fotoPlacas',      label: 'Placas del vehículo' },
  { key: 'fotoCirculacion', label: 'Tarjeta de circulación' },
];

function extraerFotosFirestore(data) {
  const fotos = [];
  const seen  = new Set();

  if (data.documentos && typeof data.documentos === 'object') {
    const labelMap = {
      ine:      'INE / Identificación',
      licencia: 'Licencia de conducir',
      placas:   'Placas del vehículo',
      vehiculo: 'Foto del vehículo',
    };
    const subLabelMap = { frente: 'Frente', reverso: 'Reverso', foto: 'Foto' };

    for (const [key, val] of Object.entries(data.documentos)) {
      const base = labelMap[key] || key;
      if (typeof val === 'string' && val.startsWith('http') && !seen.has(val)) {
        fotos.push({ url: val, label: base });
        seen.add(val);
      } else if (val && typeof val === 'object') {
        for (const [subKey, subVal] of Object.entries(val)) {
          if (typeof subVal === 'string' && subVal.startsWith('http') && !seen.has(subVal)) {
            fotos.push({ url: subVal, label: `${base} — ${subLabelMap[subKey] || subKey}` });
            seen.add(subVal);
          }
        }
      }
    }
  }

  for (const { key, label } of CAMPOS_FOTO) {
    const val = data[key];
    if (typeof val === 'string' && val.startsWith('http') && !seen.has(val)) {
      fotos.push({ url: val, label });
      seen.add(val);
    }
  }

  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'string' && val.startsWith('http') && !seen.has(val)) {
      fotos.push({ url: val, label: key });
      seen.add(val);
    }
  }

  return fotos;
}

function setTxPreview(url, label) {
  const img = document.getElementById('tx-preview-img');
  const lbl = document.getElementById('tx-preview-label');
  if (img) img.src = url;
  if (lbl) lbl.textContent = label;
}

window.selFotoTx = function(urlEncoded, labelEncoded, el) {
  document.querySelectorAll('#modal-fotos .doc-thumb').forEach(t => t.classList.remove('doc-thumb-active'));
  el.classList.add('doc-thumb-active');
  setTxPreview(decodeURIComponent(urlEncoded), decodeURIComponent(labelEncoded));
};

window.expandirFotoTx = function(url, label) {
  let overlay = document.getElementById('foto-expand-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'foto-expand-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.93);z-index:3000;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:zoom-out;';
    overlay.innerHTML = `
      <button type="button" onclick="document.getElementById('foto-expand-overlay').remove()"
        style="position:absolute;top:18px;right:22px;background:none;border:none;color:#fff;font-size:30px;cursor:pointer;line-height:1;">✕</button>
      <img id="foto-expand-img" style="max-width:92vw;max-height:82vh;border-radius:8px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,.6);">
      <p id="foto-expand-lbl" style="color:#aaa;margin-top:14px;font-size:13px;font-family:Inter,sans-serif;"></p>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
  document.getElementById('foto-expand-img').src = url;
  document.getElementById('foto-expand-lbl').textContent = label || '';
  overlay.style.display = 'flex';
};

// ===== HELPERS =====
function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

const ESTADOS_OCUPADO = new Set(['ocupado', 'en_viaje', 'en-viaje', 'en_camino']);

function badgeClass(estado) {
  const map = {
    activo: 'badge-activo', disponible: 'badge-disponible',
    pendiente: 'badge-pendiente',
    'en-viaje': 'badge-en-viaje', 'en_viaje': 'badge-en-viaje',
    suspendido: 'badge-suspendido', rechazado: 'badge-rechazado'
  };
  return map[(estado || '').toLowerCase()] || 'badge-pendiente';
}

function capitalizar(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function badgePago(ultimoPago) {
  if (!ultimoPago) return '<span class="badge badge-suspendido">Sin pago</span>';
  const hace = Date.now() - ultimoPago.toDate().getTime();
  const dias = hace / (1000 * 60 * 60 * 24);
  if (dias <= 7) return '<span class="badge badge-activo">Al corriente</span>';
  if (dias <= 14) return '<span class="badge badge-pendiente">1 sem. atraso</span>';
  return '<span class="badge badge-suspendido">Atrasado</span>';
}

function labelEstado(estado) {
  const map = {
    activo: 'Activo', disponible: 'Disponible',
    pendiente: 'Pendiente', 'en-viaje': 'En viaje',
    suspendido: 'Suspendido', rechazado: 'Rechazado'
  };
  return map[(estado || '').toLowerCase()] || capitalizar(estado || 'pendiente');
}

// ===== RENDERIZAR TABLA =====
function renderTabla(lista) {
  const tbody = document.getElementById('tbody-taxistas');
  const countEl = document.getElementById('count-taxistas');
  if (!tbody) return;

  if (countEl) countEl.textContent = lista.length;

  if (lista.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <div class="empty-icon">🚕</div>
          <p>No se encontraron taxistas con este filtro</p>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  lista.forEach(({ id, data: d }) => {
    const estado = (d.estado || 'pendiente').toLowerCase();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="driver-info">
          <div class="driver-avatar">${initials(d.nombre)}</div>
          <div>
            <div class="driver-name">${d.nombre || '—'}</div>
            <div class="driver-phone">${d.correo || ''}</div>
          </div>
        </div>
      </td>
      <td>${d.telefono || '—'}</td>
      <td><strong>${d.vehiculo?.placas || '—'}</strong></td>
      <td>${d.vehiculo?.marca ? `${d.vehiculo.marca} ${d.vehiculo.modelo || ''}`.trim() : '—'}</td>
      <td><span class="badge ${badgeClass(estado)}">${labelEstado(estado)}</span></td>
      <td>${nombreCiudad(d.ciudadActual)}</td>
      <td><span class="rating">⭐ ${parseFloat(d.calificacion || 0).toFixed(1)}</span></td>
      <td>${viajesCount[id] ?? d.viajesTotal ?? 0}</td>
      <td>${badgePago(d.ultimoPago)}</td>
      <td>
        <div class="btn-actions">
          <button class="btn btn-outline btn-sm" onclick="verTaxista('${id}')">👁 Ver</button>
          ${puedeEditarTaxistas() && estado !== 'activo' ? `<button class="btn btn-success btn-sm" onclick="aprobarTaxista('${id}')">✓ Aprobar</button>` : ''}
          ${puedeEditarTaxistas() && estado !== 'suspendido' ? `<button class="btn btn-danger btn-sm" onclick="suspenderTaxista('${id}')">⊘ Suspender</button>` : ''}
          ${puedeEditarTaxistas() && ESTADOS_OCUPADO.has(estado) ? `<button class="btn btn-outline btn-sm" onclick="resetearEstadoTaxista('${id}')" title="Forzar a Disponible si quedó atorado como ocupado">🔄 Resetear</button>` : ''}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

// ===== FILTRAR Y BUSCAR =====
function aplicarFiltros() {
  let lista = [...todosLosTaxistas];

  if (filtroActivo !== 'todos') {
    lista = lista.filter(({ data: d }) =>
      (d.estado || '').toLowerCase() === filtroActivo
    );
  }

  if (filtroCiudad !== 'todas') {
    lista = lista.filter(({ data: d }) => (d.ciudadActual || '') === filtroCiudad);
  }

  if (busqueda.trim()) {
    const q = busqueda.toLowerCase().trim();
    lista = lista.filter(({ data: d }) =>
      (d.nombre || '').toLowerCase().includes(q) ||
      (d.telefono || '').includes(q)
    );
  }

  renderTabla(lista);
}

// ===== CIUDADES (filtro) =====
async function cargarCiudadesFiltro() {
  try {
    const snap = await getDoc(doc(db, 'configuracion', 'ciudades'));
    catalogoCiudades = snap.exists() ? (snap.data().lista ?? []) : [];
  } catch (e) {
    console.error('Error cargando catálogo de ciudades:', e.message);
    catalogoCiudades = [];
  }

  const select = document.getElementById('select-ciudad-filtro');
  if (!select) return;
  const opcionesCiudades = catalogoCiudades
    .map(c => `<option value="${c.id}">${c.nombre}</option>`)
    .join('');
  select.innerHTML = `<option value="todas">Todas las ciudades</option>${opcionesCiudades}`;

  select.addEventListener('change', () => {
    filtroCiudad = select.value;
    aplicarFiltros();
  });
}

// ===== CARGAR DE FIREBASE =====
async function cargarViajesCount() {
  const snap = await getDocs(query(collection(db, 'viajes'), where('estado', '==', 'finalizado')));
  viajesCount = {};
  snap.forEach(d => {
    const tid = d.data().taxistaId;
    if (tid) viajesCount[tid] = (viajesCount[tid] || 0) + 1;
  });
}

function initTaxistas() {
  cargarViajesCount();
  const q = query(collection(db, 'taxistas'), orderBy('nombre'));
  onSnapshot(q, snap => {
    todosLosTaxistas = snap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    aplicarFiltros();

    const pendientes = todosLosTaxistas.filter(t => t.data.estado === 'pendiente').length;
    const badge = document.getElementById('badge-solicitudes-pendientes');
    if (badge) badge.textContent = pendientes;
  });
}

// ===== ACCIONES =====
window.aprobarTaxista = async (id) => {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  if (!confirm('¿Aprobar este taxista?')) return;
  await updateDoc(doc(db, 'taxistas', id), { activo: true, estado: 'activo' });
};

window.rechazarTaxista = async (id) => {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  if (!confirm('¿Rechazar este taxista?')) return;
  await updateDoc(doc(db, 'taxistas', id), { activo: false, estado: 'rechazado' });
};

window.suspenderTaxista = async (id) => {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  const motivo = prompt('Motivo de suspensión (se mostrará al taxista):');
  if (motivo === null) return;
  await updateDoc(doc(db, 'taxistas', id), {
    activo: false,
    estado: 'suspendido',
    motivoSuspension: motivo.trim() || 'Cuenta suspendida por el administrador.',
  });
};

window.resetearEstadoTaxista = async (id) => {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  let viajesActivos = [];
  try {
    const snap = await getDocs(query(
      collection(db, 'viajes'),
      where('taxistaId', '==', id),
      where('estado', 'in', ['pendiente', 'aceptado', 'en_camino'])
    ));
    viajesActivos = snap.docs;
  } catch (e) {
    alert('Error al verificar viajes activos: ' + (e.message || e));
    return;
  }

  if (viajesActivos.length > 0) {
    const cancelarTambien = confirm(
      `⚠️ Este taxista tiene ${viajesActivos.length} viaje(s) activo(s) registrados.\n\n` +
      `Aceptar: cancelar esos viajes y resetear al taxista a "Disponible".\n` +
      `Cancelar: no hacer nada.`
    );
    if (!cancelarTambien) return;
    await Promise.all(viajesActivos.map(v => updateDoc(doc(db, 'viajes', v.id), {
      estado: 'cancelado',
      motivoCancelacion: 'Cancelado por el administrador al resetear el estado del taxista.',
    })));
  } else {
    if (!confirm('¿Resetear el estado de este taxista a "Disponible"? Úsalo solo si quedó atorado como "ocupado" sin tener un viaje real en curso.')) return;
  }

  await updateDoc(doc(db, 'taxistas', id), { estado: 'disponible', activo: true });
  alert('✅ Estado del taxista reseteado a Disponible');
};

window.resetearEstadoDesdeModal = async function resetearEstadoDesdeModal() {
  if (!taxistaActualId) return;
  await window.resetearEstadoTaxista(taxistaActualId);
  document.getElementById('modal-taxista').style.display = 'none';
};

window.verTaxista = async (id) => {
  taxistaActualId = id;
  const snap = await getDoc(doc(db, 'taxistas', id));
  if (!snap.exists()) return;
  const d = snap.data();
  const v = d.vehiculo || {};
  const estado = (d.estado || 'pendiente').toLowerCase();

  document.getElementById('modal-nombre').textContent =
    ((d.nombre || '') + ' ' + (d.apellidos || '')).trim() || '—';

  const badge = document.getElementById('modal-estado-badge');
  badge.textContent  = labelEstado(estado);
  badge.className    = `badge ${badgeClass(estado)}`;

  const btnResetear = document.getElementById('btn-resetear-estado');
  if (btnResetear) btnResetear.style.display = ESTADOS_OCUPADO.has(estado) ? '' : 'none';

  document.getElementById('modal-nombre-campo').textContent   = d.nombre   || '—';
  document.getElementById('modal-apellidos-campo').textContent = d.apellidos || '—';
  document.getElementById('modal-telefono').textContent  = d.telefono  || '—';
  document.getElementById('modal-colonia').textContent   = d.colonia   || '—';
  document.getElementById('modal-direccion').textContent = d.direccion || '—';
  document.getElementById('modal-viajes').textContent    = viajesCount[id] ?? d.viajes ?? d.viajesTotal ?? 0;
  document.getElementById('modal-fecha').textContent     =
    d.fechaRegistro?.toDate?.()
      ? d.fechaRegistro.toDate().toLocaleDateString('es-MX') : '—';
  document.getElementById('modal-placas').textContent    = v.placas  || '—';
  document.getElementById('modal-marca').textContent     = v.marca   || '—';
  document.getElementById('modal-modelo').textContent    = v.modelo  || '—';
  document.getElementById('modal-anio').textContent      = v.año     || '—';
  document.getElementById('modal-color').textContent     = v.color   || '—';
  document.getElementById('modal-tipo').textContent      = v.tipo    || '—';

  // Los datos bancarios viven en taxistas/{id}/privado/datosBancarios —
  // ruta protegida a la que solo el propio taxista y un admin tienen
  // acceso directo (el resto de la app la pide vía Cloud Function).
  const bancSnap = await getDoc(doc(db, 'taxistas', id, 'privado', 'datosBancarios'));
  const banco = bancSnap.exists() ? bancSnap.data() : {};
  document.getElementById('modal-banco').textContent   = banco.banco   || '—';
  document.getElementById('modal-titular').textContent = banco.titular || '—';
  document.getElementById('modal-clabe').textContent   = banco.clabe   || '—';
  document.getElementById('modal-tarjeta').textContent = banco.tarjeta || '—';

  // Fotos
  const fotosEl  = document.getElementById('modal-fotos');
  const previewBox = document.getElementById('tx-preview-box');
  const fotos    = extraerFotosFirestore(d);
  if (fotos.length === 0) {
    previewBox.classList.add('doc-preview-hidden');
    previewBox.style.display = '';
    fotosEl.innerHTML = '<p style="color:#bbb;font-size:13px;">Sin fotos registradas</p>';
  } else {
    previewBox.classList.remove('doc-preview-hidden');
    previewBox.style.display = 'flex';
    setTxPreview(fotos[0].url, fotos[0].label);
    fotosEl.innerHTML = fotos.map((f, i) => `
      <div class="doc-thumb${i === 0 ? ' doc-thumb-active' : ''}"
           onclick="selFotoTx('${encodeURIComponent(f.url)}','${encodeURIComponent(f.label)}',this)">
        <img src="${f.url}" alt="${f.label}" onerror="this.parentElement.style.display='none'">
        <div class="doc-thumb-label">${f.label}</div>
      </div>`).join('');
  }

  // Restablecer botón Editar por si quedó en modo "Guardar"
  const btnEditar = document.getElementById('btn-editar');
  btnEditar.textContent = 'Editar datos';
  btnEditar.onclick = editarTaxista;
  document.getElementById('modal-taxista').style.display = 'flex';
};

window.editarTaxista = function editarTaxista() {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  const personalCampos = ['nombre-campo', 'apellidos-campo', 'telefono', 'colonia', 'direccion'];
  const vehiculoCampos = ['placas', 'marca', 'modelo', 'anio', 'color', 'tipo'];
  const bancoCampos = ['banco', 'titular', 'clabe', 'tarjeta'];

  [...personalCampos, ...vehiculoCampos, ...bancoCampos].forEach(campo => {
    const el = document.getElementById('modal-' + campo);
    if (!el) return;
    const valor = el.textContent === '—' ? '' : el.textContent;
    el.innerHTML = `<input type="text" value="${valor}" id="edit-${campo}"
      style="border:0.5px solid #ddd;border-radius:6px;padding:4px 8px;width:100%;font-size:13px;font-family:inherit">`;
  });
  const btnEditar = document.getElementById('btn-editar');
  btnEditar.textContent = 'Guardar';
  btnEditar.onclick = guardarEdicion;
};

window.guardarEdicion = async function guardarEdicion() {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  if (!taxistaActualId) return;

  const personalCampos = ['telefono', 'colonia', 'direccion'];
  const vehiculoCampos = { placas: 'placas', marca: 'marca', modelo: 'modelo', anio: 'año', color: 'color', tipo: 'tipo' };
  const bancoCampos = { banco: 'banco', titular: 'titular', clabe: 'clabe', tarjeta: 'tarjeta' };

  const datos = {};

  personalCampos.forEach(campo => {
    const val = document.getElementById('edit-' + campo)?.value?.trim();
    if (val !== undefined) datos[campo] = val;
  });

  // Nombre y apellidos tienen IDs distintos al key de Firestore
  const nombreVal    = document.getElementById('edit-nombre-campo')?.value?.trim();
  const apellidosVal = document.getElementById('edit-apellidos-campo')?.value?.trim();
  if (nombreVal    !== undefined) datos['nombre']    = nombreVal;
  if (apellidosVal !== undefined) datos['apellidos'] = apellidosVal;

  Object.entries(vehiculoCampos).forEach(([campo, fsKey]) => {
    const val = document.getElementById('edit-' + campo)?.value?.trim();
    if (val !== undefined) datos[`vehiculo.${fsKey}`] = val;
  });

  const datosBancarios = {};
  Object.entries(bancoCampos).forEach(([campo, fsKey]) => {
    const val = document.getElementById('edit-' + campo)?.value?.trim();
    if (val !== undefined) datosBancarios[fsKey] = val;
  });

  const btn = document.getElementById('btn-editar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    if (Object.keys(datosBancarios).length > 0) {
      await setDoc(
        doc(db, 'taxistas', taxistaActualId, 'privado', 'datosBancarios'),
        datosBancarios,
        { merge: true }
      );
      // Limpieza: por si quedó guardado en el documento público de una
      // versión anterior (cualquiera con sesión podía leerlo desde ahí).
      datos['datosBancarios'] = deleteField();
    }
    await updateDoc(doc(db, 'taxistas', taxistaActualId), datos);
    // Actualizar el título del modal con el nombre nuevo
    if (datos['nombre'] !== undefined || datos['apellidos'] !== undefined) {
      const h3 = document.getElementById('modal-nombre');
      const nom = (datos['nombre'] ?? h3.textContent.split(' ')[0]) || '';
      const ape = datos['apellidos'] ?? '';
      h3.textContent = [nom, ape].filter(Boolean).join(' ') || '—';
    }
    alert('✅ Datos actualizados correctamente');
    document.getElementById('modal-taxista').style.display = 'none';
  } catch (e) {
    alert('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
};

window.verHistorial = function() {
  if (!taxistaActualId) return;
  sessionStorage.setItem('historial_taxista_id', taxistaActualId);
  window.location.href = `historial-taxista.html?id=${taxistaActualId}`;
};

window.aprobarDesdeModal = async function aprobarDesdeModal() {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  if (!taxistaActualId) return;
  await updateDoc(doc(db, 'taxistas', taxistaActualId), { activo: true, estado: 'disponible' });
  alert('✅ Taxista aprobado');
  document.getElementById('modal-taxista').style.display = 'none';
};

window.registrarPago = async function registrarPago() {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  if (!taxistaActualId) return;
  const monto = prompt('Monto recibido ($):');
  if (monto === null) return;
  const montoNum = parseFloat(monto) || 0;
  await updateDoc(doc(db, 'taxistas', taxistaActualId), {
    ultimoPago: serverTimestamp(),
    ultimoMonto: montoNum,
  });
  alert('✅ Pago registrado');
  document.getElementById('modal-taxista').style.display = 'none';
};

window.suspenderDesdeModal = async function suspenderDesdeModal() {
  if (!puedeEditarTaxistas()) return alert('No tienes permiso para editar taxistas.');
  if (!taxistaActualId) return;
  const motivo = prompt('Motivo de suspensión (se mostrará al taxista):');
  if (motivo === null) return;
  await updateDoc(doc(db, 'taxistas', taxistaActualId), {
    activo: false,
    estado: 'suspendido',
    motivoSuspension: motivo.trim() || 'Cuenta suspendida por el administrador.',
  });
  alert('⛔ Taxista suspendido');
  document.getElementById('modal-taxista').style.display = 'none';
};

window.eliminarDesdeModal = async function eliminarDesdeModal() {
  if (!puedeEliminarTaxistas()) return alert('No tienes permiso para eliminar taxistas.');
  if (!taxistaActualId) return;
  const nombre = document.getElementById('modal-nombre')?.textContent || 'este taxista';
  const confirmar = confirm(`⚠️ ¿Eliminar la cuenta de ${nombre}?\n\nEsta acción borrará su cuenta de Firebase Auth y Firestore. Podrá volver a registrarse con el mismo teléfono o Google.`);
  if (!confirmar) return;

  const btn = document.getElementById('btn-eliminar-cuenta');
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando…'; }

  try {
    const fns = getFunctions(app, 'us-central1');
    const eliminarCuenta = httpsCallable(fns, 'eliminarCuenta');
    await eliminarCuenta({ uid: taxistaActualId, coleccion: 'taxistas' });
    alert('🗑 Cuenta eliminada. El usuario puede registrarse nuevamente.');
    document.getElementById('modal-taxista').style.display = 'none';
  } catch (e) {
    alert('Error al eliminar: ' + (e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Eliminar cuenta'; }
  }
};

// ===== MAPA EN VIVO =====
let _mapaVivo    = null;
let _clusterGrp  = null;
let _vMarkersMap = new Map();  // taxistaId → L.marker
let _routeLines  = new Map();  // taxistaId → L.polyline (ruta a destino)
let _vUnsub      = null;
let _searchMarker = null;
let _fitDone     = false;
let _filtroVivo  = 'todos';
let _timerInt    = null;
let _onlineAt    = new Map();  // taxistaId → ms cuando apareció por primera vez
let _vivoDatos   = [];         // [{id, data}] para panel y filtros
let _panelBuscar = '';

const VIVO_COLOR = {
  disponible: '#3B6D11', activo:    '#3B6D11',
  en_viaje:   '#E89B1A', en_camino: '#E89B1A', ocupado: '#E89B1A',
};
const VIVO_LABEL = {
  disponible: 'Disponible', activo:    'Disponible',
  en_viaje:   'En viaje',   en_camino: 'En camino', ocupado: 'Ocupado',
};
const ESTADOS_VIVOS = new Set(['disponible', 'activo', 'en_viaje', 'en_camino', 'ocupado']);

function tiempoDesde(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'hace un momento';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h`;
}

function tiempoEnLinea(id) {
  const since = _onlineAt.get(id);
  if (!since) return '';
  const min = Math.floor((Date.now() - since) / 60000);
  if (min < 1) return 'Recién conectado';
  if (min < 60) return `${min} min en línea`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min en línea` : `${h} h en línea`;
}

function mkTaxiLiveIcon(estado, pulse) {
  const verde = ['disponible', 'activo'].includes(estado);
  return L.divIcon({
    className: '',
    html: `<div class="taxi-live-pin${pulse ? ' taxi-live-pulse' : ''}">
      <span class="taxi-live-emoji">🚕</span>
      <span class="taxi-live-dot ${verde ? 'taxi-live-dot-green' : 'taxi-live-dot-orange'}"></span>
    </div>`,
    iconSize: [36, 40], iconAnchor: [18, 40], popupAnchor: [0, -44],
  });
}

function buildPopup(t, estado, id) {
  const nombre  = ((t.nombre || '') + ' ' + (t.apellidos || '')).trim() || '—';
  const color   = VIVO_COLOR[estado] || '#888';
  const label   = VIVO_LABEL[estado] || estado;
  const tsMs    = t.ultimaActualizacion?.toMillis?.() ?? t.ultimaUbicacion?.toMillis?.() ?? null;
  const enLinea = tiempoEnLinea(id);
  return `<div class="taxi-vivo-popup">
    <div class="tvp-nombre">${nombre}</div>
    <div class="tvp-row">📞 ${t.telefono || '—'}</div>
    <div class="tvp-row">🚗 ${t.vehiculo?.placas || '—'}</div>
    <div class="tvp-row">⭐ ${parseFloat(t.calificacion || 0).toFixed(1)}</div>
    ${tsMs    ? `<div class="tvp-row" style="color:#aaa;font-size:11px">GPS: ${tiempoDesde(tsMs)}</div>` : ''}
    ${enLinea ? `<div class="tvp-row" style="color:#aaa;font-size:11px">${enLinea}</div>` : ''}
    <span class="tvp-badge" style="background:${color}">${label}</span>
  </div>`;
}

function layerGroup() { return _clusterGrp || _mapaVivo; }

function esVisible(estado) {
  if (_filtroVivo === 'todos') return true;
  if (_filtroVivo === 'disponible') return ['disponible', 'activo'].includes(estado);
  return ['en_viaje', 'en_camino', 'ocupado'].includes(estado);
}

window.setFiltroVivo = function(f, el) {
  _filtroVivo = f;
  document.querySelectorAll('.mvf-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  const lg = layerGroup();
  _vMarkersMap.forEach((marker, id) => {
    const d      = _vivoDatos.find(x => x.id === id);
    const estado = d ? (d.data.estado || '').toLowerCase() : '';
    if (esVisible(estado)) { if (!lg.hasLayer(marker)) lg.addLayer(marker); }
    else                   { if (lg.hasLayer(marker))  lg.removeLayer(marker); }
  });
  renderPanel();
};

window.volarATaxi = function(id) {
  const m = _vMarkersMap.get(id);
  if (!m || !_mapaVivo) return;
  _mapaVivo.flyTo(m.getLatLng(), 16, { duration: 1 });
  setTimeout(() => m.openPopup(), 1100);
};

window.filtrarPanel = function(txt) {
  _panelBuscar = (txt || '').toLowerCase();
  renderPanel();
};

function renderPanel() {
  const list = document.getElementById('mapa-panel-list');
  if (!list) return;
  const datos = _vivoDatos.filter(({ id, data }) => {
    if (!esVisible((data.estado || '').toLowerCase())) return false;
    if (_panelBuscar) {
      const n = ((data.nombre || '') + ' ' + (data.apellidos || '')).toLowerCase();
      const p = (data.vehiculo?.placas || '').toLowerCase();
      if (!n.includes(_panelBuscar) && !p.includes(_panelBuscar)) return false;
    }
    return true;
  });
  if (!datos.length) {
    list.innerHTML = '<div class="mapa-panel-empty">Sin taxistas activos</div>';
    return;
  }
  list.innerHTML = datos.map(({ id, data }) => {
    const estado  = (data.estado || '').toLowerCase();
    const nombre  = ((data.nombre || '') + ' ' + (data.apellidos || '')).trim() || '—';
    const placas  = data.vehiculo?.placas || '—';
    const verde   = ['disponible', 'activo'].includes(estado);
    const tsMs    = data.ultimaActualizacion?.toMillis?.() ?? data.ultimaUbicacion?.toMillis?.() ?? null;
    const enLinea = tiempoEnLinea(id);
    const gpsTxt  = tiempoDesde(tsMs);
    return `<div class="mapa-panel-item" onclick="volarATaxi('${id}')">
      <div class="mpi-dot ${verde ? 'mpi-dot-green' : 'mpi-dot-orange'}"></div>
      <div class="mpi-info">
        <div class="mpi-name">${nombre}</div>
        <div class="mpi-sub">${placas} · ${VIVO_LABEL[estado] || estado}</div>
        ${enLinea ? `<div class="mpi-time">${enLinea}</div>` : ''}
        ${gpsTxt  ? `<div class="mpi-time">GPS: ${gpsTxt}</div>`  : ''}
      </div>
    </div>`;
  }).join('');
}

async function dibujarRutaTaxi(id, taxLat, taxLng) {
  try {
    const snap = await getDocs(query(
      collection(db, 'viajes'),
      where('taxistaId', '==', id),
      where('estado', 'in', ['aceptado', 'en_camino'])
    ));
    if (_routeLines.has(id)) { _mapaVivo.removeLayer(_routeLines.get(id)); _routeLines.delete(id); }
    if (snap.empty) return;
    const v    = snap.docs[0].data();
    const dLat = v.destinoLat ?? v.destinoCoordenadas?.lat ?? v.destinoCoordenadas?._lat;
    const dLng = v.destinoLng ?? v.destinoCoordenadas?.lng ?? v.destinoCoordenadas?._long;
    if (typeof dLat !== 'number') return;
    const line = L.polyline([[taxLat, taxLng], [dLat, dLng]], {
      color: '#E89B1A', weight: 3, dashArray: '8 6', opacity: 0.8,
    }).addTo(_mapaVivo);
    _routeLines.set(id, line);
  } catch {}
}

window.abrirMapaVivo = function() {
  document.getElementById('vista-lista').style.display = 'none';
  document.getElementById('vista-mapa').style.display  = 'flex';
  const btn = document.getElementById('btn-mapa-vivo');
  if (btn) btn.style.display = 'none';

  setTimeout(() => {
    if (!_mapaVivo) {
      _mapaVivo = L.map('mapa-vivo-leaflet', { zoomControl: true })
        .setView([21.1392, -98.4206], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(_mapaVivo);
    }
    if (!_clusterGrp && typeof L.markerClusterGroup === 'function') {
      _clusterGrp = L.markerClusterGroup({
        maxClusterRadius: 50,
        iconCreateFunction: c => L.divIcon({
          html: `<div class="mapa-cluster-icon">${c.getChildCount()}</div>`,
          className: '', iconSize: [38, 38],
        }),
      });
      _mapaVivo.addLayer(_clusterGrp);
    }
    _mapaVivo.invalidateSize();
    iniciarSeguimientoVivo();
    if (_timerInt) clearInterval(_timerInt);
    _timerInt = setInterval(renderPanel, 30000);
  }, 60);
};

window.cerrarMapaVivo = function() {
  document.getElementById('vista-mapa').style.display  = 'none';
  document.getElementById('vista-lista').style.display = 'block';
  const btn = document.getElementById('btn-mapa-vivo');
  if (btn) btn.style.display = '';
  if (_vUnsub)   { _vUnsub(); _vUnsub = null; }
  if (_timerInt) { clearInterval(_timerInt); _timerInt = null; }
  if (_searchMarker && _mapaVivo) { _mapaVivo.removeLayer(_searchMarker); _searchMarker = null; }
  _routeLines.forEach(l => _mapaVivo?.removeLayer(l));
  _routeLines.clear();
  _fitDone = false;
};

// ===== BUSCADOR DE LUGARES =====
window.buscarLugar = async function() {
  const input    = document.getElementById('mapa-buscar-input');
  const btn      = document.getElementById('mapa-buscar-btn');
  const queryTxt = input?.value.trim();
  if (!queryTxt || !_mapaVivo) return;
  btn.disabled = true; btn.textContent = '...';
  try {
    const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(queryTxt)}&format=json&limit=1&accept-language=es`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'es' } });
    const data = await res.json();
    if (!data.length) {
      input.classList.add('mapa-buscar-notfound');
      btn.textContent = 'Sin resultados';
      setTimeout(() => { input.classList.remove('mapa-buscar-notfound'); btn.textContent = 'Buscar'; btn.disabled = false; }, 2000);
      return;
    }
    const { lat, lon, display_name } = data[0];
    const latlng = [parseFloat(lat), parseFloat(lon)];
    if (_searchMarker) { _mapaVivo.removeLayer(_searchMarker); _searchMarker = null; }
    _searchMarker = L.marker(latlng, {
      icon: L.divIcon({ className: '', html: '<div class="mapa-buscar-pin">📍</div>', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -32] })
    }).bindPopup(`<div style="font-family:Inter,sans-serif;font-size:12.5px;max-width:220px">${display_name}</div>`)
      .addTo(_mapaVivo).openPopup();
    _mapaVivo.flyTo(latlng, 13, { duration: 1.2 });
  } catch {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Buscar'; btn.disabled = false; }, 2000);
    return;
  }
  btn.textContent = 'Buscar'; btn.disabled = false;
};

document.getElementById('mapa-buscar-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') buscarLugar();
});

function iniciarSeguimientoVivo() {
  if (_vUnsub) _vUnsub();
  _vUnsub = onSnapshot(
    query(collection(db, 'taxistas'), where('activo', '==', true)),
    snap => {
      const presentes   = new Set();
      const bounds      = [];
      const nuevosDatos = [];

      const GPS_STALE_MS = 15 * 60 * 1000; // 15 min sin actualizar = fuera de línea

      snap.forEach(docSnap => {
        const t      = docSnap.data();
        const estado = (t.estado || '').toLowerCase();
        if (!ESTADOS_VIVOS.has(estado)) return;
        if (typeof t.lat !== 'number' || typeof t.lng !== 'number') return;

        // Si el GPS no se ha actualizado en más de 15 min, el taxista ya no está activo
        const tsMs = t.ultimaActualizacion?.toMillis?.() ?? t.ultimaUbicacion?.toMillis?.() ?? null;
        if (tsMs && (Date.now() - tsMs) > GPS_STALE_MS) return;

        const id = docSnap.id;
        presentes.add(id);
        nuevosDatos.push({ id, data: t });
        bounds.push([t.lat, t.lng]);

        const esNuevo = !_vMarkersMap.has(id);
        if (esNuevo && !_onlineAt.has(id)) _onlineAt.set(id, Date.now());

        const popup   = buildPopup(t, estado, id);
        const visible = esVisible(estado);
        const lg      = layerGroup();

        if (_vMarkersMap.has(id)) {
          const m = _vMarkersMap.get(id);
          if (lg.hasLayer(m)) lg.removeLayer(m);
          m.setLatLng([t.lat, t.lng]);
          m.setIcon(mkTaxiLiveIcon(estado, false));
          m.getPopup()?.setContent(popup);
          if (visible) lg.addLayer(m);
        } else {
          const m = L.marker([t.lat, t.lng], { icon: mkTaxiLiveIcon(estado, true) }).bindPopup(popup);
          _vMarkersMap.set(id, m);
          if (visible) lg.addLayer(m);
        }

        // Ruta punteada si está en viaje
        const enViaje = ['en_viaje', 'en_camino', 'ocupado'].includes(estado);
        if (enViaje) dibujarRutaTaxi(id, t.lat, t.lng);
        else if (_routeLines.has(id)) { _mapaVivo.removeLayer(_routeLines.get(id)); _routeLines.delete(id); }
      });

      _vMarkersMap.forEach((marker, id) => {
        if (!presentes.has(id)) {
          layerGroup().removeLayer(marker);
          _vMarkersMap.delete(id);
          _onlineAt.delete(id);
          if (_routeLines.has(id)) { _mapaVivo.removeLayer(_routeLines.get(id)); _routeLines.delete(id); }
        }
      });

      _vivoDatos = nuevosDatos;
      const countEl = document.getElementById('mapa-vivo-count');
      if (countEl) countEl.textContent = presentes.size + ' en línea';

      if (bounds.length && !_fitDone) {
        _mapaVivo.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
        _fitDone = true;
      }
      renderPanel();
    }
  );
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

// ===== BÚSQUEDA =====
document.getElementById('input-buscar')?.addEventListener('input', e => {
  busqueda = e.target.value;
  aplicarFiltros();
});

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
initTaxistas();
cargarCiudadesFiltro();
