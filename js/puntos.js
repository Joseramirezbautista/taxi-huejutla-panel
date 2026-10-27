// ===== PUNTOS.JS =====
// Programa de puntos para taxistas: reglas (configuracion/puntos), resumen
// del mes, simulacion de que tan dificil es llegar a la meta y saldos.
//
// Los puntos los da y los canjea el SERVIDOR (darPuntos, canjearPuntos,
// vencerPuntos en functions/index.js). Aqui se configuran las reglas y el
// admin puede hacer ajustes manuales, que quedan como movimiento "ajuste".
import { db, auth } from './app.js';
import { Auth } from './auth.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, setDoc, query, where,
  writeBatch, increment, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const $ = (id) => document.getElementById(id);
const puede = () => window.Permisos?.puede('puntos', 'editar') ?? true;
const DIA = 864e5;
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const num = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');
const pesos = (n) => '$' + num(n);

// Mismos valores por defecto que el servidor (PUNTOS_DEF).
const ACCIONES = [
  ['viaje', 'Viaje terminado', 1, 0],
  ['viajePromo', 'Viaje con promoción (además del de arriba)', 10, 0],
  ['cincoEstrellas', 'Calificación de 5 estrellas', 2, 10],
];
const DEF = {
  activo: true, absorbeTaxista: true, meta: 1000, diasPorCanje: 7, venceDias: 60,
  canjesPorMes: 1, calificacionMin: 4.5, alCorriente: true,
  acciones: Object.fromEntries(ACCIONES.map(([k, , pts, tope]) => [k, { pts, tope, activa: true }])),
};

let cfg = structuredClone(DEF);
let costoMembresia = 150;
let periodoMembresia = 'mensual';

function normalizar(d) {
  const c = structuredClone(DEF);
  if (!d) return c;
  const n = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  const b = (v, def) => (typeof v === 'boolean' ? v : def);
  c.activo = b(d.activo, c.activo);
  c.absorbeTaxista = b(d.absorbeTaxista, c.absorbeTaxista);
  c.alCorriente = b(d.alCorriente, c.alCorriente);
  for (const k of ['meta', 'diasPorCanje', 'venceDias', 'canjesPorMes', 'calificacionMin']) c[k] = n(d[k], c[k]);
  for (const [k] of ACCIONES) {
    const a = d.acciones?.[k] || {};
    c.acciones[k] = { pts: n(a.pts, c.acciones[k].pts), tope: n(a.tope, c.acciones[k].tope), activa: b(a.activa, c.acciones[k].activa) };
  }
  return c;
}

// ===== FORMULARIO =====
function pintarForm() {
  $('c-activo').checked = cfg.activo;
  $('c-absorbe').checked = cfg.absorbeTaxista;
  $('c-meta').value = cfg.meta;
  $('c-dias').value = cfg.diasPorCanje;
  $('c-vence').value = cfg.venceDias;
  $('c-canjes').value = cfg.canjesPorMes;
  $('c-calif').value = cfg.calificacionMin;
  $('c-corriente').checked = cfg.alCorriente;
  $('tbody-acciones').innerHTML = ACCIONES.map(([k, nombre]) => {
    const a = cfg.acciones[k];
    return `<tr>
      <td>${esc(nombre)}</td>
      <td><input type="number" min="0" class="pt-in" data-pts="${k}" value="${a.pts}" aria-label="Puntos de ${esc(nombre)}"></td>
      <td><input type="number" min="0" class="pt-in" data-tope="${k}" value="${a.tope}" aria-label="Tope semanal de ${esc(nombre)}"></td>
      <td><input type="checkbox" data-activa="${k}" ${a.activa ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--green);" aria-label="Activa"></td>
    </tr>`;
  }).join('');
}

function leerForm() {
  const c = structuredClone(cfg);
  c.activo = $('c-activo').checked;
  c.absorbeTaxista = $('c-absorbe').checked;
  c.meta = Math.max(1, Math.round(Number($('c-meta').value) || DEF.meta));
  c.diasPorCanje = Math.max(1, Math.round(Number($('c-dias').value) || DEF.diasPorCanje));
  c.venceDias = Math.max(1, Math.round(Number($('c-vence').value) || DEF.venceDias));
  c.canjesPorMes = Math.max(0, Math.round(Number($('c-canjes').value) || 0));
  c.calificacionMin = Math.min(5, Math.max(0, Number($('c-calif').value) || 0));
  c.alCorriente = $('c-corriente').checked;
  for (const [k] of ACCIONES) {
    c.acciones[k] = {
      pts: Math.max(0, Math.round(Number(document.querySelector(`[data-pts="${k}"]`).value) || 0)),
      tope: Math.max(0, Math.round(Number(document.querySelector(`[data-tope="${k}"]`).value) || 0)),
      activa: document.querySelector(`[data-activa="${k}"]`).checked,
    };
  }
  return c;
}

