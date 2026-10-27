// ===== MEMBRESIAS.JS =====
// Estado de pago por taxista (Suscripciones): cuenta regresiva, registrar
// pago con fecha y hora, historial, corregir/anular y dias de cortesia.
//
// Reglas:
//   - La membresia corre desde la hora en que PAGO (no desde que se captura).
//   - Si paga ANTES de vencer, lo nuevo se suma al final de lo que le quedaba
//     (no pierde horas). Si paga DESPUES, corre desde la hora del pago.
//   - Al vencer tiene 12 h de gracia; despues queda "Bloqueado". (El bloqueo
//     en la app del conductor se activa cuando se actualice la app.)
//
// Documentos:
//   taxistas/{uid}: pagoProximoVencimiento, pagoFechaFinPrueba, pagoUltimo,
//     pagoUltimoDetalle, pagoEstado, creditoMembresia, creditoViajes.
//   taxistas/{uid}/pagos/{id}: tipo ('pago' | 'cortesia' | 'puntos'), periodos,
//     diasPorPeriodo, dias (cortesia), membresia, creditoUsado, cobrado,
//     fecha (cuando pago), desde, hasta, metodo, nota, registradoPor,
//     registradoEn, anulado, anuladoPor, anuladoEn, motivo.
//   Finanzas lee estos pagos (fecha, cobrado, creditoUsado) y salta los anulados.
//   taxistas/{uid}/comprobantes/{id}: lo crea el taxista desde la app (perfil →
//     Mi membresia) con periodos, monto, metodo, fechaPago, folio, fotoUrl,
//     estado 'revision'. Aqui se aprueba (registra el pago, misma transaccion)
//     o se rechaza con un motivo. Datos de cobro: configuracion/cobro.
import { db, auth } from './app.js';
import { Auth } from './auth.js';
import {
  collection, doc, onSnapshot, getDocs, runTransaction, writeBatch, addDoc,
  serverTimestamp, Timestamp, increment, deleteField, collectionGroup, updateDoc, setDoc,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const REF_CFG = doc(db, 'configuracion', 'suscripcion');
const COL_TAX = collection(db, 'taxistas');
const MIN = 60000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const GRACIA_H = 12;
const PRUEBA_DIAS = 60;

const $ = (id) => document.getElementById(id);
const puede = () => window.Permisos?.puede('suscripciones', 'editar') ?? true;

let config = { costo: 150, periodo: 'mensual' };
let taxistas = [];        // [{ id, data }]
let filtro = 'todos';
let pago = null;          // estado de la ventana de pago
let histId = null;        // taxista abierto en el historial
let histPagos = [];       // pagos del taxista abierto

// ===== UTILIDADES =====
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');
const ms = (v) => (v?.toMillis ? v.toMillis() : typeof v === 'number' ? v : null);
const diasPeriodo = () => (config.periodo === 'semanal' ? 7 : 30);
const nombrePeriodo = (n) => (config.periodo === 'semanal' ? (n === 1 ? 'semana' : 'semanas') : (n === 1 ? 'mes' : 'meses'));

const DIAS_SEM = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function hora(d) {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
function fecha(t, conHora = true) {
  const d = new Date(t);
  const base = `${DIAS_SEM[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
  return conHora ? `${base}, ${hora(d)}` : base;
}
function esHoy(t) {
  const a = new Date(t); const b = new Date();
  return a.toDateString() === b.toDateString();
}
function duracion(m) {
  m = Math.max(0, m);
  const d = Math.floor(m / DIA);
  const h = Math.floor((m % DIA) / HORA);
  const mi = Math.floor((m % HORA) / MIN);
  if (d >= 1) return h ? `${d} d ${h} h` : `${d} d`;
  if (h >= 1) return mi ? `${h} h ${mi} min` : `${h} h`;
  return `${mi} min`;
}

// ===== ESTADO DE CADA TAXISTA =====
function vencimientoDe(d) {
  const v = ms(d.pagoProximoVencimiento);
  if (v != null) return { venc: v, prueba: false };
  const p = ms(d.pagoFechaFinPrueba);
  if (p != null) return { venc: p, prueba: true };
  return { venc: null, prueba: false };
}

const ESTADOS = {
  gracia: { label: 'En gracia', bg: '#FCEBEB', fg: '#791F1F', barra: '#C1443C', orden: 0, chip: 'Se bloquea si no paga' },
  pronto: { label: 'Vence en menos de 24 h', bg: '#FAEEDA', fg: '#633806', barra: '#C9852B', orden: 1, chip: 'Recuérdales pagar' },
  bloqueado: { label: 'Bloqueado', bg: '#2b2b38', fg: '#ffffff', barra: '#1a1a2e', orden: 2, chip: 'Pasaron las 12 h de gracia' },
  sin: { label: 'Sin membresía', bg: '#f0f0f0', fg: '#555555', barra: '#9a9a9a', orden: 3, chip: '' },
  corriente: { label: 'Al corriente', bg: '#EAF3DE', fg: '#27500A', barra: '#3B6D11', orden: 4, chip: 'Trabajando normal' },
  prueba: { label: 'Prueba gratis', bg: '#E8EEF8', fg: '#1F3F6E', barra: '#2F6FB2', orden: 5, chip: `${PRUEBA_DIAS} días al registrarse` },
};

function estadoDe(d, ahora = Date.now()) {
  const { venc, prueba } = vencimientoDe(d);
  if (venc == null) return { clave: 'sin', venc: null, prueba: false };
  let clave;
  if (ahora < venc - DIA) clave = prueba ? 'prueba' : 'corriente';
  else if (ahora < venc) clave = 'pronto';
  else if (ahora < venc + GRACIA_H * HORA) clave = 'gracia';
  else clave = 'bloqueado';
  return { clave, venc, prueba };
}

// Lo que se muestra en la fila: fecha, subtitulo, cuenta y barra.
function detalleTiempo(d, e, ahora = Date.now()) {
  const fin = e.venc + GRACIA_H * HORA;
  if (e.clave === 'sin') return { fecha: 'Sin pagos', sub: '', cuenta: '—', pct: 0 };
  if (e.clave === 'gracia') {
    return {
      fecha: `Venció ${esHoy(e.venc) ? 'hoy ' + hora(new Date(e.venc)) : fecha(e.venc)}`,
      sub: `Se bloquea ${esHoy(fin) ? 'hoy ' + hora(new Date(fin)) : fecha(fin)}`,
      cuenta: `Quedan ${duracion(fin - ahora)}`,
      pct: (fin - ahora) / (GRACIA_H * HORA) * 100,
    };
  }
  if (e.clave === 'bloqueado') {
    return {
      fecha: `Venció ${fecha(e.venc, false)}`,
      sub: `Bloqueado desde ${fecha(fin)}`,
      cuenta: `Bloqueado hace ${duracion(ahora - fin)}`,
      pct: 100,
    };
  }
  const total = (e.prueba ? PRUEBA_DIAS : diasPeriodo()) * DIA;
  return {
    fecha: fecha(e.venc, false),
    sub: hora(new Date(e.venc)) + (e.prueba ? ' · fin de la prueba' : ''),
    cuenta: `Quedan ${duracion(e.venc - ahora)}`,
    pct: Math.min(100, (e.venc - ahora) / total * 100),
  };
}

// ===== TABLA =====
function pintarChips(conEstado) {
  const cuenta = (k) => conEstado.filter((x) => x.e.clave === k).length;
  const chips = [
    ['gracia', 'En gracia', cuenta('gracia')],
    ['pronto', 'Vencen en 24 h', cuenta('pronto')],
    ['bloqueado', 'Bloqueados', cuenta('bloqueado') + cuenta('sin')],
    ['corriente', 'Al corriente', cuenta('corriente')],
    ['prueba', 'Prueba gratis', cuenta('prueba')],
  ];
  $('mb-chips').innerHTML = chips.map(([k, l, n]) => `
    <button type="button" class="mb-chip${filtro === k ? ' sel' : ''}" data-mb-filtro="${k}" aria-pressed="${filtro === k}">
      <span class="l"><i style="background:${ESTADOS[k].barra};"></i>${l}</span>
      <span class="n">${n}</span>
      <span class="t">${filtro === k ? 'Toca otra vez para ver todos' : ESTADOS[k].chip}</span>
    </button>`).join('');
}

function pintarTabla() {
  const ahora = Date.now();
  const conEstado = taxistas.map((t) => ({ ...t, e: estadoDe(t.data, ahora) }));
  pintarChips(conEstado);
  $('mb-regla').textContent = `${pesos(config.costo)} por ${config.periodo === 'semanal' ? 'semana' : 'mes'} · ${GRACIA_H} h de gracia`;

  const q = $('mb-buscar').value.trim().toLowerCase();
  let filas = conEstado.filter((t) => !q || (t.data.nombre || '').toLowerCase().includes(q) || (t.data.telefono || '').includes(q));
  if (filtro !== 'todos') filas = filas.filter((t) => t.e.clave === filtro || (filtro === 'bloqueado' && t.e.clave === 'sin'));
  if ($('mb-orden').value === 'nombre') {
    filas.sort((a, b) => (a.data.nombre || '').localeCompare(b.data.nombre || '', 'es'));
  } else {
    filas.sort((a, b) => ESTADOS[a.e.clave].orden - ESTADOS[b.e.clave].orden || (a.e.venc ?? 0) - (b.e.venc ?? 0));
  }

  if (!filas.length) {
    $('mb-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:#999;padding:28px;">${taxistas.length ? 'Sin taxistas con ese filtro.' : 'Sin taxistas registrados.'}</td></tr>`;
    return;
  }
  const editar = puede();
  $('mb-tbody').innerHTML = filas.map((t) => {
    const s = ESTADOS[t.e.clave];
    const det = detalleTiempo(t.data, t.e, ahora);
    const ultimo = ms(t.data.pagoUltimo);
    const credito = Math.max(0, Math.round(t.data.creditoMembresia || 0));
    return `<tr>
      <td><div style="font-weight:600;">${esc(t.data.nombre || 'Sin nombre')}</div><div class="mb-sub">${esc(t.data.telefono || '')}</div></td>
      <td><span class="mb-pill" style="background:${s.bg};color:${s.fg};">${s.label}</span></td>
      <td><div style="font-weight:600;">${esc(det.fecha)}</div><div class="mb-sub">${esc(det.sub)}</div></td>
      <td><div class="mb-tiempo" style="color:${t.e.clave === 'bloqueado' ? 'var(--dark)' : s.fg};">${esc(det.cuenta)}</div>
        <div class="mb-prog"><div style="width:${Math.max(0, Math.min(100, det.pct))}%;background:${s.barra};"></div></div></td>
      <td>${ultimo ? `<div>${fecha(ultimo)}</div><div class="mb-sub">${esc(t.data.pagoUltimoDetalle || '')}</div>` : '<span class="mb-sub">Sin pagos</span>'}
        ${credito ? `<div class="mb-sub" style="color:var(--badge-pending-text);font-weight:600;">Crédito de promos: ${pesos(credito)}</div>` : ''}</td>
      <td class="mb-acciones">
        ${editar ? `<button type="button" class="btn btn-primary btn-sm" data-mb-pagar="${t.id}">Registrar pago</button>` : ''}
        <button type="button" class="btn btn-outline btn-sm" data-mb-hist="${t.id}">Historial</button>
      </td>
    </tr>`;
  }).join('');
}

// ===== VENTANA: REGISTRAR / CORREGIR PAGO =====
const aInputFecha = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const aInputHora = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
function leerFechaPago() {
  const f = $('mb-fecha').value; const h = $('mb-hora').value || '00:00';
  if (!f) return null;
  const [y, m, d] = f.split('-').map(Number);
  const [hh, mm] = h.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}
function periodosElegidos() {
  if (pago.periodos !== 'otro') return pago.periodos;
  return Math.max(0, Math.min(52, Math.round(Number($('mb-otro').value) || 0)));
}

// edicion: { pagoId, data } para corregir un pago existente.
function abrirPago(taxistaId, edicion = null) {
  if (!puede()) return;
  const t = taxistas.find((x) => x.id === taxistaId);
  if (!t) return;
  pago = { taxistaId, edicion, periodos: edicion ? (edicion.data.periodos || 1) : 1 };
  const e = estadoDe(t.data);
  $('mb-pago-titulo').textContent = `${edicion ? 'Corregir pago' : 'Registrar pago'} · ${t.data.nombre || 'Taxista'}`;
  $('mb-pago-sub').textContent = edicion
    ? 'Al guardar se recalcula su vencimiento con todos sus pagos.'
    : e.venc == null ? 'Sin membresía todavía.'
    : e.clave === 'bloqueado' || e.clave === 'gracia' ? `Venció ${fecha(e.venc)}`
    : `Vence ${fecha(e.venc)} · le quedan ${duracion(e.venc - Date.now())}`;
  const cuando = edicion ? ms(edicion.data.fecha) : Date.now();
  $('mb-fecha').value = aInputFecha(cuando);
  $('mb-hora').value = aInputHora(cuando);
  $('mb-metodo').value = edicion?.data.metodo || 'Efectivo';
  $('mb-nota').value = edicion?.data.nota || '';
  $('mb-cuantos-etq').textContent = config.periodo === 'semanal' ? '¿Cuántas semanas paga?' : '¿Cuántos meses paga?';
  $('mb-otro').value = '';
  if (![1, 2, 4].includes(pago.periodos)) { $('mb-otro').value = pago.periodos; pago.periodos = 'otro'; }
  $('mb-confirmar').disabled = false;
  $('mb-pago-error').classList.add('mb-oculto');
  pintarPago();
  $('mb-modal-pago').classList.remove('mb-oculto');
}

function pintarPago() {
  const t = taxistas.find((x) => x.id === pago.taxistaId);
  if (!t) return;
  const n = periodosElegidos();
  $('mb-periodos').innerHTML = [1, 2, 4, 'otro'].map((p) => {
    const sel = pago.periodos === p;
    const txt = p === 'otro' ? 'Otro' : `${p} ${nombrePeriodo(p)}`;
    const precio = p === 'otro' ? 'elige' : pesos(p * config.costo);
    return `<button type="button" class="mb-periodo${sel ? ' sel' : ''}" data-mb-periodo="${p}" aria-pressed="${sel}">${txt}<small>${precio}</small></button>`;
  }).join('');
  $('mb-otro').classList.toggle('mb-oculto', pago.periodos !== 'otro');

  const cuando = leerFechaPago();
  const e = estadoDe(t.data);
  const dur = n * diasPeriodo() * DIA;
  if (pago.edicion) {
    $('mb-queda').innerHTML = `<div><span>Pagó</span><b>${cuando ? fecha(cuando) : '—'}</b></div>
      <div><span>Cubre</span><b>${n} ${nombrePeriodo(n)}</b></div>
      <div><span>Vencimiento</span><b>Se recalcula</b></div>`;
    $('mb-linea').innerHTML = '';
    $('mb-queda-nota').textContent = 'Se vuelve a calcular con todos sus pagos, en orden de fecha.';
  } else {
    const suma = e.venc != null && cuando != null && e.venc > cuando;
    const desde = suma ? e.venc : cuando;
    const hasta = desde != null ? desde + dur : null;
    $('mb-queda').innerHTML = `<div><span>Pagó</span><b>${cuando ? fecha(cuando) : '—'}</b></div>
      <div><span>${suma ? 'Le quedaban' : 'Estado'}</span><b>${suma ? `${duracion(e.venc - cuando)} (se suman)` : e.venc == null ? 'Sin membresía' : 'Ya había vencido'}</b></div>
      <div><span>Nuevo vencimiento</span><b style="color:#27500A;">${hasta ? fecha(hasta) : '—'}</b></div>`;
    const resto = suma ? (e.venc - cuando) : 0;
    const totalBarra = resto + dur || 1;
    $('mb-linea').innerHTML = `<div style="width:${resto / totalBarra * 100}%;background:#C9852B;"></div><div style="width:${dur / totalBarra * 100}%;background:#3B6D11;"></div>`;
    $('mb-queda-nota').textContent = suma
      ? `Pagó antes de vencer: ${e.prueba ? 'lo pagado empieza al terminar su prueba gratis' : 'lo nuevo empieza cuando se acaba lo actual'}, no pierde horas.`
      : 'Cuenta desde la fecha y hora en que pagó.';
  }

  const total = n * config.costo;
  const credito = pago.edicion ? Number(pago.edicion.data.creditoUsado) || 0 : Math.max(0, Math.round(t.data.creditoMembresia || 0));
  const usado = Math.min(credito, total);
  const cobrar = pago.edicion ? Number(pago.edicion.data.cobrado) || 0 : total - usado;
  $('mb-cobro').innerHTML = `
    <div class="mb-fila"><span>Membresía (${n} ${nombrePeriodo(n)})</span><b>${pesos(total)}</b></div>
    ${usado ? `<div class="mb-fila" style="color:#27500A;"><span>Crédito por promociones</span><b>−${pesos(usado)}</b></div>` : ''}
    <div class="mb-fila" style="padding-top:8px;border-top:1px solid #f0f0f0;font-size:15px;"><span style="font-weight:700;">${pago.edicion ? 'Se cobró' : 'Cobrar'}</span><b style="font-size:22px;">${pesos(cobrar)}</b></div>
    ${pago.edicion ? '<span class="mb-sub" style="margin:0;">El monto y el crédito usado no cambian al corregir; si se capturó mal, anúlalo y regístralo de nuevo.</span>' : ''}`;
  $('mb-confirmar').textContent = pago.edicion ? 'Guardar corrección' : `Confirmar pago de ${pesos(cobrar)}`;
}

function errorPago(txt) {
  const el = $('mb-pago-error');
  el.textContent = txt;
  el.classList.remove('mb-oculto');
}

async function confirmarPago(btn) {
  if (!puede()) return;
  const n = periodosElegidos();
  const cuando = leerFechaPago();
  if (!cuando) return errorPago('Pon la fecha y la hora en que pagó.');
  if (cuando > Date.now() + 5 * MIN) return errorPago('La fecha del pago no puede ser en el futuro.');
  if (!n) return errorPago('Elige cuántos periodos paga.');
  btn.disabled = true;
  try {
    if (pago.edicion) {
      await writeBatch(db)
        .update(doc(db, 'taxistas', pago.taxistaId, 'pagos', pago.edicion.id), {
          fecha: Timestamp.fromMillis(cuando), periodos: n, diasPorPeriodo: diasPeriodo(),
          membresia: n * config.costo, metodo: $('mb-metodo').value, nota: $('mb-nota').value.trim(),
          corregidoPor: quien(), corregidoEn: serverTimestamp(),
        }).commit();
      await recalcular(pago.taxistaId);
    } else {
      await registrarPago(pago.taxistaId, cuando, n, $('mb-metodo').value, $('mb-nota').value.trim());
    }
    cerrar('mb-modal-pago');
    if (histId === pago.taxistaId) cargarHistorial();
  } catch (e) {
    errorPago('No se pudo guardar: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

const quien = () => auth.currentUser?.email || auth.currentUser?.uid || 'admin';

// En transaccion: el servidor puede estar abonando credito de un viaje que
// acaba de terminar; asi no se pierde ese abono.
// comprobante: { id, fotoUrl } cuando se aprueba uno que mando el taxista; se
// marca aprobado en la misma transaccion (si ya lo reviso otro admin, falla).
async function registrarPago(taxistaId, cuando, n, metodo, nota, comprobante = null) {
  const ref = doc(db, 'taxistas', taxistaId);
  const refComp = comprobante ? doc(db, 'taxistas', taxistaId, 'comprobantes', comprobante.id) : null;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() || {};
    if (refComp) {
      const c = await tx.get(refComp);
      if (!c.exists() || c.data().estado !== 'revision') throw new Error('Este comprobante ya fue revisado.');
    }
    const credito = Math.max(0, Math.round(d.creditoMembresia || 0));
    const total = n * config.costo;
    const usado = Math.min(credito, total);
    const cobrar = total - usado;
    const sobra = credito - usado;
    const { venc } = vencimientoDe(d);
    const desde = venc != null && venc > cuando ? venc : cuando;
    const hasta = desde + n * diasPeriodo() * DIA;
    const detalle = `${n} ${nombrePeriodo(n)} · ${pesos(cobrar)}${usado ? ` + ${pesos(usado)} crédito` : ''}`;
    tx.update(ref, {
      pagoEstado: 'al_corriente',
      pagoUltimo: Timestamp.fromMillis(cuando),
      pagoUltimoDetalle: detalle,
      pagoProximoVencimiento: Timestamp.fromMillis(hasta),
      creditoMembresia: sobra,
      ...(sobra === 0 ? { creditoViajes: 0 } : {}),
    });
    const refPago = doc(collection(db, 'taxistas', taxistaId, 'pagos'));
    tx.set(refPago, {
      tipo: 'pago', periodos: n, diasPorPeriodo: diasPeriodo(),
      membresia: total, creditoUsado: usado, cobrado: cobrar,
      fecha: Timestamp.fromMillis(cuando), desde: Timestamp.fromMillis(desde), hasta: Timestamp.fromMillis(hasta),
      metodo, nota, registradoPor: quien(), registradoEn: serverTimestamp(), anulado: false,
      ...(comprobante ? { comprobanteId: comprobante.id, fotoUrl: comprobante.fotoUrl || null } : {}),
    });
    if (refComp) {
      tx.update(refComp, {
        estado: 'aprobado', pagoId: refPago.id, hasta: Timestamp.fromMillis(hasta),
        revisadoPor: quien(), revisadoEn: serverTimestamp(),
      });
    }
  });
}

// Vuelve a calcular el vencimiento con todos los pagos vigentes, en orden de
// fecha (despues de corregir, anular o dar dias de cortesia).
async function recalcular(taxistaId) {
  const refT = doc(db, 'taxistas', taxistaId);
  const t = taxistas.find((x) => x.id === taxistaId);
  const finPrueba = ms(t?.data.pagoFechaFinPrueba);
  const snap = await getDocs(collection(db, 'taxistas', taxistaId, 'pagos'));
  const lista = snap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() }))
    .filter((p) => !p.data.anulado && ms(p.data.fecha) != null)
    .sort((a, b) => ms(a.data.fecha) - ms(b.data.fecha));
  const batch = writeBatch(db);
  let venc = finPrueba ?? null;
  let ultimoPago = null;
  for (const p of lista) {
    const f = ms(p.data.fecha);
    // Cortesia y canje de puntos: duran sus dias, sin cobro.
    const dur = (p.data.tipo === 'cortesia' || p.data.tipo === 'puntos')
      ? (Number(p.data.dias) || 0) * DIA
      : (Number(p.data.periodos) || 1) * (Number(p.data.diasPorPeriodo) || diasPeriodo()) * DIA;
    const desde = venc != null && venc > f ? venc : f;
    venc = desde + dur;
    batch.update(p.ref, { desde: Timestamp.fromMillis(desde), hasta: Timestamp.fromMillis(venc) });
    if (p.data.tipo !== 'cortesia' && p.data.tipo !== 'puntos') ultimoPago = p;
  }
  const hayPagos = lista.length > 0;
  batch.update(refT, {
    pagoProximoVencimiento: hayPagos ? Timestamp.fromMillis(venc) : deleteField(),
    pagoUltimo: ultimoPago ? ultimoPago.data.fecha : deleteField(),
    pagoUltimoDetalle: ultimoPago
      ? `${ultimoPago.data.periodos || 1} ${nombrePeriodo(ultimoPago.data.periodos || 1)} · ${pesos(ultimoPago.data.cobrado)}${ultimoPago.data.creditoUsado ? ` + ${pesos(ultimoPago.data.creditoUsado)} crédito` : ''}`
      : deleteField(),
  });
  await batch.commit();
}

