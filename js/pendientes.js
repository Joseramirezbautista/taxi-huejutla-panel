// ===== PENDIENTES.JS =====
import { db } from './app.js';
import { Auth } from './auth.js';
import {
  collection, query, where, onSnapshot,
  doc, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

// URL de la Cloud Function (se actualiza después del deploy)
const FUNCTIONS_URL = 'https://us-central1-taxi-huejutla.cloudfunctions.net';

let pendienteActualId = null;
const taxistasMap = new Map();

const FOLDER_LABELS = {
  ine:      'INE / Identificación',
  licencia: 'Licencia de conducir',
  placas:   'Placas del vehículo',
  vehiculo: 'Foto del vehículo'
};

// Las URLs ya están en Firestore dentro del objeto "documentos"
async function fetchFotosCloudinary(_uid) {
  return { ok: true, photos: [] };
}

function mapResources(resources) {
  return resources.map(r => {
    const parts = r.public_id.split('/');
    const folder = parts[2] || parts[parts.length - 1];
    return { url: r.secure_url, label: FOLDER_LABELS[folder] || folder };
  });
}

// Fallback: detecta URLs en campos de Firestore
const CAMPOS_FOTO = [
  { key: 'fotoPerfil',      label: 'Foto de perfil' },
  { key: 'fotoUrl',         label: 'Foto de perfil' },
  { key: 'photoUrl',        label: 'Foto de perfil' },
  { key: 'fotoLicencia',    label: 'Licencia de conducir' },
  { key: 'licenciaUrl',     label: 'Licencia de conducir' },
  { key: 'fotoINE',         label: 'INE / Identificación' },
  { key: 'ineUrl',          label: 'INE / Identificación' },
  { key: 'fotoVehiculo',    label: 'Foto del vehículo' },
  { key: 'vehiculoUrl',     label: 'Foto del vehículo' },
  { key: 'fotoPlacas',      label: 'Placas del vehículo' },
  { key: 'placasUrl',       label: 'Placas del vehículo' },
  { key: 'fotoCirculacion', label: 'Tarjeta de circulación' },
];

function extraerFotosFirestore(data) {
  const fotos = [];
  const seen = new Set();

  // Objeto anidado "documentos" → estructura real de la app
  if (data.documentos && typeof data.documentos === 'object') {
    const labelMap = {
      ine:      'INE / Identificación',
      licencia: 'Licencia de conducir',
      placas:   'Placas del vehículo',
      vehiculo: 'Foto del vehículo'
    };
    const subLabelMap = {
      frente:  'Frente',
      reverso: 'Reverso',
      foto:    'Foto',
    };
    for (const [key, val] of Object.entries(data.documentos)) {
      const base = labelMap[key] || key;
      if (typeof val === 'string' && val.startsWith('http') && !seen.has(val)) {
        // formato plano: ine → "https://..."
        fotos.push({ url: val, label: base });
        seen.add(val);
      } else if (val && typeof val === 'object') {
        // formato anidado: ine → { frente: "...", reverso: "..." }
        for (const [subKey, subVal] of Object.entries(val)) {
          if (typeof subVal === 'string' && subVal.startsWith('http') && !seen.has(subVal)) {
            fotos.push({ url: subVal, label: `${base} — ${subLabelMap[subKey] || subKey}` });
            seen.add(subVal);
          }
        }
      }
    }
  }

  // Campos sueltos en el documento (fallback)
  for (const { key, label } of CAMPOS_FOTO) {
    const val = data[key];
    if (typeof val === 'string' && val.startsWith('http') && !seen.has(val)) {
      fotos.push({ url: val, label });
      seen.add(val);
    }
  }

  // Escaneo dinámico de cualquier otro campo con URL
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'string' && val.startsWith('http') && !seen.has(val)) {
      fotos.push({ url: val, label: key });
      seen.add(val);
    }
  }

  return fotos;
}