function aviso(texto, ok) {
  const el = $('aviso-guardar');
  el.textContent = texto;
  el.style.display = 'block';
  el.style.background = ok ? 'var(--badge-active-bg)' : 'var(--badge-suspended-bg)';
  el.style.color = ok ? 'var(--badge-active-text)' : 'var(--badge-suspended-text)';
}

$('btn-guardar').addEventListener('click', async (e) => {
  if (!puede()) return;
  const c = leerForm();
  e.currentTarget.disabled = true;
  try {
    await setDoc(doc(db, 'configuracion', 'puntos'), { ...c, actualizadoEn: Timestamp.now() });
    cfg = c;
    aviso('Reglas guardadas. Se aplican desde el siguiente viaje.', true);
    pintarSim();
  } catch (err) {
    aviso('No se pudo guardar: ' + err.message, false);
  } finally {
    e.currentTarget.disabled = false;
  }
});
document.addEventListener('input', (e) => { if (e.target.closest('.pt-card')) pintarSim(); });

// ===== SIMULACION =====
// Puntos por semana segun cuantos viajes hace; con caducidad, la meta solo se
// alcanza si en "venceDias" junta los puntos de la meta.
const valorDia = () => costoMembresia / (periodoMembresia === 'semanal' ? 7 : 30);
function pintarSim() {
  const c = leerForm();
  const a = c.acciones;
  const filas = [['Casual', 20], ['Activo', 60], ['Muy activo', 100]].map(([tipo, viajes]) => {
    const promo = a.viajePromo.activa ? viajes * 0.05 * a.viajePromo.pts : 0;
    const base = a.viaje.activa ? viajes * a.viaje.pts : 0;
    let estrellas = a.cincoEstrellas.activa ? viajes * 0.6 * a.cincoEstrellas.pts : 0;
    if (a.cincoEstrellas.tope > 0) estrellas = Math.min(estrellas, a.cincoEstrellas.tope);
    const porSemana = base + promo + estrellas;
    const semanas = porSemana > 0 ? c.meta / porSemana : Infinity;
    const enPlazo = porSemana * (c.venceDias / 7);
    let llega, bg, fg, costo;
    if (!c.activo) { llega = 'Programa apagado'; bg = '#f0f0f0'; fg = '#555'; costo = '$0'; }
    else if (enPlazo < c.meta) { llega = 'No llega'; bg = '#f0f0f0'; fg = '#555'; costo = '$0'; }
    else {
      const porMes = Math.min(c.canjesPorMes, 30 / (semanas * 7));
      const dinero = porMes * c.diasPorCanje * valorDia();
      llega = `Sí, en ~${Math.ceil(semanas)} semanas`;
      ({ bg, fg } = semanas * 7 > c.venceDias * 0.8 ? { bg: '#FAEEDA', fg: '#633806' } : { bg: '#EAF3DE', fg: '#27500A' });
      costo = `~${pesos(dinero)} al mes por taxista`;
    }
    return `<tr><td style="font-weight:600;">${tipo}</td><td class="der">${viajes}</td><td class="der">~${num(porSemana)}</td>
      <td><span class="pt-pill" style="background:${bg};color:${fg};">${llega}</span></td><td>${costo}</td></tr>`;
  });
  $('tbody-sim').innerHTML = filas.join('');
}

// ===== RESUMEN Y SALDOS =====
let taxistas = [];
let movimientos = []; // todos los movimientos (collectionGroup)

async function cargarDatos() {
  const [snapT, snapM] = await Promise.all([
    getDocs(query(collection(db, 'taxistas'), where('puntosSaldo', '>', 0))),
    getDocs(collectionGroup(db, 'puntos')),
  ]);
  taxistas = snapT.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.puntosSaldo || 0) - (a.puntosSaldo || 0));
  movimientos = snapM.docs
    .filter((d) => d.ref.parent.parent?.parent?.id === 'taxistas')
    .map((d) => ({ taxistaId: d.ref.parent.parent.id, ref: d.ref, ...d.data() }));
  pintarResumen();
  pintarSaldos();
}

function pintarResumen() {
  const ahora = new Date();
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).getTime();
  const delMes = movimientos.filter((m) => (m.fecha?.toMillis?.() || 0) >= inicioMes);
  const dados = delMes.filter((m) => m.tipo === 'gana' || (m.tipo === 'ajuste' && m.pts > 0)).reduce((s, m) => s + m.pts, 0);
  const canjes = delMes.filter((m) => m.tipo === 'canje');
  const vencidos = delMes.filter((m) => m.tipo === 'vence').reduce((s, m) => s - m.pts, 0);
  const saldoTotal = taxistas.reduce((s, t) => s + (t.puntosSaldo || 0), 0);
  const costoCanjes = canjes.length * cfg.diasPorCanje * valorDia();
  const items = [
    ['Puntos dados este mes', num(dados), `${taxistas.length} taxistas con saldo`],
    ['Canjes este mes', num(canjes.length), `${pesos(costoCanjes)} de membresía sin cobrar`],
    ['Vencieron este mes', num(vencidos), 'Puntos que nadie canjeó'],
    ['Saldo de todos', num(saldoTotal), `Equivale a ${num(saldoTotal / cfg.meta)} canjes si todos llegaran`],
  ];
  $('kpis').innerHTML = items.map(([l, v, t]) => `<div class="pt-kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="t">${esc(t)}</div></div>`).join('');
}

