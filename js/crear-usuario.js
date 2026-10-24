// ===== CREAR-USUARIO.JS =====
import { Auth } from './auth.js';

Auth.protect();

function showStatus(elId, tipo, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className   = `config-status config-status-${tipo}`;
}

function generarPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 8; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

document.getElementById('btn-generar-pass')?.addEventListener('click', () => {
  const inp = document.getElementById('inp-pass');
  inp.type  = 'text';
  inp.value = generarPassword();
  const toggleBtn = inp.parentElement.querySelector('.pass-toggle');
  if (toggleBtn) { toggleBtn.textContent = '🙈'; toggleBtn.classList.add('active'); }
});

document.getElementById('btn-crear-usuario')?.addEventListener('click', async () => {
  const tipo     = window.__tipoUsuario || 'cliente';
  const nombre   = document.getElementById('inp-nombre').value.trim();
  const telefono = document.getElementById('inp-telefono').value.trim();
  const password = document.getElementById('inp-pass').value;

  if (!nombre || !telefono || !password)
    return showStatus('crear-status', 'error', 'Completa nombre, teléfono y contraseña');
  if (!/^\d{10}$/.test(telefono))
    return showStatus('crear-status', 'error', 'El teléfono debe tener 10 dígitos');
  if (password.length < 6)
    return showStatus('crear-status', 'error', 'La contraseña debe tener al menos 6 caracteres');

  const payload = { tipo, nombre, telefono, password };

  if (tipo === 'cliente') {
    payload.direccion = {
      direccion: document.getElementById('inp-direccion').value.trim(),
      exterior:  document.getElementById('inp-exterior').value.trim(),
      colonia:   document.getElementById('inp-colonia').value.trim(),
      cp:        document.getElementById('inp-cp').value.trim(),
    };
  } else {
    payload.vehiculo = {
      marca:  document.getElementById('inp-marca').value.trim(),
      modelo: document.getElementById('inp-modelo').value.trim(),
      anio:   document.getElementById('inp-anio').value.trim(),
      color:  document.getElementById('inp-color').value.trim(),
      placas: document.getElementById('inp-placas').value.trim().toUpperCase(),
      tipo:   document.getElementById('inp-tipo-vehiculo').value.trim(),
    };
  }

  const btn = document.getElementById('btn-crear-usuario');
  btn.disabled = true; btn.textContent = 'Creando...';
  showStatus('crear-status', '', '');

  const res = await Auth.crearUsuarioApp(payload);

  btn.disabled = false; btn.textContent = 'Crear usuario';

  if (res.ok) {
    showStatus('crear-status', 'ok', '✅ Usuario creado correctamente');
    document.getElementById('res-telefono').textContent = res.telefono;
    document.getElementById('res-password').textContent = password;
    document.getElementById('resultado-credenciales').style.display = '';

    // Limpiar formulario para permitir crear otro
    ['inp-nombre', 'inp-telefono', 'inp-pass',
     'inp-direccion', 'inp-exterior', 'inp-colonia', 'inp-cp',
     'inp-marca', 'inp-modelo', 'inp-anio', 'inp-color', 'inp-placas', 'inp-tipo-vehiculo'
    ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  } else {
    showStatus('crear-status', 'error', res.msg);
  }
});

// ===== LOGOUT + FECHA =====
document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