async function anularPago(pagoId) {
  if (!puede()) return;
  const p = histPagos.find((x) => x.id === pagoId);
  if (!p) return;
  const motivo = prompt('¿Por qué se anula este pago? (por ejemplo: se capturó dos veces)');
  if (motivo === null) return;
  const batch = writeBatch(db);
  batch.update(doc(db, 'taxistas', histId, 'pagos', pagoId), {
    anulado: true, anuladoPor: quien(), anuladoEn: serverTimestamp(), motivo: motivo.trim(),
  });
  // El credito de promociones que se uso en ese pago se le regresa.
  const credito = Number(p.data.creditoUsado) || 0;
  if (credito > 0) batch.update(doc(db, 'taxistas', histId), { creditoMembresia: increment(credito) });
  await batch.commit();
  await recalcular(histId);
  cargarHistorial();
}

async function darCortesia() {
  if (!puede() || !histId) return;
  const dias = Math.max(1, Math.min(30, Math.round(Number($('mb-cortesia').value) || 0)));
  if (!confirm(`¿Dar ${dias} día${dias === 1 ? '' : 's'} de cortesía sin cobrar?`)) return;
  await addDoc(collection(db, 'taxistas', histId, 'pagos'), {
    tipo: 'cortesia', dias, membresia: 0, creditoUsado: 0, cobrado: 0,
    fecha: Timestamp.now(), registradoPor: quien(), registradoEn: serverTimestamp(), anulado: false,
  });
  await recalcular(histId);
  cargarHistorial();
}

