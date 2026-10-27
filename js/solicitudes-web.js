// ===== SOLICITUDES-WEB.JS =====
// Interesados que llenaron "Unete como conductor" en la pagina publica
// (taxi-hidalgo.html). Los guarda el servidor (registrarInteresConductor) en
// registros_conductores; aqui solo se listan y se marcan como contactados.
import { db } from './app.js';
import {
  collection, onSnapshot, doc, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ESTADOS = {
  nuevo: ['Nuevo', 'var(--badge-pending-bg)', 'var(--badge-pending-text)'],
  contactado: ['Contactado', 'var(--badge-active-bg)', 'var(--badge-active-text)'],
  descartado: ['Descartado', '#f0f0f0', '#666'],
};
const puede = () => window.Permisos?.puede('taxistas', 'editar') ?? true;

onSnapshot(collection(db, 'registros_conductores'), (snap) => {
  const filas = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  const nuevos = filas.filter((f) => (f.estadoRegistro || 'nuevo') === 'nuevo').length;
  $('badge-web').textContent = nuevos ? `${nuevos} nuevos` : `${filas.length}`;
  if (!filas.length) {
    $('tbody-web').innerHTML = '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:24px;">Nadie ha llenado el formulario todavía.</td></tr>';
    return;
  }
  $('tbody-web').innerHTML = filas.map((f) => {
    const fecha = f.createdAt?.toDate?.();
    const [et, bg, fg] = ESTADOS[f.estadoRegistro] || ESTADOS.nuevo;
    const lugar = [f.municipio, f.localidad].filter(Boolean).join(' · ');
    return `<tr>
      <td style="white-space:nowrap;">${fecha ? fecha.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) + ' ' + fecha.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
      <td>${esc(f.nombre)}</td>
      <td>${esc(f.telefono)}</td>
      <td>${esc(f.correo)}</td>
      <td>${esc(lugar)}</td>
      <td><span class="badge" style="background:${bg};color:${fg};">${et}</span></td>
      <td style="white-space:nowrap;">${puede() ? `
        ${(f.estadoRegistro || 'nuevo') !== 'contactado' ? `<button type="button" class="btn btn-success btn-sm" data-web-estado="contactado" data-web-id="${esc(f.id)}">Contactado</button>` : ''}
        ${(f.estadoRegistro || 'nuevo') !== 'descartado' ? `<button type="button" class="btn btn-outline btn-sm" data-web-estado="descartado" data-web-id="${esc(f.id)}">Descartar</button>` : ''}` : ''}
      </td>
    </tr>`;
  }).join('');
}, (e) => {
  $('tbody-web').innerHTML = `<tr><td colspan="7" style="color:#c00;padding:20px;">No se pudieron cargar: ${esc(e.message)}</td></tr>`;
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-web-estado]');
  if (!b || !puede()) return;
  b.disabled = true;
  try {
    await updateDoc(doc(db, 'registros_conductores', b.dataset.webId), {
      estadoRegistro: b.dataset.webEstado,
      actualizadoEn: serverTimestamp(),
    });
  } catch (err) {
    alert('No se pudo actualizar: ' + err.message);
    b.disabled = false;
  }
});