function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function formatFecha(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

function renderFila(id, d) {
  const fotosFirestore = extraerFotosFirestore(d);

  let fotosHtml = '';
  if (fotosFirestore.length === 0) {
    fotosHtml = '<span style="color:#ccc;font-size:12px;">—</span>';
  } else {
    fotosHtml = fotosFirestore.slice(0, 3).map(f =>
      `<img class="foto-thumb-sm"
        src="${f.url}" alt="${f.label}" title="${f.label}"
        onclick="abrirLightbox('${encodeURIComponent(f.url)}','${encodeURIComponent(f.label)}')"
        onerror="this.style.display='none'">`
    ).join('');
    if (fotosFirestore.length > 3) {
      fotosHtml += `<span class="foto-thumb-mas-sm">+${fotosFirestore.length - 3}</span>`;
    }
  }

  const tr = document.createElement('tr');
  tr.id = `row-${id}`;
  tr.innerHTML = `
    <td>
      <div class="driver-info">
        <div class="driver-avatar">${initials(d.nombre)}</div>
        <div>
          <div class="driver-name">${d.nombre || '—'} ${d.apellidos || ''}</div>
          <div class="driver-phone">${d.correo || formatFecha(d.fechaRegistro)}</div>
        </div>
      </div>
    </td>
    <td>${d.telefono || '—'}</td>
    <td><strong>${d.vehiculo?.placas || '—'}</strong></td>
    <td><span class="badge badge-pendiente">Pendiente</span></td>
    <td>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
        ${fotosHtml}
      </div>
    </td>
    <td>
      <div class="btn-actions">
        <button class="btn btn-outline btn-sm" onclick="verDetalle('${id}')">👁 Ver</button>
        <button class="btn btn-success btn-sm" onclick="aprobar('${id}')">✓ Aprobar</button>
        <button class="btn btn-danger btn-sm" onclick="rechazar('${id}')">✕ Rechazar</button>
      </div>
    </td>`;
  return tr;
}

function init() {
  const tbody = document.getElementById('tbody-pendientes');
  const countEl = document.getElementById('count-pendientes');
  const badgeEl = document.getElementById('sidebar-badge');

  const q = query(collection(db, 'taxistas'), where('estado', '==', 'pendiente'));

  onSnapshot(q, snap => {
    taxistasMap.clear();
    snap.forEach(docSnap => taxistasMap.set(docSnap.id, docSnap.data()));

    if (countEl) countEl.textContent = snap.size;
    if (badgeEl) {
      badgeEl.textContent = snap.size;
      badgeEl.style.display = snap.size > 0 ? 'flex' : 'none';
    }

    if (snap.empty) {
      tbody.innerHTML = `
        <tr><td colspan="6">
          <div class="empty-state">
            <div class="empty-icon">✅</div>
            <p>No hay solicitudes pendientes de aprobación</p>
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    snap.forEach(docSnap => {
      tbody.appendChild(renderFila(docSnap.id, docSnap.data()));
    });
  });
}

// ===== MODAL DETALLE =====
window.verDetalle = async function(id) {
  const d = taxistasMap.get(id);
  if (!d) return;
  pendienteActualId = id;

  document.getElementById('modal-det-nombre').textContent =
    `${d.nombre || ''} ${d.apellidos || ''}`.trim() || '—';
  const v = d.vehiculo || {};
  document.getElementById('mdet-telefono').textContent  = d.telefono       || '—';
  document.getElementById('mdet-correo').textContent    = d.correo         || '—';
  document.getElementById('mdet-colonia').textContent   = d.colonia        || '—';
  document.getElementById('mdet-direccion').textContent = d.direccion      || '—';
  document.getElementById('mdet-placas').textContent    = v.placas         || '—';
  document.getElementById('mdet-marca').textContent     = v.marca          || '—';
  document.getElementById('mdet-modelo').textContent    = v.modelo         || '—';
  document.getElementById('mdet-anio').textContent      = v.año            || '—';
  document.getElementById('mdet-color').textContent     = v.color          || '—';
  document.getElementById('mdet-tipo').textContent      = v.tipo           || '—';
  document.getElementById('mdet-fecha').textContent     = formatFecha(d.fechaRegistro);

  // Mostrar modal con "Cargando..."
  const fotosEl = document.getElementById('mdet-fotos');
  fotosEl.innerHTML = '<p style="color:#bbb;font-size:13px;grid-column:1/-1;">Cargando fotos...</p>';
  document.getElementById('modal-detalle').style.display = 'flex';

  // Obtener fotos: Cloudinary + Firestore en paralelo
  const [cloudResult, fotosFS] = await Promise.all([
    fetchFotosCloudinary(id),
    Promise.resolve(extraerFotosFirestore(d))
  ]);

  // Unir sin duplicar URLs
  const urlsCloud = new Set(cloudResult.photos.map(f => f.url));
  const fotos = [...cloudResult.photos, ...fotosFS.filter(f => !urlsCloud.has(f.url))];

  const previewBox = document.getElementById('doc-preview-box');
  if (fotos.length === 0) {
    previewBox.classList.add('doc-preview-hidden');
    fotosEl.innerHTML = '<p style="color:#bbb;font-size:13px;">Sin fotos registradas</p>';
  } else {
    previewBox.classList.remove('doc-preview-hidden');
    previewBox.style.display = 'flex';
    setDocPreview(fotos[0].url, fotos[0].label);
    fotosEl.innerHTML = fotos.map((f, i) => `
      <div class="doc-thumb${i === 0 ? ' doc-thumb-active' : ''}"
           onclick="selFotoPendiente('${encodeURIComponent(f.url)}','${encodeURIComponent(f.label)}',this)">
        <img src="${f.url}" alt="${f.label}" onerror="this.parentElement.style.display='none'">
        <div class="doc-thumb-label">${f.label}</div>
      </div>`).join('');
  }
};

window.cerrarModal = function() {
  document.getElementById('modal-detalle').style.display = 'none';
};

window.aprobarDesdeModal = async function() {
  if (!pendienteActualId) return;
  await updateDoc(doc(db, 'taxistas', pendienteActualId), { activo: true, estado: 'activo' });
  alert('Taxista aprobado correctamente');
  cerrarModal();
};

window.rechazarDesdeModal = async function() {
  if (!pendienteActualId) return;
  if (!confirm('¿Rechazar esta solicitud? El taxista no podrá operar.')) return;
  await updateDoc(doc(db, 'taxistas', pendienteActualId), { activo: false, estado: 'rechazado' });
  cerrarModal();
};

// ===== ACCIONES TABLA =====
window.aprobar = async function(id) {
  if (!confirm('¿Aprobar este taxista?')) return;
  await updateDoc(doc(db, 'taxistas', id), { activo: true, estado: 'activo' });
};

window.rechazar = async function(id) {
  if (!confirm('¿Rechazar esta solicitud?')) return;
  await updateDoc(doc(db, 'taxistas', id), { activo: false, estado: 'rechazado' });
};

// ===== VISOR INLINE =====
function setDocPreview(url, label) {
  const img = document.getElementById('doc-preview-img');
  const lbl = document.getElementById('doc-preview-label');
  if (img) img.src = url;
  if (lbl) lbl.textContent = label;
}

window.selFotoPendiente = function(urlEncoded, labelEncoded, el) {
  document.querySelectorAll('#mdet-fotos .doc-thumb').forEach(t => t.classList.remove('doc-thumb-active'));
  el.classList.add('doc-thumb-active');
  setDocPreview(decodeURIComponent(urlEncoded), decodeURIComponent(labelEncoded));
};

window.expandirFoto = function(url, label) {
  let overlay = document.getElementById('foto-expand-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'foto-expand-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.93);z-index:3000;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:zoom-out;';
    overlay.innerHTML = `
      <button onclick="document.getElementById('foto-expand-overlay').remove()"
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

// ===== LOGOUT + FECHA =====
document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

init();