// ===== HISTORIAL =====
function abrirHistorial(taxistaId) {
  histId = taxistaId;
  histPagos = [];
  $('mb-hist-eventos').innerHTML = '<p class="mb-sub">Cargando...</p>';
  $('mb-cortesia-caja').classList.toggle('mb-oculto', !puede());
  pintarHistorial();
  $('mb-modal-hist').classList.remove('mb-oculto');
  cargarHistorial();
}

async function cargarHistorial() {
  if (!histId) return;
  const id = histId;
  try {
    const snap = await getDocs(collection(db, 'taxistas', id, 'pagos'));
    if (id !== histId) return;
    histPagos = snap.docs.map((d) => ({ id: d.id, data: d.data() }))
      .sort((a, b) => (ms(b.data.fecha) || 0) - (ms(a.data.fecha) || 0));
  } catch (e) {
    $('mb-hist-eventos').innerHTML = `<p class="mb-sub" style="color:#c00;">No se pudo leer el historial: ${esc(e.message)}</p>`;
    return;
  }
  pintarHistorial();
}

function pintarHistorial() {
  const t = taxistas.find((x) => x.id === histId);
  if (!t) return;
  const d = t.data;
  const e = estadoDe(d);
  const s = ESTADOS[e.clave];
  const det = detalleTiempo(d, e);
  $('mb-hist-titulo').textContent = d.nombre || 'Taxista';
  $('mb-hist-sub').textContent = d.telefono || '';
  $('mb-hist-estado').innerHTML = `<div>
      <div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;color:${e.clave === 'corriente' ? '#a6dc7a' : e.clave === 'prueba' ? '#b9cff0' : '#f2b8b2'};">${s.label}</div>
      <div style="font-size:15px;font-weight:700;margin-top:2px;">${esc(det.fecha)}</div>
      <div style="font-size:12px;color:#c9c9d6;margin-top:2px;">${esc(det.cuenta)}${det.sub ? ' · ' + esc(det.sub) : ''}</div>
    </div>
    ${puede() ? `<button type="button" class="btn btn-sm" style="background:#a6dc7a;color:#1a1a2e;font-weight:700;" data-mb-pagar="${t.id}">Registrar pago</button>` : ''}`;

  const vigentes = histPagos.filter((p) => !p.data.anulado && p.data.tipo !== 'cortesia' && p.data.tipo !== 'puntos');
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
  const esteMes = vigentes.filter((p) => (ms(p.data.fecha) || 0) >= inicioMes.getTime()).reduce((a, p) => a + (Number(p.data.cobrado) || 0), 0);
  const conDesde = vigentes.filter((p) => p.data.desde);
  const aTiempo = conDesde.filter((p) => ms(p.data.desde) > ms(p.data.fecha)).length;
  const total = vigentes.reduce((a, p) => a + (Number(p.data.cobrado) || 0), 0);
  $('mb-hist-stats').innerHTML = `
    <div><span>Pagado este mes</span><b>${pesos(esteMes)}</b></div>
    <div><span>Pagó antes de vencer</span><b>${conDesde.length ? `${aTiempo} de ${conDesde.length}` : '—'}</b></div>
    <div><span>Total pagado</span><b>${pesos(total)}</b></div>`;

  const ev = [];
  if (e.clave === 'bloqueado') ev.push({ color: '#1a1a2e', tt: 'Bloqueado', dd: `Desde ${fecha(e.venc + GRACIA_H * HORA)} · no pagó en las ${GRACIA_H} h de gracia` });
  if (e.clave === 'gracia' || e.clave === 'bloqueado') ev.push({ color: '#C1443C', tt: 'Venció su membresía', dd: fecha(e.venc) });
  for (const p of histPagos) {
    const x = p.data;
    const f = ms(x.fecha);
    if (x.tipo === 'puntos') {
      ev.push({ id: p.id, color: '#E8A33D', anulado: x.anulado, tt: `Canje de puntos: ${x.dias} día${x.dias === 1 ? '' : 's'} de membresía`,
        dd: `${fecha(f)}${x.hasta ? ` · cubrió hasta ${fecha(ms(x.hasta))}` : ''}`, acciones: '' });
      continue;
    }
    if (x.tipo === 'cortesia') {
      ev.push({ id: p.id, color: '#2F6FB2', anulado: x.anulado, tt: `Días de cortesía: ${x.dias} día${x.dias === 1 ? '' : 's'}`,
        dd: `${fecha(f)}${x.hasta ? ` · cubrió hasta ${fecha(ms(x.hasta))}` : ''} · dio: ${esc(x.registradoPor || 'admin')}${x.anulado ? ` · anuló: ${esc(x.anuladoPor || '')}` : ''}`, acciones: !x.anulado ? 'anular' : '' });
      continue;
    }
    const n = Number(x.periodos) || 1;
    const titulo = x.periodos
      ? `Pagó ${n} ${nombrePeriodo(n)} · ${pesos(x.cobrado)}${x.creditoUsado ? ` + ${pesos(x.creditoUsado)} crédito` : ''}${x.metodo ? ' · ' + x.metodo.toLowerCase() : ''}`
      : `Pago registrado · ${pesos(x.cobrado)}${x.creditoUsado ? ` + ${pesos(x.creditoUsado)} crédito` : ''}`;
    const partes = [fecha(f)];
    if (x.desde && ms(x.desde) > f) partes[0] += ' (antes de vencer)';
    if (x.hasta) partes.push(`cubrió hasta ${fecha(ms(x.hasta))}`);
    if (x.nota) partes.push(esc(x.nota));
    if (x.registradoPor) partes.push(`registró: ${esc(x.registradoPor)}`);
    if (x.anulado) partes.push(`anulado${x.motivo ? ' (' + esc(x.motivo) + ')' : ''}${x.anuladoPor ? ' por ' + esc(x.anuladoPor) : ''}`);
    ev.push({ id: p.id, color: x.anulado ? '#b7b7c2' : '#3B6D11', anulado: x.anulado, tt: titulo, dd: partes.join(' · '), acciones: x.anulado ? '' : 'ambas' });
  }
  const finPrueba = ms(d.pagoFechaFinPrueba);
  if (finPrueba) ev.push({ color: '#2F6FB2', tt: finPrueba > Date.now() ? 'Prueba gratis hasta' : 'Terminó su prueba gratis', dd: fecha(finPrueba) });

  const editar = puede();
  $('mb-hist-eventos').innerHTML = ev.length ? ev.map((x) => `
    <div class="mb-ev${x.anulado ? ' anulado' : ''}">
      <span class="p" style="background:${x.color};"></span>
      <div><div class="tt">${esc(x.tt)}</div><div class="mb-sub">${x.dd}</div></div>
      <div style="display:flex;gap:6px;">
        ${editar && x.acciones === 'ambas' ? `<button type="button" class="btn btn-outline btn-sm" data-mb-corregir="${x.id}">Corregir</button>` : ''}
        ${editar && x.acciones ? `<button type="button" class="btn btn-sm" style="border:1px solid #f2c4c0;background:#fff;color:#791F1F;" data-mb-anular="${x.id}">Anular</button>` : ''}
      </div>
    </div>`).join('') : '<p class="mb-sub">Sin pagos registrados.</p>';
}

