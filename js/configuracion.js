// ===== CONFIGURACION.JS =====
import { Auth } from './auth.js';

Auth.protect();
window.Permisos?.protegerPagina('roles');
window.Permisos?.aplicarVisibilidadMenu();

const session = Auth.getCurrentUser();
const puedeRoles = (accion) => window.Permisos?.puede('roles', accion) ?? true;

// ===== INFO USUARIO ACTUAL =====
if (session) {
  const nombre  = session.nombre  || session.usuario || 'Administrador';
  const usuario = session.usuario || session.user    || 'admin';
  const nombreEl  = document.getElementById('config-nombre');
  const usuarioEl = document.getElementById('config-usuario');
  const av        = document.getElementById('config-avatar');
  if (nombreEl)  nombreEl.textContent  = nombre;
  if (usuarioEl) usuarioEl.textContent = `@${usuario}`;
  if (av)        av.textContent        = nombre[0].toUpperCase();
}

// ===== HELPERS =====
function showStatus(elId, tipo, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className   = `config-status config-status-${tipo}`;
}

function limpiarFormNuevo() {
  ['inp-nuevo-nombre', 'inp-nuevo-usuario', 'inp-nuevo-pass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelector('input[name="nuevo-tipo-cuenta"][value="admin"]').checked = true;
  document.getElementById('matriz-nuevo-wrap').style.display = 'none';
  showStatus('nuevo-status', '', '');
}

// ===== CAMBIAR CONTRASEÑA (siempre permitido, es la cuenta propia) =====
document.getElementById('btn-cambiar-pass')?.addEventListener('click', async () => {
  const actual    = document.getElementById('inp-pass-actual').value;
  const nueva     = document.getElementById('inp-pass-nueva').value;
  const confirmar = document.getElementById('inp-pass-confirmar').value;

  showStatus('pass-status', '', '');
  if (!actual || !nueva || !confirmar)
    return showStatus('pass-status', 'error', 'Completa todos los campos');
  if (nueva.length < 6)
    return showStatus('pass-status', 'error', 'La nueva contraseña debe tener al menos 6 caracteres');
  if (nueva !== confirmar)
    return showStatus('pass-status', 'error', 'Las contraseñas no coinciden');

  const btn = document.getElementById('btn-cambiar-pass');
  btn.disabled = true; btn.textContent = 'Guardando...';

  const res = await Auth.cambiarPassword(session?.uid || 'default', actual, nueva);
  if (res.ok) {
    showStatus('pass-status', 'ok', '✅ Contraseña actualizada correctamente');
    ['inp-pass-actual','inp-pass-nueva','inp-pass-confirmar'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  } else {
    showStatus('pass-status', 'error', res.msg);
  }
  btn.disabled = false; btn.textContent = 'Cambiar contraseña';
});

// ===== MATRIZ DE PERMISOS (reutilizable) =====
function renderMatriz(containerId, valoresActuales) {
  const cont = document.getElementById(containerId);
  if (!cont || !window.Permisos) return;
  const { SECCIONES, ACCIONES } = window.Permisos;
  const v = valoresActuales || {};

  const filas = SECCIONES.map(sec => {
    const marcadas = v[sec.id] || [];
    const celdas = ACCIONES.map(acc => `
      <td style="text-align:center;padding:6px 4px;">
        <input type="checkbox" data-seccion="${sec.id}" data-accion="${acc.id}"
          ${marcadas.includes(acc.id) ? 'checked' : ''}>
      </td>`).join('');
    return `<tr style="border-top:1px solid #f0f0f0;">
      <td style="padding:6px 8px;font-size:12.5px;color:#333;">${sec.label}</td>
      ${celdas}
    </tr>`;
  }).join('');

  const encabezados = window.Permisos.ACCIONES.map(a =>
    `<th style="font-size:11px;color:#888;font-weight:600;padding:6px 4px;">${a.label}</th>`).join('');

  cont.innerHTML = `
    <div style="overflow-x:auto;border:1px solid #f0f0f0;border-radius:8px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;font-size:11px;color:#888;font-weight:600;padding:6px 8px;">Sección</th>
            ${encabezados}
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
}

function leerMatriz(containerId) {
  const cont = document.getElementById(containerId);
  const permisos = {};
  cont?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    const sec = cb.dataset.seccion;
    const acc = cb.dataset.accion;
    if (!permisos[sec]) permisos[sec] = [];
    permisos[sec].push(acc);
  });
  return permisos;
}

window.toggleMatrizNuevo = function() {
  const tipo = document.querySelector('input[name="nuevo-tipo-cuenta"]:checked')?.value;
  const wrap = document.getElementById('matriz-nuevo-wrap');
  if (tipo === 'personalizado') {
    wrap.style.display = '';
    renderMatriz('matriz-nuevo', {});
  } else {
    wrap.style.display = 'none';
  }
};

window.toggleMatrizEdit = function() {
  const tipo = document.querySelector('input[name="edit-tipo-cuenta"]:checked')?.value;
  document.getElementById('matriz-edit-wrap').style.display = tipo === 'personalizado' ? '' : 'none';
};

// ===== ADMINISTRADORES =====
if (!puedeRoles('crear')) {
  const btnShowAdd = document.getElementById('btn-show-add');
  if (btnShowAdd) btnShowAdd.style.display = 'none';
}

document.getElementById('btn-show-add')?.addEventListener('click', () => {
  document.getElementById('form-nuevo-admin').style.display = '';
  document.getElementById('btn-show-add').style.display = 'none';
});

document.getElementById('btn-cancelar-add')?.addEventListener('click', () => {
  document.getElementById('form-nuevo-admin').style.display = 'none';
  document.getElementById('btn-show-add').style.display = '';
  limpiarFormNuevo();
});

document.getElementById('btn-crear-admin')?.addEventListener('click', async () => {
  const nombre   = document.getElementById('inp-nuevo-nombre').value.trim();
  const usuario  = document.getElementById('inp-nuevo-usuario').value.trim().toLowerCase();
  const password = document.getElementById('inp-nuevo-pass').value;
  const tipo     = document.querySelector('input[name="nuevo-tipo-cuenta"]:checked')?.value || 'admin';

  if (!nombre || !usuario || !password)
    return showStatus('nuevo-status', 'error', 'Completa todos los campos');
  if (password.length < 6)
    return showStatus('nuevo-status', 'error', 'La contraseña debe tener al menos 6 caracteres');
  if (!usuario.includes('@'))
    return showStatus('nuevo-status', 'error', 'Ingresa un correo electrónico válido');

  const permisos = tipo === 'personalizado' ? leerMatriz('matriz-nuevo') : null;

  const btn = document.getElementById('btn-crear-admin');
  btn.disabled = true; btn.textContent = 'Creando...';

  const res = await Auth.crearAdmin({ nombre, usuario, password, rol: tipo, permisos });
  if (res.ok) {
    showStatus('nuevo-status', 'ok', '✅ Usuario creado correctamente');
    limpiarFormNuevo();
    setTimeout(() => {
      document.getElementById('form-nuevo-admin').style.display = 'none';
      document.getElementById('btn-show-add').style.display = '';
    }, 1200);
    cargarAdmins();
  } else {
    showStatus('nuevo-status', 'error', res.msg);
  }
  btn.disabled = false; btn.textContent = 'Crear usuario';
});

let _adminsCache = [];

async function cargarAdmins() {
  const lista = document.getElementById('lista-admins');
  if (!lista) return;
  lista.innerHTML = '<div style="padding:20px;text-align:center;color:#bbb;font-size:13px;">Cargando...</div>';

  const admins = await Auth.listarAdmins();
  _adminsCache = admins;
  if (admins.length === 0) {
    lista.innerHTML = '<div style="padding:20px;text-align:center;color:#bbb;font-size:13px;">No hay administradores registrados</div>';
    return;
  }
  lista.innerHTML = '';
  admins.forEach(a => {
    const esCurrent = a.id === session?.uid;
    const rolLabel = a.rol === 'personalizado' ? 'personalizado' : (a.rol || 'admin');
    const row = document.createElement('div');
    row.className = 'config-admin-row';
    row.innerHTML = `
      <div class="config-admin-info">
        <div class="config-admin-avatar">${(a.nombre || a.usuario || '?')[0].toUpperCase()}</div>
        <div>
          <div class="config-admin-name">${a.nombre || '—'}${esCurrent ? ' <span class="config-badge-you">Tú</span>' : ''}</div>
          <div class="config-admin-user">@${a.usuario} · ${rolLabel}${!a.activo ? ' · <span style="color:#A32D2D">Desactivado</span>' : ''}</div>
        </div>
      </div>
      <div class="config-admin-actions">
        ${!esCurrent && puedeRoles('editar') ? `<button class="btn btn-outline btn-sm" onclick="abrirModalPermisos('${a.id}')">✏️ Permisos</button>` : ''}
        ${!esCurrent && a.activo && puedeRoles('editar') ? `<button class="btn btn-danger btn-sm" onclick="desactivarAdmin('${a.id}')">Desactivar</button>` : ''}
        ${!esCurrent && !a.activo && puedeRoles('editar') ? `<button class="btn btn-success btn-sm" onclick="reactivarAdmin('${a.id}')">Reactivar</button>` : ''}
        ${!esCurrent && puedeRoles('eliminar') ? `<button class="btn btn-outline btn-sm" onclick="eliminarAdmin('${a.id}','${a.nombre||a.usuario}')">Eliminar</button>` : ''}
      </div>`;
    lista.appendChild(row);
  });
}

window.desactivarAdmin = async (id) => {
  if (!confirm('¿Desactivar este administrador?')) return;
  await Auth.desactivarAdmin(id);
  cargarAdmins();
};

window.reactivarAdmin = async (id) => {
  await Auth.reactivarAdmin(id);
  cargarAdmins();
};

window.eliminarAdmin = async (id, nombre) => {
  if (!confirm(`¿Eliminar permanentemente a "${nombre}"?`)) return;
  await Auth.eliminarAdmin(id);
  cargarAdmins();
};

// ===== MODAL EDITAR PERMISOS =====
let _permisosEditId = null;

window.abrirModalPermisos = function(id) {
  const a = _adminsCache.find(x => x.id === id);
  if (!a) return;
  _permisosEditId = id;

  document.getElementById('modal-permisos-title').textContent = `Permisos — ${a.nombre || a.usuario}`;
  const tipo = a.rol === 'personalizado' ? 'personalizado' : 'admin';
  document.querySelector(`input[name="edit-tipo-cuenta"][value="${tipo}"]`).checked = true;
  document.getElementById('matriz-edit-wrap').style.display = tipo === 'personalizado' ? '' : 'none';
  renderMatriz('matriz-edit', a.permisos || {});
  document.getElementById('permisos-status').textContent = '';
  document.getElementById('modal-permisos').style.display = 'flex';
};

window.cerrarModalPermisos = function() {
  document.getElementById('modal-permisos').style.display = 'none';
  _permisosEditId = null;
};

window.guardarPermisos = async function() {
  if (!_permisosEditId) return;
  const tipo = document.querySelector('input[name="edit-tipo-cuenta"]:checked')?.value || 'admin';
  const permisos = tipo === 'personalizado' ? leerMatriz('matriz-edit') : null;

  const statusEl = document.getElementById('permisos-status');
  statusEl.textContent = 'Guardando...';
  statusEl.style.color = '';

  const res = await Auth.actualizarPermisos(_permisosEditId, { rol: tipo, permisos });
  if (res.ok) {
    statusEl.textContent = '✅ Permisos actualizados';
    statusEl.style.color = 'var(--green)';
    await cargarAdmins();
    setTimeout(() => window.cerrarModalPermisos(), 700);
  } else {
    statusEl.textContent = res.msg || 'Error al guardar';
    statusEl.style.color = '#A32D2D';
  }
};

// ===== LOGOUT + FECHA =====
document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ===== INIT =====
cargarAdmins();
