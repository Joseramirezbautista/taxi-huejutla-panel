// ===== SUSCRIPCIONES.JS =====
import { db } from './app.js';
import { Auth } from './auth.js';
import {
  collection, doc, onSnapshot, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const REF_CFG = doc(db, 'configuracion', 'suscripcion');
const COL_TAX = collection(db, 'taxistas');

const ESTADOS_ACTIVOS = ['activo', 'disponible', 'en_viaje', 'en-viaje'];
const DEFAULTS = { costo: 150, periodo: 'mensual' };

let config = { ...DEFAULTS };
// Taxistas para cotizacion: Finanzas los usa para ver "como si tuviera N".
let cotizacion = { taxistas: 0, activa: false };
let totalTax   = 0;
let activosTax = 0;
let cantidadProy = 0;
let taxistasDocs = [];
let docsTax = [];   // ultima lista de taxistas, para repintar el desglose

// ===== HELPERS =====
function fmt(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function flash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('stat-updated');
  void el.offsetWidth;
  el.classList.add('stat-updated');
  setTimeout(() => el.classList.remove('stat-updated'), 700);
}

// ===== CÁLCULO PROYECCIONES =====
function calcProy(cantidad) {
  const { costo, periodo } = config;
  const semana = periodo === 'semanal' ? cantidad * costo : (cantidad * costo) / 4;
  const mes    = periodo === 'mensual' ? cantidad * costo : semana * 4;
  const anio   = mes * 12;
  return { semana, mes, anio };
}

// ===== RENDER STATS SUPERIORES =====
function renderStats() {
  setText('stat-total-tax',   totalTax);
  setText('stat-activos-tax', activosTax);
  setText('stat-costo-sus',   fmt(config.costo));
  setText('badge-total-tax',  totalTax + ' taxistas');

  const { semana, mes } = calcProy(activosTax);
  setText('stat-proy-mes', fmt(mes));

  // Fórmula explicada
  const periodoResult = config.periodo === 'semanal' ? semana : mes;
  setText('f-total-tax', activosTax);
  setText('f-costo',     fmt(config.costo));
  setText('f-resultado', fmt(periodoResult));
}

// ===== RENDER PROYECCIÓN =====
function renderProyeccion() {
  const n = cantidadProy > 0 ? cantidadProy : activosTax;
  const { semana, mes, anio } = calcProy(n);

  setText('proy-semana', fmt(semana));
  setText('proy-mes',    fmt(mes));
  setText('proy-anio',   fmt(anio));

  flash('proy-semana');
  flash('proy-mes');
  flash('proy-anio');

  const inp = document.getElementById('inp-proy-cantidad');
  if (inp && document.activeElement !== inp) inp.value = n;

  // Línea informativa
  const info = document.getElementById('proy-info');
  if (info) {
    const periodoLabel = config.periodo === 'semanal' ? 'semana' : 'mes';
    info.textContent = `${n} taxistas × ${fmt(config.costo)} / ${periodoLabel}`;
  }
}

// ===== RENDER CONFIG CARD =====
function renderConfigCard() {
  setText('disp-costo', Number(config.costo).toFixed(2));
  const periodoLabel = config.periodo === 'semanal' ? 'Semanal' : 'Mensual';
  setText('disp-periodo', periodoLabel);

  const badge = document.getElementById('disp-periodo');
  if (badge) badge.className = 'suscrip-periodo-badge' + (config.periodo === 'semanal' ? ' semanal' : '');
}

// ===== RENDER TABLA ESTADOS =====
function renderEstados(docs) {
  const counts = {};
  docs.forEach(d => {
    const est = d.data().estado || 'desconocido';
    counts[est] = (counts[est] || 0) + 1;
  });

  const tbody = document.getElementById('tbody-estados');
  if (!tbody) return;

  const ORDER = ['activo', 'disponible', 'en_viaje', 'en-viaje', 'pendiente', 'suspendido', 'rechazado'];
  const keys  = [...new Set([...ORDER, ...Object.keys(counts)])].filter(k => counts[k]);

  if (keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#ccc;padding:28px;">Sin taxistas registrados</td></tr>`;
    return;
  }

  tbody.innerHTML = keys.map(est => {
    const n       = counts[est] || 0;
    const esActiv = ESTADOS_ACTIVOS.includes(est);
    const { mes } = calcProy(n);
    const pct     = totalTax > 0 ? Math.round((n / totalTax) * 100) : 0;

    return `<tr>
      <td><span class="badge ${badgeClass(est)}">${est}</span></td>
      <td style="text-align:center;font-weight:600;font-size:15px;">${n}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;background:#f0f0f0;border-radius:4px;height:6px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${esActiv ? 'var(--green)' : '#d1d5db'};border-radius:4px;"></div>
          </div>
          <span style="font-size:11px;color:#999;min-width:26px;">${pct}%</span>
        </div>
      </td>
      <td style="text-align:right;font-weight:600;color:${esActiv ? 'var(--green)' : '#ccc'};">
        ${esActiv ? fmt(mes) : '—'}
      </td>
    </tr>`;
  }).join('');
}

// El estado de pago por taxista, registrar pago e historial viven en
// membresias.js.

function badgeClass(estado) {
  switch (estado) {
    case 'activo':
    case 'disponible':  return 'badge-activo';
    case 'en_viaje':
    case 'en-viaje':    return 'badge-viaje';
    case 'pendiente':   return 'badge-pendiente';
    case 'suspendido':
    case 'rechazado':   return 'badge-suspendido';
    default:            return 'badge-pendiente';
  }
}

// ===== MODO EDICIÓN =====
function setHidden(id, hide) {
  const el = document.getElementById(id);
  if (!el) return;
  if (hide) {
    el.style.display = 'none';
  } else {
    el.hidden = false;
    el.style.display = '';
  }
}

function entrarEdicion() {
  if (!(window.Permisos?.puede('suscripciones', 'editar') ?? true)) return alert('No tienes permiso para editar suscripciones.');
  document.getElementById('inp-costo').value   = config.costo;
  document.getElementById('inp-periodo').value = config.periodo;

  setHidden('disp-costo',   true);
  setHidden('inp-costo',    false);
  setHidden('disp-periodo', true);
  setHidden('inp-periodo',  false);

  setHidden('btn-editar-sus',  true);
  setHidden('btn-guardar-sus', false);
  setHidden('btn-cancel-sus',  false);
  document.getElementById('suscrip-status').textContent = '';
}

function salirEdicion() {
  setHidden('disp-costo',   false);
  setHidden('inp-costo',    true);
  setHidden('disp-periodo', false);
  setHidden('inp-periodo',  true);

  setHidden('btn-editar-sus',  false);
  setHidden('btn-guardar-sus', true);
  setHidden('btn-cancel-sus',  true);
  document.getElementById('suscrip-status').textContent = '';
}

async function guardar() {
  const costo   = parseFloat(document.getElementById('inp-costo').value)  || 0;
  const periodo = document.getElementById('inp-periodo').value;

  const statusEl = document.getElementById('suscrip-status');
  const btnG     = document.getElementById('btn-guardar-sus');
  btnG.disabled    = true;
  btnG.textContent = 'Guardando...';

  try {
    await setDoc(REF_CFG, { costo, periodo, actualizadoEn: serverTimestamp() }, { merge: true });
    statusEl.textContent = '✅ Suscripción actualizada';
    statusEl.className   = 'tarifa-status tarifa-status-ok';
    salirEdicion();
  } catch (e) {
    statusEl.textContent = '❌ Error: ' + e.message;
    statusEl.className   = 'tarifa-status tarifa-status-err';
  } finally {
    btnG.disabled    = false;
    btnG.textContent = 'Guardar';
  }
}

// ===== TAXISTAS PARA COTIZACION =====
function renderCotizacion() {
  const inp = document.getElementById('inp-cot-tax');
  if (!inp) return;
  if (document.activeElement !== inp) inp.value = cotizacion.taxistas || '';
  document.getElementById('chk-cot-activa').checked = cotizacion.activa;
  const badge = document.getElementById('cot-badge');
  badge.textContent = cotizacion.activa && cotizacion.taxistas > 0
    ? `En Finanzas: ${cotizacion.taxistas} taxistas` : 'Sin usar';
  const n = Number(inp.value) || 0;
  const periodoLabel = config.periodo === 'semanal' ? 'semana' : 'mes';
  document.getElementById('cot-info').textContent =
    `Hoy tienes ${activosTax} en línea de ${totalTax} registrados.` +
    (n > 0 ? ` Con ${n} taxistas cobrarías ${fmt(n * config.costo)} por ${periodoLabel}.` : '');
}

async function guardarCotizacion(btn) {
  if (!(window.Permisos?.puede('suscripciones', 'editar') ?? true)) return alert('No tienes permiso para editar suscripciones.');
  const n = Math.max(0, Math.round(Number(document.getElementById('inp-cot-tax').value) || 0));
  const activa = document.getElementById('chk-cot-activa').checked && n > 0;
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    await setDoc(REF_CFG, { cotizacion: { taxistas: n, activa, actualizadoEn: serverTimestamp() } }, { merge: true });
    btn.textContent = 'Guardado';
    setTimeout(() => { btn.textContent = 'Guardar'; }, 1500);
  } catch (e) {
    alert('No se pudo guardar: ' + e.message);
    btn.textContent = 'Guardar';
  } finally {
    btn.disabled = false;
  }
}