function cerrar(id) {
  $(id).classList.add('mb-oculto');
  if (id === 'mb-modal-hist') histId = null;
}

// ===== EVENTOS =====
document.addEventListener('click', async (e) => {
  const el = (sel) => e.target.closest(sel);
  if (el('[data-mb-filtro]')) {
    const k = el('[data-mb-filtro]').dataset.mbFiltro;
    filtro = filtro === k ? 'todos' : k;
    return pintarTabla();
  }
  if (el('[data-mb-pagar]')) return abrirPago(el('[data-mb-pagar]').dataset.mbPagar);
  if (el('[data-mb-hist]')) return abrirHistorial(el('[data-mb-hist]').dataset.mbHist);
  if (el('[data-mb-periodo]')) {
    const v = el('[data-mb-periodo]').dataset.mbPeriodo;
    pago.periodos = v === 'otro' ? 'otro' : Number(v);
    pintarPago();
    if (v === 'otro') $('mb-otro').focus();
    return;
  }
  if (el('[data-mb-cerrar]')) return cerrar(el('[data-mb-cerrar]').dataset.mbCerrar);
  if (e.target.classList?.contains('mb-modal')) return cerrar(e.target.id);
  if (el('[data-mb-corregir]')) {
    const p = histPagos.find((x) => x.id === el('[data-mb-corregir]').dataset.mbCorregir);
    if (p && histId) abrirPago(histId, p);
    return;
  }
  if (el('[data-mb-anular]')) {
    try { await anularPago(el('[data-mb-anular]').dataset.mbAnular); } catch (err) { alert('No se pudo anular: ' + err.message); }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('cp-modal').classList.contains('mb-oculto')) cerrar('cp-modal');
  else if (!$('mb-modal-pago').classList.contains('mb-oculto')) cerrar('mb-modal-pago');
  else cerrar('mb-modal-hist');
});
['mb-fecha', 'mb-hora', 'mb-otro'].forEach((id) => $(id).addEventListener('input', () => pago && pintarPago()));
$('mb-confirmar').addEventListener('click', (e) => confirmarPago(e.currentTarget));
$('mb-dar-cortesia').addEventListener('click', async () => {
  try { await darCortesia(); } catch (err) { alert('No se pudo dar la cortesía: ' + err.message); }
});
$('mb-buscar').addEventListener('input', pintarTabla);
$('mb-orden').addEventListener('change', pintarTabla);