function pintarSaldos() {
  $('txt-saldos').textContent = `${taxistas.length} con puntos`;
  if (!taxistas.length) {
    $('tbody-saldos').innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;padding:24px;">Ningún taxista tiene puntos todavía. Se ganan al terminar viajes.</td></tr>';
    return;
  }
  const limite = Date.now() + 15 * DIA;
  const editar = puede();
  $('tbody-saldos').innerHTML = taxistas.map((t) => {
    const mios = movimientos.filter((m) => m.taxistaId === t.id);
    const porVencer = mios.filter((m) => (m.restantes || 0) > 0 && (m.vence?.toMillis?.() || Infinity) <= limite)
      .reduce((s, m) => s + m.restantes, 0);
    const canjes = mios.filter((m) => m.tipo === 'canje').length;
    return `<tr>
      <td style="font-weight:600;">${esc(t.nombre || 'Sin nombre')}</td>
      <td class="der">${num(t.puntosSaldo)}</td>
      <td>${porVencer ? num(porVencer) : '—'}</td>
      <td class="der">${canjes}</td>
      <td class="der" style="white-space:nowrap;">${editar ? `<input type="number" class="pt-in" style="width:80px;" data-ajuste-pts="${t.id}" placeholder="+/−" aria-label="Puntos a sumar o quitar">
        <button type="button" class="btn btn-outline btn-sm" data-ajustar="${t.id}">Aplicar</button>` : ''}</td>
    </tr>`;
  }).join('');
}

// Ajuste manual: positivo = puntos nuevos (vencen como los demas);
// negativo = se quitan de los que vencen antes.
async function ajustar(taxistaId) {
  const inp = document.querySelector(`[data-ajuste-pts="${taxistaId}"]`);
  const pts = Math.round(Number(inp.value) || 0);
  if (!pts) return;
  const t = taxistas.find((x) => x.id === taxistaId);
  const ref = doc(db, 'taxistas', taxistaId);
  const batch = writeBatch(db);
  const ahora = Date.now();
  if (pts > 0) {
    batch.set(doc(collection(ref, 'puntos')), {
      tipo: 'ajuste', concepto: 'Ajuste del administrador', pts, restantes: pts,
      fecha: Timestamp.fromMillis(ahora), vence: Timestamp.fromMillis(ahora + cfg.venceDias * DIA),
      registradoPor: auth.currentUser?.email || 'admin',
    });
    batch.set(ref, { puntosSaldo: increment(pts) }, { merge: true });
  } else {
    let falta = Math.min(-pts, t?.puntosSaldo || 0);
    if (!falta) return;
    const vigentes = movimientos.filter((m) => m.taxistaId === taxistaId && (m.restantes || 0) > 0)
      .sort((a, b) => (a.vence?.toMillis?.() || 0) - (b.vence?.toMillis?.() || 0));
    const quitado = falta;
    for (const m of vigentes) {
      if (falta <= 0) break;
      const toma = Math.min(falta, m.restantes);
      batch.update(m.ref, { restantes: m.restantes - toma });
      falta -= toma;
    }
    batch.set(doc(collection(ref, 'puntos')), {
      tipo: 'ajuste', concepto: 'Ajuste del administrador', pts: -(quitado - falta),
      fecha: Timestamp.fromMillis(ahora), registradoPor: auth.currentUser?.email || 'admin',
    });
    batch.set(ref, { puntosSaldo: increment(-(quitado - falta)) }, { merge: true });
  }
  await batch.commit();
  await cargarDatos();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ajustar]');
  if (!b || !puede()) return;
  b.disabled = true;
  try { await ajustar(b.dataset.ajustar); } catch (err) { alert('No se pudo ajustar: ' + err.message); }
  finally { b.disabled = false; }
});

// ===== ARRANQUE =====
const fechaEl = $('fecha-actual');
if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

Promise.all([
  getDoc(doc(db, 'configuracion', 'puntos')).catch(() => null),
  getDoc(doc(db, 'configuracion', 'suscripcion')).catch(() => null),
]).then(([p, s]) => {
  cfg = normalizar(p?.exists() ? p.data() : null);
  if (s?.exists()) {
    costoMembresia = Number(s.data().costo) || costoMembresia;
    periodoMembresia = s.data().periodo === 'semanal' ? 'semanal' : 'mensual';
  }
  pintarForm();
  pintarSim();
  return cargarDatos();
}).catch((e) => {
  $('tbody-saldos').innerHTML = `<tr><td colspan="5" style="color:#c00;padding:20px;">No se pudieron cargar los datos: ${esc(e.message)}</td></tr>`;
});
