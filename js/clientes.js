// ===== CLIENTES.JS =====
// Compat SDK — igual que viajes.js

if (!localStorage.getItem('taxi_admin_session')) {
  window.location.href = 'login.html';
}

const db = firebase.firestore();

const puedeEditarClientes   = () => window.Permisos?.puede('clientes', 'editar')   ?? true;
const puedeEliminarClientes = () => window.Permisos?.puede('clientes', 'eliminar') ?? true;

let todosLosClientes = [];
let filtroActivo = 'todos';
let busqueda = '';
let clienteActualId = null;
let viajesCount = {};

// ===== HELPERS =====
function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function badgeCliente(bloqueado) {
  return bloqueado
    ? '<span class="badge badge-suspendido">Bloqueado</span>'
    : '<span class="badge badge-activo">Activo</span>';
}

// Presencia de bajo consumo: la app solo escribe al abrir/reanudar y al
// pasar a segundo plano (sin heartbeat), así que "en línea" es exacto en
// el caso normal; `ultimaConexion` sirve de respaldo cuando la app se
// cerró de golpe (batería muerta, kill forzado) sin llegar a avisar.
function tiempoDesde(fecha) {
  const seg = Math.floor((Date.now() - fecha.getTime()) / 1000);
  if (seg < 60) return 'Hace un momento';
  const min = Math.floor(seg / 60);
  if (min < 60) return `Hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  const dias = Math.floor(hrs / 24);
  return `Hace ${dias} d`;
}

function presenciaHtml(c) {
  if (c.enLinea === true) {
    return '<span class="badge badge-activo">🟢 En línea</span>';
  }
  const ts = c.ultimaConexion;
  if (!ts || typeof ts.toDate !== 'function') {
    return '<span class="badge badge-finalizado">Sin datos</span>';
  }
  return `<span class="badge badge-finalizado">${tiempoDesde(ts.toDate())}</span>`;
}

// ===== RENDERIZAR TABLA =====
function renderTabla(lista) {
  const tbody = document.getElementById('tbody-clientes');
  const countEl = document.getElementById('count-clientes');
  if (!tbody) return;

  if (countEl) countEl.textContent = lista.length;

  if (lista.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <div class="empty-icon">👤</div>
          <p>No se encontraron clientes con este filtro</p>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  lista.forEach(({ id, data: c }) => {
    const bloqueado = c.bloqueado === true;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="driver-info">
          <div class="driver-avatar" style="background:#E6F1FB;color:#0C447C;overflow:hidden;padding:0;">
            ${c.fotoUrl
              ? `<img src="${c.fotoUrl}" alt="${c.nombre}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.innerHTML='${initials(c.nombre)}';">`
              : initials(c.nombre)
            }
          </div>
          <div>
            <div class="driver-name">${c.nombre || '—'}</div>
            <div class="driver-phone">${c.correo || ''}</div>
          </div>
        </div>
      </td>
      <td>${c.telefono || '—'}</td>
      <td>${viajesCount[id] ?? c.viajes ?? c.viajesTotal ?? 0}</td>
      <td><span class="rating">⭐ ${(parseFloat(c.calificaciones) || 0).toFixed(1)}</span></td>
      <td>${badgeCliente(bloqueado)}</td>
      <td>${presenciaHtml(c)}</td>
      <td>
        <div class="btn-actions">
          <button class="btn btn-outline btn-sm" onclick="verCliente('${id}')">👁 Ver</button>
          ${puedeEditarClientes() ? (bloqueado
            ? `<button class="btn btn-success btn-sm" onclick="desbloquearCliente('${id}')">✓ Desbloquear</button>`
            : `<button class="btn btn-danger btn-sm" onclick="bloquearCliente('${id}')">⊘ Bloquear</button>`
          ) : ''}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

// ===== FILTRAR Y BUSCAR =====
function aplicarFiltros() {
  let lista = [...todosLosClientes];

  if (filtroActivo === 'activos') {
    lista = lista.filter(({ data: c }) => !c.bloqueado);
  } else if (filtroActivo === 'bloqueados') {
    lista = lista.filter(({ data: c }) => c.bloqueado === true);
  }

  if (busqueda.trim()) {
    const q = busqueda.toLowerCase().trim();
    lista = lista.filter(({ data: c }) =>
      (c.nombre || '').toLowerCase().includes(q) ||
      (c.telefono || '').includes(q)
    );
  }

  renderTabla(lista);
}

// ===== CARGAR DE FIREBASE =====
function cargarViajesCount() {
  db.collection('viajes').where('estado', '==', 'finalizado').get().then(snap => {
    viajesCount = {};
    snap.forEach(d => {
      const cid = d.data().clienteId;
      if (cid) viajesCount[cid] = (viajesCount[cid] || 0) + 1;
    });
    aplicarFiltros();
  });
}

function actualizarConteos() {
  const hoyInicio = new Date();
  hoyInicio.setHours(0, 0, 0, 0);

  let total = 0, activos = 0, bloqueados = 0, nuevos = 0;
  todosLosClientes.forEach(({ data: c }) => {
    total++;
    if (c.bloqueado === true) bloqueados++;
    else activos++;
    const reg = c.fechaRegistro?.toDate?.();
    if (reg && reg >= hoyInicio) nuevos++;
  });

  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== '—' && el.textContent !== String(v)) {
      el.classList.remove('stat-updated');
      void el.offsetWidth;
      el.classList.add('stat-updated');
      setTimeout(() => el.classList.remove('stat-updated'), 700);
    }
    el.textContent = v;
  };

  set('cnt-total',     total);
  set('cnt-activos',   activos);
  set('cnt-bloqueados', bloqueados);
  set('cnt-nuevos',    nuevos);

  document.getElementById('card-bloqueados')
    ?.classList.toggle('stat-card-alert', bloqueados > 0);
}

function initClientes() {
  const tbody = document.getElementById('tbody-clientes');
  if (tbody) tbody.innerHTML = `<tr class="loading-row"><td colspan="7">Cargando clientes...</td></tr>`;

  cargarViajesCount();

  db.collection('clientes').onSnapshot(snap => {
    todosLosClientes = snap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    actualizarConteos();
    aplicarFiltros();
  });
}

// ===== ACCIONES =====
window.bloquearCliente = (id) => {
  if (!puedeEditarClientes()) return alert('No tienes permiso para editar clientes.');
  if (!confirm('¿Bloquear este cliente?')) return;
  db.collection('clientes').doc(id).update({ bloqueado: true, activo: false });
};

window.desbloquearCliente = (id) => {
  if (!puedeEditarClientes()) return alert('No tienes permiso para editar clientes.');
  if (!confirm('¿Desbloquear este cliente?')) return;
  db.collection('clientes').doc(id).update({ bloqueado: false, activo: true });
};

let unsubClienteModal = null;

window.verCliente = (id) => {
  clienteActualId = id;
  window._clienteActualId = id;
  document.getElementById('modal-cliente').dataset.uid = id;
  if (unsubClienteModal) unsubClienteModal();
  unsubClienteModal = db.collection('clientes').doc(id).onSnapshot(snap => {
    if (!snap.exists) return;
    const c = snap.data();
    const nombre = ((c.nombre || '') + ' ' + (c.apellidos || '')).trim() || '—';

    document.getElementById('modal-c-nombre').textContent = nombre;

    // Foto de perfil
    const foto      = document.getElementById('modal-c-foto');
    const initEl    = document.getElementById('modal-c-initials');
    const avatarWrap = document.getElementById('modal-c-avatar-wrap');
    if (c.fotoUrl) {
      foto.src              = c.fotoUrl;
      foto.style.display    = 'block';
      initEl.style.display  = 'none';
      avatarWrap.style.cursor = 'zoom-in';
    } else {
      foto.src              = '';
      foto.style.display    = 'none';
      initEl.textContent    = initials(nombre);
      initEl.style.display  = 'block';
      avatarWrap.style.cursor = 'default';
    }

    // Foto de portada
    const portada     = document.getElementById('modal-c-portada');
    const portadaWrap = document.getElementById('modal-c-portada-wrap');
    if (c.fotoPortadaUrl) {
      portada.onerror         = () => { portadaWrap.style.display = 'none'; };
      portada.src             = c.fotoPortadaUrl;
      portadaWrap.style.display = 'block';
    } else {
      portada.onerror = null;
      portada.src      = '';
      portadaWrap.style.display = 'none';
    }

    // Badge estado
    const badge = document.getElementById('modal-c-estado-badge');
    badge.textContent = c.bloqueado ? 'Bloqueado' : 'Activo';
    badge.className   = c.bloqueado ? 'badge badge-suspendido' : 'badge badge-activo';

    // Botón bloquear/desbloquear (uno solo, cambia según el estado actual)
    const btnToggle = document.getElementById('btn-toggle-bloqueo');
    btnToggle.dataset.bloqueado = c.bloqueado ? '1' : '0';
    btnToggle.textContent = c.bloqueado ? '✓ Desbloquear' : '⊘ Bloquear';
    btnToggle.className   = c.bloqueado ? 'btn btn-success' : 'btn btn-danger';

    // Badge presencia
    document.getElementById('modal-c-presencia-badge').outerHTML =
      presenciaHtml(c).replace('<span', '<span id="modal-c-presencia-badge"');

    document.getElementById('modal-c-telefono').textContent = c.telefono || '—';
    document.getElementById('modal-c-colonia').textContent  = c.colonia  || '—';
    document.getElementById('modal-c-viajes').textContent   = viajesCount[clienteActualId] ?? c.viajes ?? c.viajesTotal ?? 0;
    document.getElementById('modal-c-calificacion').textContent =
      '⭐ ' + (parseFloat(c.calificaciones) || 0).toFixed(1);
    document.getElementById('modal-c-fecha').textContent =
      c.fechaRegistro?.toDate?.()
        ? c.fechaRegistro.toDate().toLocaleDateString('es-MX') : '—';

    document.getElementById('modal-cliente').style.display = 'flex';
  });
};

window.cerrarModalCliente = () => {
  if (unsubClienteModal) { unsubClienteModal(); unsubClienteModal = null; }
  document.getElementById('modal-cliente').style.display = 'none';
};

window.abrirFotoCliente = () => {
  const src = document.getElementById('modal-c-foto').src;
  if (!src) return;
  const nombre = document.getElementById('modal-c-nombre').textContent;
  document.getElementById('lightbox-cliente-img').src   = src;
  document.getElementById('lightbox-cliente-label').textContent = nombre;
  document.getElementById('lightbox-cliente').style.display = 'flex';
};

window.abrirPortadaCliente = () => {
  const src = document.getElementById('modal-c-portada').src;
  if (!src) return;
  const nombre = document.getElementById('modal-c-nombre').textContent;
  document.getElementById('lightbox-cliente-img').src   = src;
  document.getElementById('lightbox-cliente-label').textContent = nombre + ' — Portada';
  document.getElementById('lightbox-cliente').style.display = 'flex';
};

window.cerrarFotoCliente = () => {
  document.getElementById('lightbox-cliente').style.display = 'none';
};

window.verHistorialCliente = function() {
  if (!clienteActualId) return;
  sessionStorage.setItem('historial_cliente_id', clienteActualId);
  window.location.href = `historial-cliente.html?id=${clienteActualId}`;
};

window.bloquearDesdeModal = () => {
  if (!clienteActualId) return;
  db.collection('clientes').doc(clienteActualId)
    .update({ bloqueado: true, activo: false })
    .then(() => {
      alert('⛔ Cliente bloqueado');
      cerrarModalCliente();
    });
};

window.desbloquearDesdeModal = () => {
  if (!clienteActualId) return;
  db.collection('clientes').doc(clienteActualId)
    .update({ bloqueado: false, activo: true })
    .then(() => {
      alert('✅ Cliente desbloqueado');
      cerrarModalCliente();
    });
};

window.toggleBloqueoDesdeModal = () => {
  if (!puedeEditarClientes()) return alert('No tienes permiso para editar clientes.');
  const btn = document.getElementById('btn-toggle-bloqueo');
  const estaBloqueado = btn?.dataset.bloqueado === '1';
  if (estaBloqueado) {
    window.desbloquearDesdeModal();
  } else {
    window.bloquearDesdeModal();
  }
};


// ===== FILTROS UI =====
window.activarFiltro = function(filtro) {
  filtroActivo = filtro;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filtro === filtro);
  });
  aplicarFiltros();
};

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => activarFiltro(btn.dataset.filtro));
});

// ===== BÚSQUEDA =====
document.getElementById('input-buscar')?.addEventListener('input', e => {
  busqueda = e.target.value;
  aplicarFiltros();
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

// ===== INIT =====
firebase.auth().onAuthStateChanged(function(user) {
  if (!user) { window.location.href = 'login.html'; return; }
  initClientes();
});