// ===== COMPROBANTES QUE MANDAN LOS TAXISTAS =====
let comprobantes = [];   // [{ id, taxistaId, data }]
let cpAbierto = null;

const CP_ESTADO = {
  revision: ['En revisión', '#FAEEDA', '#633806'],
  aprobado: ['Aprobado', '#EAF3DE', '#27500A'],
  rechazado: ['Rechazado', '#FCEBEB', '#791F1F'],
};
const datosTax = (id) => taxistas.find((x) => x.id === id)?.data || {};
const placasDe = (d) => d.vehiculo?.placas || d.placas || '';
const conceptoDe = (d) => 'TH-' + String(placasDe(d)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function pintarComprobantes() {
  const pend = comprobantes.filter((c) => c.data.estado === 'revision');
  $('cp-badge').textContent = pend.length ? `${pend.length} por revisar` : 'Al día';
  // Pendientes primero; despues lo revisado en los ultimos 7 dias.
  const semana = Date.now() - 7 * DIA;
  const filas = comprobantes
    .filter((c) => c.data.estado === 'revision' || (ms(c.data.revisadoEn) || ms(c.data.creadoEn) || 0) > semana)
    .sort((a, b) => {
      const pa = a.data.estado === 'revision' ? 0 : 1;
      const pb = b.data.estado === 'revision' ? 0 : 1;
      return pa - pb || (ms(b.data.creadoEn) || 0) - (ms(a.data.creadoEn) || 0);
    });
  if (!filas.length) {
    $('cp-tbody').innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:22px;">No hay comprobantes nuevos.</td></tr>';
    return;
  }
  $('cp-tbody').innerHTML = filas.map((c) => {
    const d = c.data; const t = datosTax(c.taxistaId);
    const [et, bg, fg] = CP_ESTADO[d.estado] || CP_ESTADO.revision;
    const n = Number(d.periodos) || 1;
    const esperado = n * config.costo - Math.max(0, Math.round(t.creditoMembresia || 0));
    const avisoMonto = d.estado === 'revision' && Number(d.monto) < esperado
      ? `<div class="mb-sub" style="color:#791F1F;">Esperado ${pesos(esperado)}</div>` : '';
    return `<tr>
      <td style="white-space:nowrap;">${ms(d.creadoEn) ? fecha(ms(d.creadoEn)) : '—'}</td>
      <td><b>${esc(t.nombre || 'Taxista')}</b><div class="mb-sub">${esc(placasDe(t))}</div></td>
      <td>${n} ${nombrePeriodo(n)}</td>
      <td><b>${pesos(d.monto)}</b>${avisoMonto}</td>
      <td>${esc(d.metodo || '—')}</td>
      <td><span class="mb-pill" style="background:${bg};color:${fg};">${et}</span>${d.estado === 'rechazado' && d.motivo ? `<div class="mb-sub">${esc(d.motivo)}</div>` : ''}</td>
      <td class="mb-acciones"><button type="button" class="btn ${d.estado === 'revision' ? 'btn-primary' : 'btn-outline'} btn-sm" data-cp-abrir="${esc(c.taxistaId)}/${esc(c.id)}">${d.estado === 'revision' ? 'Revisar' : 'Ver'}</button></td>
    </tr>`;
  }).join('');
}

function abrirComprobante(clave) {
  const c = comprobantes.find((x) => `${x.taxistaId}/${x.id}` === clave);
  if (!c) return;
  cpAbierto = c;
  const d = c.data; const t = datosTax(c.taxistaId);
  const n = Number(d.periodos) || 1;
  const cuando = ms(d.fechaPago) || ms(d.creadoEn) || Date.now();
  const enRevision = d.estado === 'revision';
  $('cp-titulo').textContent = [t.nombre || 'Taxista', placasDe(t)].filter(Boolean).join(' · ');
  $('cp-sub').textContent = `Enviado ${ms(d.creadoEn) ? fecha(ms(d.creadoEn)) : '—'}`;
  $('cp-foto').src = d.fotoUrl || '';
  $('cp-foto-link').href = d.fotoUrl || '#';
  $('cp-foto-link').style.display = d.fotoUrl ? 'block' : 'none';
  const campo = (l, v, full) => `<div class="mb-campo"${full ? ' style="grid-column:1 / -1;"' : ''}><span class="mb-etq">${l}</span><b style="overflow-wrap:anywhere;">${v}</b></div>`;
  $('cp-datos').innerHTML = [
    campo('Monto que pagó', pesos(d.monto)),
    campo('Paga', `${n} ${nombrePeriodo(n)} (${pesos(n * config.costo)})`),
    campo('Método', esc(d.metodo || '—')),
    campo('Pagó el', fecha(cuando)),
    d.folio ? campo('Folio / rastreo', esc(d.folio), true) : '',
    !enRevision ? campo('Estado', `${(CP_ESTADO[d.estado] || CP_ESTADO.revision)[0]}${d.motivo ? ' · ' + esc(d.motivo) : ''}${d.revisadoPor ? ' · ' + esc(d.revisadoPor) : ''}`, true) : '',
  ].join('');
  const { venc } = vencimientoDe(t);
  const desde = venc != null && venc > cuando ? venc : cuando;
  const hasta = desde + n * diasPeriodo() * DIA;
  $('cp-queda').innerHTML = `<div><span>Vence ahora</span><b>${venc ? fecha(venc) : 'Sin membresía'}</b></div>
    <div><span>Suma</span><b>${n} ${nombrePeriodo(n)}</b></div>
    <div><span>Queda hasta</span><b style="color:#27500A;">${fecha(hasta)}</b></div>`;
  $('cp-concepto').textContent = d.metodo === 'Efectivo'
    ? 'Pago en efectivo: confirma que recibiste el dinero antes de aprobar.'
    : `Revisa en tu banco que entró ${pesos(d.monto)} con el concepto ${conceptoDe(t)} antes de aprobar.`;
  $('cp-motivo-caja').style.display = enRevision ? '' : 'none';
  $('cp-pie').style.display = enRevision && puede() ? '' : 'none';
  $('cp-aprobar').textContent = `Aprobar y sumar ${n} ${nombrePeriodo(n)}`;
  $('cp-aprobar').disabled = false; $('cp-rechazar').disabled = false;
  $('cp-error').classList.add('mb-oculto');
  $('cp-modal').classList.remove('mb-oculto');
}

function errorCp(txt) {
  $('cp-error').textContent = txt;
  $('cp-error').classList.remove('mb-oculto');
}

async function aprobarComprobante() {
  const c = cpAbierto;
  if (!c || !puede()) return;
  const d = c.data;
  const n = Math.max(1, Math.min(52, Number(d.periodos) || 1));
  // La fecha que pone el taxista no puede quedar en el futuro.
  const cuando = Math.min(ms(d.fechaPago) || ms(d.creadoEn) || Date.now(), Date.now());
  $('cp-aprobar').disabled = true; $('cp-rechazar').disabled = true;
  try {
    const nota = ['Comprobante de la app', d.folio ? 'folio ' + d.folio : ''].filter(Boolean).join(' · ');
    await registrarPago(c.taxistaId, cuando, n, d.metodo || 'Transferencia', nota.slice(0, 80), { id: c.id, fotoUrl: d.fotoUrl });
    cerrar('cp-modal');
  } catch (e) {
    errorCp('No se pudo aprobar: ' + e.message);
    $('cp-aprobar').disabled = false; $('cp-rechazar').disabled = false;
  }
}

async function rechazarComprobante() {
  const c = cpAbierto;
  if (!c || !puede()) return;
  $('cp-aprobar').disabled = true; $('cp-rechazar').disabled = true;
  try {
    await updateDoc(doc(db, 'taxistas', c.taxistaId, 'comprobantes', c.id), {
      estado: 'rechazado', motivo: $('cp-motivo').value, revisadoPor: quien(), revisadoEn: serverTimestamp(),
    });
    cerrar('cp-modal');
  } catch (e) {
    errorCp('No se pudo rechazar: ' + e.message);
    $('cp-aprobar').disabled = false; $('cp-rechazar').disabled = false;
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cp-abrir]');
  if (b) abrirComprobante(b.dataset.cpAbrir);
});
$('cp-aprobar').addEventListener('click', aprobarComprobante);
$('cp-rechazar').addEventListener('click', rechazarComprobante);

