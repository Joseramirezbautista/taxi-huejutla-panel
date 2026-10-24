// ===== TARIFAS.JS =====
import { db } from './app.js';
import { Auth } from './auth.js';
import {
  doc, onSnapshot, updateDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const REF = doc(db, 'configuracion', 'tarifas');

const DEFAULTS = { base: 25, porKm: 9, porMinuto: 0.5, minima: 40 };

let config = { ...DEFAULTS };
let modoEdicion = false;

// ===== FORMATO =====
function fmt(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calcTarifa(km, min) {
  const raw = config.base + (config.porKm * km) + (config.porMinuto * min);
  return Math.max(raw, config.minima);
}

// ===== RENDER VALORES =====
function renderConfig() {
  document.getElementById('val-base').textContent    = Number(config.base).toFixed(2);
  document.getElementById('val-km').textContent      = Number(config.porKm).toFixed(2);
  document.getElementById('val-minuto').textContent  = Number(config.porMinuto).toFixed(2);
  document.getElementById('val-minima').textContent  = Number(config.minima).toFixed(2);

  document.getElementById('fml-base').textContent   = fmt(config.base);
  document.getElementById('fml-km').textContent     = fmt(config.porKm);
  document.getElementById('fml-min').textContent    = fmt(config.porMinuto);
  document.getElementById('fml-minima').textContent = fmt(config.minima);

  renderEjemplos();
  recalcularSim();
}

// ===== SIMULADOR =====
function recalcularSim() {
  const km  = parseFloat(document.getElementById('sim-km')?.value)  || 0;
  const min = parseFloat(document.getElementById('sim-min')?.value) || 0;

  if (km === 0 && min === 0) {
    document.getElementById('sim-total').textContent  = '$0.00';
    document.getElementById('sim-detalle').textContent = 'Ingresa km y minutos';
    return;
  }

  const raw    = config.base + (config.porKm * km) + (config.porMinuto * min);
  const final  = Math.max(raw, config.minima);
  const subioAlMinimo = raw < config.minima;

  document.getElementById('sim-total').textContent = fmt(final);

  let detalle = `${fmt(config.base)} base + (${fmt(config.porKm)} × ${km} km) + (${fmt(config.porMinuto)} × ${min} min) = ${fmt(raw)}`;
  if (subioAlMinimo) detalle += ` → sube al mínimo → ${fmt(config.minima)}`;
  document.getElementById('sim-detalle').textContent = detalle;
}

function renderEjemplos() {
  const ejemplos = [
    { id: 'ej-1', km: 5,  min: 12 },
    { id: 'ej-2', km: 1,  min: 4  },
    { id: 'ej-3', km: 10, min: 20 },
  ];
  ejemplos.forEach(({ id, km, min }) => {
    const raw   = config.base + (config.porKm * km) + (config.porMinuto * min);
    const final = Math.max(raw, config.minima);
    const subiMin = raw < config.minima;
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = subiMin
      ? `${fmt(raw)} → mínimo → ${fmt(final)}`
      : fmt(final);
  });
}

// ===== MODO EDICIÓN =====
function entrarEdicion() {
  if (!(window.Permisos?.puede('tarifas', 'editar') ?? true)) return alert('No tienes permiso para editar tarifas.');
  modoEdicion = true;
  document.getElementById('inp-base').value   = config.base;
  document.getElementById('inp-km').value     = config.porKm;
  document.getElementById('inp-minuto').value = config.porMinuto;
  document.getElementById('inp-minima').value = config.minima;

  ['base','km','minuto','minima'].forEach(k => {
    document.getElementById('val-'  + k).style.display = 'none';
    document.getElementById('inp-'  + k).style.display = 'inline-block';
  });

  document.getElementById('btn-editar-tarifa').style.display   = 'none';
  document.getElementById('btn-guardar-tarifa').style.display  = 'inline-flex';
  document.getElementById('btn-cancelar-tarifa').style.display = 'inline-flex';
  document.getElementById('tarifa-status').textContent = '';
}

function salirEdicion() {
  modoEdicion = false;
  ['base','km','minuto','minima'].forEach(k => {
    document.getElementById('val-'  + k).style.display = '';
    document.getElementById('inp-'  + k).style.display = 'none';
  });
  document.getElementById('btn-editar-tarifa').style.display   = '';
  document.getElementById('btn-guardar-tarifa').style.display  = 'none';
  document.getElementById('btn-cancelar-tarifa').style.display = 'none';
}

async function guardar() {
  const nueva = {
    base:       parseFloat(document.getElementById('inp-base').value)   || 0,
    porKm:      parseFloat(document.getElementById('inp-km').value)     || 0,
    porMinuto:  parseFloat(document.getElementById('inp-minuto').value) || 0,
    minima:     parseFloat(document.getElementById('inp-minima').value) || 0,
    actualizadoEn: serverTimestamp()
  };

  const statusEl = document.getElementById('tarifa-status');
  const btnGuardar = document.getElementById('btn-guardar-tarifa');
  btnGuardar.disabled = true;
  btnGuardar.textContent = 'Guardando...';

  try {
    await updateDoc(REF, nueva);
    statusEl.textContent = '✅ Tarifas actualizadas correctamente';
    statusEl.className = 'tarifa-status tarifa-status-ok';
    salirEdicion();
  } catch (e) {
    statusEl.textContent = '❌ Error al guardar: ' + e.message;
    statusEl.className = 'tarifa-status tarifa-status-err';
  } finally {
    btnGuardar.disabled = false;
    btnGuardar.textContent = 'Guardar';
  }
}

// ===== CARGA EN TIEMPO REAL =====
onSnapshot(REF, snap => {
  if (snap.exists()) {
    const d = snap.data();
    config = {
      base:      d.base      ?? DEFAULTS.base,
      porKm:     d.porKm     ?? DEFAULTS.porKm,
      porMinuto: d.porMinuto ?? DEFAULTS.porMinuto,
      minima:    d.minima    ?? DEFAULTS.minima,
    };
  }
  renderConfig();
});

// ===== EVENTOS =====
document.getElementById('btn-editar-tarifa')?.addEventListener('click', entrarEdicion);
document.getElementById('btn-guardar-tarifa')?.addEventListener('click', guardar);
document.getElementById('btn-cancelar-tarifa')?.addEventListener('click', () => {
  salirEdicion();
  renderConfig();
  document.getElementById('tarifa-status').textContent = '';
});

document.getElementById('sim-km')?.addEventListener('input', recalcularSim);
document.getElementById('sim-min')?.addEventListener('input', recalcularSim);

// Clic en ejemplo → llenar simulador
document.querySelectorAll('.sim-ejemplo-row').forEach(row => {
  row.addEventListener('click', () => {
    document.getElementById('sim-km').value  = row.dataset.km;
    document.getElementById('sim-min').value = row.dataset.min;
    recalcularSim();
  });
});

// ===== LOGOUT + FECHA =====
document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