// ===== FIRESTORE LISTENERS =====
onSnapshot(COL_TAX, snap => {
  totalTax   = snap.size;
  activosTax = snap.docs.filter(d => ESTADOS_ACTIVOS.includes(d.data().estado)).length;
  if (cantidadProy === 0) cantidadProy = activosTax;
  taxistasDocs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  renderStats();
  renderProyeccion();
  docsTax = snap.docs;
  renderEstados(docsTax);
  renderCotizacion();
});

onSnapshot(REF_CFG, snap => {
  if (snap.exists()) {
    const d = snap.data();
    config.costo   = d.costo   ?? DEFAULTS.costo;
    config.periodo = d.periodo ?? DEFAULTS.periodo;
    cotizacion = {
      taxistas: Math.max(0, Math.round(Number(d.cotizacion?.taxistas) || 0)),
      activa: d.cotizacion?.activa === true,
    };
  }
  renderCotizacion();
  // El desglose usa el costo: si los taxistas llegaron antes que la config,
  // se habia pintado con el costo de fabrica ($150 mensual).
  renderEstados(docsTax);
  renderConfigCard();
  renderStats();
  renderProyeccion();
});

// ===== EVENTOS =====
document.getElementById('btn-cot-guardar')?.addEventListener('click', (e) => guardarCotizacion(e.currentTarget));
document.getElementById('inp-cot-tax')?.addEventListener('input', renderCotizacion);
document.getElementById('btn-editar-sus')?.addEventListener('click', entrarEdicion);
document.getElementById('btn-guardar-sus')?.addEventListener('click', guardar);
document.getElementById('btn-cancel-sus')?.addEventListener('click', () => {
  salirEdicion();
  renderConfigCard();
});

document.getElementById('inp-proy-cantidad')?.addEventListener('input', e => {
  cantidadProy = parseInt(e.target.value) || 0;
  renderProyeccion();
});

// Preview en tiempo real al editar costo
document.getElementById('inp-costo')?.addEventListener('input', e => {
  const preview = parseFloat(e.target.value) || 0;
  const periodo = document.getElementById('inp-periodo')?.value || config.periodo;
  const n       = cantidadProy > 0 ? cantidadProy : activosTax;
  const semana  = periodo === 'semanal' ? n * preview : (n * preview) / 4;
  const mes     = periodo === 'mensual' ? n * preview : semana * 4;
  const anio    = mes * 12;

  setText('proy-semana', fmt(semana));
  setText('proy-mes',    fmt(mes));
  setText('proy-anio',   fmt(anio));
});

// ===== LOGOUT + FECHA =====
document.getElementById('btn-logout')?.addEventListener('click', () => Auth.logout());

const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