// Sin filtro en la consulta: un filtro sobre collectionGroup pediria un indice
// aparte; son pocos documentos y se filtran aqui.
onSnapshot(collectionGroup(db, 'comprobantes'), (snap) => {
  comprobantes = snap.docs.map((d) => ({ id: d.id, taxistaId: d.ref.parent.parent.id, data: d.data() }));
  pintarComprobantes();
}, (e) => {
  $('cp-tbody').innerHTML = `<tr><td colspan="7" style="color:#c00;padding:18px;">No se pudieron cargar: ${esc(e.message)}</td></tr>`;
});

// ===== DATOS DE COBRO (los ve el taxista al pagar) =====
const REF_COBRO = doc(db, 'configuracion', 'cobro');
const CAMPOS_COBRO = ['banco', 'titular', 'clabe', 'tarjeta', 'efectivo'];
onSnapshot(REF_COBRO, (snap) => {
  const d = snap.data() || {};
  CAMPOS_COBRO.forEach((k) => { if (document.activeElement !== $('cobro-' + k)) $('cobro-' + k).value = d[k] || ''; });
  $('cobro-badge').textContent = d.clabe || d.tarjeta || d.efectivo ? 'Configurado' : 'Falta configurar';
});
$('cobro-guardar').addEventListener('click', async (e) => {
  if (!puede()) return;
  const btn = e.currentTarget;
  const v = Object.fromEntries(CAMPOS_COBRO.map((k) => [k, $('cobro-' + k).value.trim()]));
  v.clabe = v.clabe.replace(/\D/g, '');
  v.tarjeta = v.tarjeta.replace(/\D/g, '');
  if (v.clabe && v.clabe.length !== 18) { $('cobro-estado').textContent = 'La CLABE debe tener 18 dígitos.'; return; }
  if (v.tarjeta && v.tarjeta.length !== 16) { $('cobro-estado').textContent = 'La tarjeta debe tener 16 dígitos.'; return; }
  btn.disabled = true;
  try {
    await setDoc(REF_COBRO, { ...v, actualizadoPor: quien(), actualizadoEn: serverTimestamp() });
    $('cobro-estado').textContent = 'Guardado. Los taxistas ya lo ven en la app.';
  } catch (err) {
    $('cobro-estado').textContent = 'No se pudo guardar: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ===== DATOS EN VIVO =====
onSnapshot(COL_TAX, (snap) => {
  taxistas = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  pintarTabla();
  if (histId) pintarHistorial();
  pintarComprobantes();
});
onSnapshot(REF_CFG, (snap) => {
  if (snap.exists()) {
    const d = snap.data();
    config = { costo: Number(d.costo) || 150, periodo: d.periodo === 'semanal' ? 'semanal' : 'mensual' };
  }
  pintarTabla();
});
// La cuenta regresiva avanza sola.
setInterval(() => {
  pintarTabla();
  if (histId) pintarHistorial();
}, 30000);
