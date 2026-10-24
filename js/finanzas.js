// ===== FINANZAS.JS =====
// Cuanto entra (membresias), cuanto se gasta (Google, Firebase, SMS, fijos)
// y cuanto queda, por dia, semana, mes o año.
//
// Que es real y que es calculado:
//   - REAL, de la base de datos: viajes, alertas enviadas por viaje,
//     pagos de membresia (taxistas/{uid}/pagos), credito por promociones,
//     registros nuevos.
//   - CALCULADO: el gasto de Google, Firebase y SMS. El panel no puede leer
//     la factura de Google; se estima con lo que pasa en cada viaje y con
//     los precios de configuracion/finanzas (los edita el admin).
//
// Lo gratis de Google y de Funciones es por MES calendario; el de lecturas
// y escrituras de Firestore es por DIA. Por eso el costo de cada dia se saca
// acumulando el mes: el dia que se acaba lo gratis empieza a costar.
import { db } from './app.js';
import { Auth } from './auth.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, setDoc, query, where,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';

Auth.protect();

const puede = (accion) => window.Permisos?.puede('finanzas', accion) ?? true;
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function pesos(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const txt = abs > 0 && abs < 10
    ? abs.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(abs).toLocaleString('es-MX');
  return (v < 0 ? '−$' : '$') + txt;
}
const num = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');

// ===== SERVICIOS Y PRECIOS POR DEFECTO =====
// precio en dolares por `cada` unidades. gratis: por mes o por dia.
const SERVICIOS = [
  { id: 'rutas', nombre: 'Rutas', grupo: 'google', quien: 'Alerta del conductor, cotizar e ir por el pasajero', precio: 5, cada: 1000, gratis: 10000, periodo: 'mes' },
  { id: 'autocompletar', nombre: 'Autocompletar', grupo: 'google', quien: 'Buscador de direcciones del pasajero', precio: 2.83, cada: 1000, gratis: 10000, periodo: 'mes' },
  { id: 'detalles', nombre: 'Detalle del lugar', grupo: 'google', quien: 'Al elegir una dirección', precio: 17, cada: 1000, gratis: 5000, periodo: 'mes' },
  { id: 'geocode', nombre: 'Dirección por GPS', grupo: 'google', quien: 'Origen con la ubicación del pasajero', precio: 5, cada: 1000, gratis: 10000, periodo: 'mes' },
  { id: 'escrituras', nombre: 'Escrituras', grupo: 'firebase', quien: 'GPS de conductores y viajes', precio: 0.18, cada: 100000, gratis: 20000, periodo: 'dia' },
  { id: 'lecturas', nombre: 'Lecturas', grupo: 'firebase', quien: 'Apps y panel', precio: 0.06, cada: 100000, gratis: 50000, periodo: 'dia' },
  { id: 'funciones', nombre: 'Funciones', grupo: 'firebase', quien: 'Despacho, promociones y tareas programadas', precio: 0.40, cada: 1000000, gratis: 2000000, periodo: 'mes' },
  { id: 'sms', nombre: 'SMS de verificación', grupo: 'sms', quien: 'Registro e inicio de sesión', precio: 0.06, cada: 1, gratis: 0, periodo: 'mes' },
];
const GRUPOS = { google: 'Google Maps', firebase: 'Firebase', sms: 'SMS' };

// Lo que se estima por viaje (las Rutas se cuentan con datos reales).
const USO_DEF = {
  autocompletar: { valor: 4, etiqueta: 'Autocompletar por viaje pedido' },
  detalles: { valor: 1, etiqueta: 'Detalle del lugar por viaje pedido' },
  geocode: { valor: 1, etiqueta: 'Dirección por GPS por viaje pedido' },
  escriturasViaje: { valor: 12, etiqueta: 'Escrituras por viaje' },
  gpsPorTaxista: { valor: 1500, etiqueta: 'Escrituras de GPS por taxista que trabajó ese día' },
  lecturasViaje: { valor: 40, etiqueta: 'Lecturas por viaje' },
  funcionesViaje: { valor: 6, etiqueta: 'Funciones por viaje' },
  smsPorRegistro: { valor: 1.5, etiqueta: 'SMS por cuenta nueva (incluye reintentos)' },
};
const USO_DE_SERVICIO = { autocompletar: 'autocompletar', detalles: 'detalles', geocode: 'geocode', lecturas: 'lecturasViaje', funciones: 'funcionesViaje', sms: 'smsPorRegistro' };
const FUNCIONES_PROGRAMADAS_DIA = 1440; // reasignarExpirados corre cada minuto

function cfgPorDefecto() {
  return {
    tipoCambio: 18.5,
    precios: Object.fromEntries(SERVICIOS.map((s) => [s.id, { precio: s.precio, gratis: s.gratis }])),
    uso: Object.fromEntries(Object.entries(USO_DEF).map(([k, v]) => [k, v.valor])),
    alertas: Object.fromEntries(SERVICIOS.map((s) => [s.id, { pct: 80, tope: null }])),
    presupuestoDiario: 80,
    fijos: [],
  };
}
function normalizarCfg(d) {
  const base = cfgPorDefecto();
  if (!d) return base;
  const n = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  base.tipoCambio = n(d.tipoCambio, base.tipoCambio);
  for (const s of SERVICIOS) {
    base.precios[s.id] = {
      precio: n(d.precios?.[s.id]?.precio, base.precios[s.id].precio),
      gratis: n(d.precios?.[s.id]?.gratis, base.precios[s.id].gratis),
    };
    base.alertas[s.id] = {
      pct: n(d.alertas?.[s.id]?.pct, 80),
      tope: typeof d.alertas?.[s.id]?.tope === 'number' ? d.alertas[s.id].tope : null,
    };
  }
  for (const k of Object.keys(USO_DEF)) base.uso[k] = n(d.uso?.[k], base.uso[k]);
  base.presupuestoDiario = n(d.presupuestoDiario, base.presupuestoDiario);
  base.fijos = Array.isArray(d.fijos) ? d.fijos.filter((f) => f && f.nombre).map((f) => ({
    nombre: String(f.nombre), monto: n(f.monto, 0),
    cada: ['mensual', 'anual', 'unaVez'].includes(f.cada) ? f.cada : 'mensual',
    fecha: typeof f.fecha === 'string' ? f.fecha : '',
  })) : [];
  return base;
}
// Pesos por cada unidad de un servicio.
const unitario = (s) => cfg.precios[s.id].precio / s.cada * cfg.tipoCambio;

// ===== FECHAS (hora local) =====
const DIA = 86400000;
const clave = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inicioDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sumarDias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const inicioMes = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const diasDelMes = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const deClave = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const aDate = (v) => (v?.toDate ? v.toDate() : v instanceof Date ? v : null);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (d) => `${d.getDate()} ${MESES[d.getMonth()]}`;

function rangoDe(modo, ref) {
  const d = inicioDia(ref);
  if (modo === 'dia') return { inicio: d, fin: sumarDias(d, 1) };
  if (modo === 'semana') {
    const lunes = sumarDias(d, -((d.getDay() + 6) % 7));
    return { inicio: lunes, fin: sumarDias(lunes, 7) };
  }
  if (modo === 'anio') return { inicio: new Date(d.getFullYear(), 0, 1), fin: new Date(d.getFullYear() + 1, 0, 1) };
  return { inicio: inicioMes(d), fin: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
}
function rangoAnterior(modo, r) {
  if (modo === 'dia') return { inicio: sumarDias(r.inicio, -1), fin: r.inicio };
  if (modo === 'semana') return { inicio: sumarDias(r.inicio, -7), fin: r.inicio };
  if (modo === 'anio') return { inicio: new Date(r.inicio.getFullYear() - 1, 0, 1), fin: r.inicio };
  return { inicio: new Date(r.inicio.getFullYear(), r.inicio.getMonth() - 1, 1), fin: r.inicio };
}
// Dias del rango hasta hoy (lo futuro no tiene datos).
function diasDe(r) {
  const out = [];
  const tope = Math.min(r.fin.getTime(), sumarDias(inicioDia(new Date()), 1).getTime());
  for (let d = r.inicio; d.getTime() < tope; d = sumarDias(d, 1)) out.push(clave(d));
  return out;
}
const dentro = (fecha, r) => fecha && fecha >= r.inicio && fecha < r.fin;

// ===== ESTADO =====
let cfg = cfgPorDefecto();
let costoMembresia = 0;
let ciudades = [];
let viajes = [];         // normalizados
let pagos = [];          // { taxistaId, fecha, membresia, creditoUsado, cobrado }
let taxistas = [];       // { id, data }
let clientes = new Map(); // id -> data
let registrosPorDia = new Map(); // clave -> cuentas nuevas
let cargadoDesde = null;
let pagosError = false;   // sin permiso para leer los pagos
let porDia = new Map();  // clave -> { uso, fuentes, costo } (lo que se esta viendo)
let porDiaReal = new Map(); // siempre lo real: avisos, limites y detalle
// Modo cotizacion: "como si tuviera N taxistas" (el numero se guarda en
// Suscripciones, configuracion/suscripcion.cotizacion). Los viajes y su gasto
// crecen al mismo ritmo por taxista que el periodo real.
let simTaxistas = 0;
let periodoMembresia = 'mensual';
let sim = null;          // { n, base, factor } mientras se ve en modo cotizacion
let modo = 'mes';
let tab = 'resumen';

// ===== CARGA =====
function normalizarViaje(d) {
  const v = d.data();
  const fecha = aDate(v.fechaSolicitud);
  if (!fecha) return null;
  const estado = v.estado || '';
  return {
    id: d.id, fecha, fin: aDate(v.fechaFin), estado,
    ciudad: v.ciudad || '', taxistaId: v.taxistaId || null, clienteId: v.clienteId || null,
    esPrueba: v.esPrueba === true,
    notificados: Array.isArray(v.taxistasYaNotificados) ? v.taxistasYaNotificados.length : 0,
    aceptado: !!v.taxistaId || ['aceptado', 'en_camino', 'en_destino', 'finalizado'].includes(estado),
    descuento: v.promoCreditada ? Number(v.descuentoAplicado ?? v.descuento ?? 0) : 0,
    promo: v.promo?.nombre || (v.codigoPromo ? `Código ${v.codigoPromo}` : ''),
    nombre: v.pasajero?.nombre || v.clienteNombre || '',
  };
}

async function cargarTodo(desde) {
  const [snapV, snapP, snapT, snapC] = await Promise.all([
    getDocs(query(collection(db, 'viajes'), where('fechaSolicitud', '>=', Timestamp.fromDate(desde)))),
    getDocs(collectionGroup(db, 'pagos')).catch(() => null),
    getDocs(collection(db, 'taxistas')),
    getDocs(collection(db, 'clientes')),
  ]);
  viajes = snapV.docs.map(normalizarViaje).filter(Boolean);
  pagosError = !snapP;
  pagos = (snapP?.docs || [])
    // Los pagos anulados en Suscripciones no cuentan como ingreso.
    .filter((d) => d.ref.parent.parent?.parent?.id === 'taxistas' && !d.data().anulado)
    .map((d) => {
      const p = d.data();
      return {
        taxistaId: d.ref.parent.parent.id, fecha: aDate(p.fecha),
        membresia: Number(p.membresia) || 0, creditoUsado: Number(p.creditoUsado) || 0, cobrado: Number(p.cobrado) || 0,
      };
    })
    .filter((p) => p.fecha);
  taxistas = snapT.docs.map((d) => ({ id: d.id, data: d.data() }));
  clientes = new Map(snapC.docs.map((d) => [d.id, d.data()]));
  registrosPorDia = new Map();
  const anotar = (data) => {
    const f = aDate(data.fechaRegistro) || aDate(data.creadoAt) || aDate(data.creadoEn);
    if (!f) return;
    const k = clave(f);
    registrosPorDia.set(k, (registrosPorDia.get(k) || 0) + 1);
  };
  taxistas.forEach((t) => anotar(t.data));
  clientes.forEach(anotar);
  cargadoDesde = desde;
}

// ===== USO Y COSTO POR DIA (global, todas las ciudades) =====
function calcularPorDia(factor = 1) {
  const mapa = new Map();
  if (!cargadoDesde) return mapa;
  const hoyK = clave(new Date());
  const porClave = new Map();
  for (const v of viajes) {
    const k = clave(v.fecha);
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(v);
  }
  const u = cfg.uso;
  const acum = {};
  let mes = null;
  for (let d = cargadoDesde; clave(d) <= hoyK; d = sumarDias(d, 1)) {
    const k = clave(d);
    if (k.slice(0, 7) !== mes) { mes = k.slice(0, 7); SERVICIOS.forEach((s) => { acum[s.id] = 0; }); }
    const lista = porClave.get(k) || [];
    const n = lista.length * factor;
    const pedidos = lista.filter((v) => !v.esPrueba).length * factor;
    const conViaje = new Set(lista.filter((v) => v.taxistaId).map((v) => v.taxistaId)).size * factor;
    const fuentes = {
      rutasAlerta: lista.reduce((a, v) => a + v.notificados, 0) * factor,
      rutasCotizar: pedidos,
      rutasIr: lista.filter((v) => v.aceptado).length * factor,
      escriturasGps: conViaje * u.gpsPorTaxista,
      escriturasViajes: n * u.escriturasViaje,
    };
    const uso = {
      rutas: fuentes.rutasAlerta + fuentes.rutasCotizar + fuentes.rutasIr,
      autocompletar: pedidos * u.autocompletar,
      detalles: pedidos * u.detalles,
      geocode: pedidos * u.geocode,
      escrituras: fuentes.escriturasGps + fuentes.escriturasViajes,
      lecturas: n * u.lecturasViaje,
      funciones: n * u.funcionesViaje + FUNCIONES_PROGRAMADAS_DIA,
      sms: (registrosPorDia.get(k) || 0) * factor * u.smsPorRegistro,
    };
    const costo = {};
    for (const s of SERVICIOS) {
      const gratis = cfg.precios[s.id].gratis;
      if (s.periodo === 'dia') {
        costo[s.id] = Math.max(0, uso[s.id] - gratis) * unitario(s);
      } else {
        const antes = Math.max(0, acum[s.id] - gratis);
        acum[s.id] += uso[s.id];
        costo[s.id] = (Math.max(0, acum[s.id] - gratis) - antes) * unitario(s);
      }
    }
    mapa.set(k, { uso, fuentes, costo, mesAcum: { ...acum } });
  }
  return mapa;
}
const costoServicios = (k, mapa = porDia) => {
  const c = mapa.get(k)?.costo;
  return c ? SERVICIOS.reduce((a, s) => a + c[s.id], 0) : 0;
};

function fijoDelDia(k) {
  const d = deClave(k);
  return cfg.fijos.reduce((a, f) => {
    if (f.cada === 'mensual') return a + f.monto / diasDelMes(d);
    if (f.cada === 'anual') return a + f.monto / 365;
    return a + (f.fecha === k ? f.monto : 0);
  }, 0);
}

// Membresia por dia, segun el periodo configurado en Suscripciones.
const membresiaPorDia = () => costoMembresia / (periodoMembresia === 'semanal' ? 7 : 30);

// ===== ESTADO DE PAGO (igual que Suscripciones) =====
function estadoPago(d) {
  const now = Date.now();
  const finPrueba = d.pagoFechaFinPrueba?.toMillis?.();
  const proxVenc = d.pagoProximoVencimiento?.toMillis?.();
  if (proxVenc != null) return now <= proxVenc ? 'al_corriente' : 'atrasado';
  if (finPrueba != null) return now <= finPrueba ? 'prueba' : 'atrasado';
  return 'atrasado';
}

// ===== RESUMEN DE UN PERIODO =====
function resumen(r, ciudad, simular = false) {
  const dias = diasDe(r);
  const enRango = viajes.filter((v) => dentro(v.fecha, r));
  const propios = ciudad ? enRango.filter((v) => v.ciudad === ciudad) : enRango;
  // El costo de servicios es de todo el sistema; con una ciudad se reparte
  // segun cuantos viajes fueron de ella.
  const parte = ciudad ? (enRango.length ? propios.length / enRango.length : 0) : 1;

  const porServicio = Object.fromEntries(SERVICIOS.map((s) => [s.id, 0]));
  for (const k of dias) {
    const c = porDia.get(k)?.costo;
    if (c) SERVICIOS.forEach((s) => { porServicio[s.id] += c[s.id] * parte; });
  }
  const grupo = (g) => SERVICIOS.filter((s) => s.grupo === g).reduce((a, s) => a + porServicio[s.id], 0);
  const fijos = dias.reduce((a, k) => a + fijoDelDia(k), 0);

  const ciudadDe = new Map(taxistas.map((t) => [t.id, t.data.ciudadActual || '']));
  const pagosR = pagos.filter((p) => dentro(p.fecha, r) && (!ciudad || ciudadDe.get(p.taxistaId) === ciudad));
  const cobrado = pagosR.reduce((a, p) => a + p.cobrado, 0);
  const creditoUsado = pagosR.reduce((a, p) => a + p.creditoUsado, 0);

  const reales = propios.filter((v) => !v.esPrueba);
  const finalizados = reales.filter((v) => v.estado === 'finalizado');
  const conPromo = finalizados.filter((v) => v.descuento > 0);
  const servicios = grupo('google') + grupo('firebase') + grupo('sms');
  const gastos = servicios + fijos;

  const registrados = [];
  clientes.forEach((c, id) => {
    const f = aDate(c.fechaRegistro) || aDate(c.creadoAt) || aDate(c.creadoEn);
    if (dentro(f, r)) registrados.push(id);
  });

  const clientesActivos = new Set(reales.map((v) => v.clienteId).filter(Boolean));
  let promosOtorgadas = conPromo.reduce((a, v) => a + v.descuento, 0);
  let membresias = cobrado + creditoUsado;
  let credito = creditoUsado;
  let cob = cobrado;
  // Modo cotizacion: las membresias salen de N taxistas pagando; los viajes,
  // descuentos y clientes crecen con el factor (el gasto ya viene escalado
  // en porDia).
  const fac = simular && sim ? sim.factor : 1;
  if (simular && sim) {
    promosOtorgadas *= fac;
    membresias = sim.n * membresiaPorDia() * dias.length;
    credito = Math.min(membresias, promosOtorgadas);
    cob = membresias - credito;
  }
  return {
    r, dias, parte, porServicio, fijos, servicios, gastos,
    google: grupo('google'), firebase: grupo('firebase'), sms: grupo('sms'),
    cobrado: cob, creditoUsado: credito, membresias, pagos: pagosR,
    queda: cob - gastos,
    pedidos: reales.length, finalizados, conPromo,
    promosOtorgadas,
    clientesActivos,
    nuevos: registrados,
    viajesRango: propios,
    simulado: !!(simular && sim),
    nPedidos: Math.round(reales.length * fac),
    nFinalizados: Math.round(finalizados.length * fac),
    nConPromo: Math.round(conPromo.length * fac),
    nClientes: Math.round(clientesActivos.size * fac),
    nNuevos: Math.round(registrados.length * fac),
    nPagaron: simular && sim ? sim.n : new Set(pagosR.map((p) => p.taxistaId)).size,
  };
}

// ===== AVISOS (mes en curso, todo el sistema) =====
function estadoLimites(mapa = porDiaReal) {
  const hoy = new Date();
  const hoyK = clave(hoy);
  const mesK = hoyK.slice(0, 7);
  const diasMes = [...mapa.keys()].filter((k) => k.startsWith(mesK));
  // Promedio de los ultimos 7 dias COMPLETOS (hoy va a medias); si aun no
  // hay, se usa lo que haya.
  const previos = [...mapa.keys()].filter((k) => k < hoyK).slice(-7);
  const ultimos7 = previos.length ? previos : [hoyK].filter((k) => mapa.has(k));
  const restantes = diasDelMes(hoy) - hoy.getDate();
  return SERVICIOS.map((s) => {
    const gratis = cfg.precios[s.id].gratis;
    const usoMes = diasMes.reduce((a, k) => a + mapa.get(k).uso[s.id], 0);
    const usoHoy = mapa.get(hoyK)?.uso[s.id] || 0;
    const costoMes = diasMes.reduce((a, k) => a + mapa.get(k).costo[s.id], 0);
    const promedio = ultimos7.length ? ultimos7.reduce((a, k) => a + mapa.get(k).uso[s.id], 0) / ultimos7.length : 0;
    const uso = s.periodo === 'dia' ? usoHoy : usoMes;
    const pct = gratis > 0 ? uso / gratis * 100 : null;
    let seAcaba = null;
    if (s.periodo === 'mes' && gratis > 0 && usoMes < gratis && promedio > 0) {
      const faltan = Math.ceil((gratis - usoMes) / promedio);
      if (faltan <= restantes) seAcaba = sumarDias(hoy, faltan);
    }
    // Proyeccion al cierre del mes.
    let costoCierre = costoMes;
    if (s.periodo === 'mes') {
      const final = usoMes + promedio * restantes;
      costoCierre = Math.max(0, final - gratis) * unitario(s);
    } else {
      costoCierre = costoMes + restantes * Math.max(0, promedio - gratis) * unitario(s);
    }
    return { s, gratis, uso, usoMes, pct, costoMes, costoCierre, promedio, seAcaba, alerta: cfg.alertas[s.id] };
  });
}

function avisosActivos(limites) {
  const out = [];
  for (const l of limites) {
    const etiqueta = `${l.s.nombre} (${GRUPOS[l.s.grupo]})`;
    if (l.pct != null && l.pct >= l.alerta.pct) {
      const pasado = l.pct >= 100;
      const cuando = l.s.periodo === 'dia' ? 'de hoy' : 'del mes';
      out.push({
        nivel: l.pct >= 90 ? 'rojo' : 'ambar', servicio: l.s.id,
        titulo: pasado
          ? `${etiqueta}: ya pasaste lo gratis ${cuando} (${num(l.uso)} de ${num(l.gratis)})`
          : `${etiqueta}: ${num(l.uso)} de ${num(l.gratis)} gratis ${cuando} (${Math.round(l.pct)}%)`,
        texto: l.s.periodo === 'dia'
          ? `Se reinicia a la medianoche de California (1:00 a. m. en Hidalgo). Lo que pase cuesta ${pesos(unitario(l.s) * 1000)} por cada 1,000.`
          : l.seAcaba
            ? `A este ritmo se acaba el ${fechaCorta(l.seAcaba)}. Al cierre del mes pagarías ~${pesos(l.costoCierre)}.`
            : pasado ? `Llevas ${pesos(l.costoMes)} este mes; al cierre ~${pesos(l.costoCierre)}.` : `Al cierre del mes pagarías ~${pesos(l.costoCierre)}.`,
      });
    }
    if (l.alerta.tope != null && l.costoMes >= l.alerta.tope) {
      out.push({
        nivel: 'rojo', servicio: l.s.id,
        titulo: `${etiqueta}: pasaste tu tope de ${pesos(l.alerta.tope)} del mes`,
        texto: `Llevas ${pesos(l.costoMes)}; al cierre ~${pesos(l.costoCierre)}.`,
      });
    }
  }
  const hoyK = clave(new Date());
  const hoyGasto = costoServicios(hoyK, porDiaReal);
  if (cfg.presupuestoDiario > 0 && hoyGasto > cfg.presupuestoDiario) {
    out.push({
      nivel: 'ambar', servicio: null,
      titulo: `El gasto de hoy pasó tu presupuesto diario (${pesos(hoyGasto)} de ${pesos(cfg.presupuestoDiario)})`,
      texto: 'Es la suma de Google, Firebase y SMS de hoy.',
    });
  }
  return out;
}

// ===== MODO COTIZACION =====
function pintarAvisoSim() {
  $('lbl-sim').classList.toggle('fz-oculto', !(simTaxistas > 0));
  $('txt-sim').textContent = `Ver como si tuviera ${num(simTaxistas)} taxistas`;
  const el = $('aviso-sim');
  el.classList.toggle('fz-oculto', !sim);
  if (!sim) return;
  const ritmo = sim.base
    ? `En el periodo trabajaron ${num(sim.base)} taxistas: los viajes y su gasto se multiplican por ${sim.factor.toFixed(2)}.`
    : 'En el periodo no hubo viajes reales para tomar el ritmo: solo se simulan las membresías.';
  el.innerHTML = `<span class="ico" aria-hidden="true">i</span>
    <div class="txt"><b>Modo cotización: como si tuvieras ${num(sim.n)} taxistas pagando ${pesos(costoMembresia)} ${periodoMembresia === 'semanal' ? 'a la semana' : 'al mes'}</b>${ritmo} Los avisos, los límites y las pestañas Por taxista y Por cliente siguen con datos reales.</div>
    <a class="btn btn-outline btn-sm" href="suscripciones.html">Cambiar número</a>`;
}

// ===== PINTAR: RESUMEN =====
function tendencia(actual, anterior, subirEsBueno) {
  if (!$('chk-comparar').checked || anterior == null) return { txt: '', cls: 'neutro' };
  if (!anterior) return { txt: actual ? 'Nuevo en este periodo' : 'Igual que antes', cls: 'neutro' };
  const p = Math.round((actual - anterior) / Math.abs(anterior) * 100);
  if (p === 0) return { txt: 'Igual que el periodo anterior', cls: 'neutro' };
  const bueno = subirEsBueno ? p > 0 : p < 0;
  return { txt: `${p > 0 ? '+' : ''}${p}% vs periodo anterior`, cls: bueno ? 'bien' : 'mal' };
}

function pintarAvisos(avisos) {
  const html = avisos.map((a) => `
    <div class="fz-aviso ${a.nivel}" role="${a.nivel === 'rojo' ? 'alert' : 'status'}">
      <span class="ico" aria-hidden="true">!</span>
      <div class="txt"><b>${esc(a.titulo)}</b>${esc(a.texto)}</div>
      ${a.servicio ? `<button type="button" class="btn btn-outline btn-sm" data-detalle="${a.servicio}">Ver detalle</button>` : ''}
    </div>`).join('');
  $('avisos').innerHTML = html;
  $('avisos').classList.toggle('fz-oculto', !avisos.length);
  $('lim-avisos').innerHTML = avisos.length
    ? avisos.map((a) => `<div class="fz-par" style="padding:8px 0;border-top:1px solid #f3f3f3;">
        <span style="display:inline-flex;gap:10px;align-items:center;"><span style="width:10px;height:10px;border-radius:50%;background:${a.nivel === 'rojo' ? '#C1443C' : '#C9852B'};flex-shrink:0;"></span>${esc(a.titulo)}</span></div>`).join('')
    : 'Sin avisos. Todo dentro de lo gratis y de tus topes.';
  for (const id of ['menu-avisos', 'tab-avisos']) {
    $(id).textContent = avisos.length;
    $(id).classList.toggle('fz-oculto', !avisos.length);
  }
}

function pintarKpis(a, b) {
  const pagando = a.simulado ? sim.n : taxistasFiltrados().filter((t) => estadoPago(t.data) !== 'atrasado').length;
  const total = a.simulado ? sim.n : taxistasFiltrados().length;
  const atrasados = total - pagando;
  const margen = a.cobrado > 0 ? Math.round(a.queda / a.cobrado * 100) : null;
  const items = [
    { l: 'Ingreso (cobrado)', v: pesos(a.cobrado), ...tendencia(a.cobrado, b?.cobrado, true) },
    { l: 'Gastos', v: pesos(a.gastos), ...tendencia(a.gastos, b?.gastos, false) },
    { l: 'Te queda', v: pesos(a.queda), txt: margen == null ? 'Sin cobros en el periodo' : `Margen ${margen}%`, cls: '', oscuro: true },
    { l: 'Viajes terminados', v: num(a.nFinalizados), ...tendencia(a.nFinalizados, b?.nFinalizados, true) },
    { l: 'Taxistas al corriente', v: `${pagando} / ${total}`, txt: a.simulado ? 'Simulado: todos pagando' : atrasados ? `${atrasados} atrasados · ${pesos(atrasados * costoMembresia)}` : 'Nadie atrasado', cls: a.simulado ? 'neutro' : atrasados ? 'mal' : 'bien' },
    { l: 'Clientes activos', v: num(a.nClientes), txt: `${a.nNuevos} nuevos`, cls: 'neutro' },
  ];
  $('kpis').innerHTML = items.map((k) => `
    <div class="fz-kpi${k.oscuro ? ' oscuro' : ''}"><div class="l">${esc(k.l)}</div><div class="v">${k.v}</div><div class="t ${k.cls}">${esc(k.txt)}</div></div>`).join('');
}

function pintarCascada(a) {
  const pasos = [
    { l: 'Membresías', v: a.membresias, tipo: 'base' },
    { l: 'Pagado con crédito de promos', v: -a.creditoUsado, color: '#C9852B' },
    { l: 'Google Maps', v: -a.google, color: '#2F6FB2' },
    { l: 'Firebase', v: -a.firebase, color: '#2F6FB2' },
    { l: 'SMS', v: -a.sms, color: '#2F6FB2' },
    { l: 'Gastos fijos', v: -a.fijos, color: '#5f5f6e' },
  ];
  let corre = 0;
  const tramos = pasos.map((p) => {
    const desde = corre;
    corre += p.v;
    return { ...p, desde, hasta: corre };
  });
  tramos.push({ l: 'Te queda', v: corre, tipo: 'total', desde: 0, hasta: corre });
  const min = Math.min(0, ...tramos.map((t) => Math.min(t.desde, t.hasta)));
  const max = Math.max(1, ...tramos.map((t) => Math.max(t.desde, t.hasta)));
  const pos = (x) => (x - min) / (max - min) * 100;
  $('cascada').innerHTML = tramos.map((t) => {
    const izq = pos(Math.min(t.desde, t.hasta));
    const ancho = Math.max(Math.abs(pos(t.hasta) - pos(t.desde)), t.v ? 0.4 : 0);
    const color = t.tipo === 'base' ? '#3B6D11' : t.tipo === 'total' ? (t.v < 0 ? '#C1443C' : '#1a1a2e') : t.color;
    const valor = t.tipo ? pesos(t.v) : (t.v ? pesos(t.v) : '$0');
    const cls = t.tipo === 'total' ? (t.v < 0 ? 'mal' : 'bien') : t.tipo ? '' : (t.v ? 'mal' : 'neutro');
    return `<span style="font-weight:${t.tipo ? 700 : 400};">${esc(t.l)}</span>
      <div class="fz-pista"><div style="left:${izq}%;width:${ancho}%;background:${color};"></div></div>
      <b class="der ${cls}">${valor}</b>`;
  }).join('');
  $('cascada-titulo').innerHTML = a.membresias > 0
    ? `De ${pesos(a.membresias)} en membresías te ${a.queda >= 0 ? 'quedan' : 'faltan'} <span class="${a.queda >= 0 ? 'bien' : 'mal'}">${pesos(Math.abs(a.queda))}</span>`
    : 'Sin pagos de membresía registrados en este periodo';
  $('cascada-nota').textContent = pagosError
    ? 'No se pudieron leer los pagos de membresía (falta publicar la regla de lectura). Los ingresos salen en $0.'
    : a.parte < 1
    ? `Ciudad filtrada: Google, Firebase y SMS se reparten por su parte de los viajes (${Math.round(a.parte * 100)}%); los gastos fijos van completos.`
    : 'Membresías = lo cobrado más lo que se pagó con crédito de promociones (registrado en Suscripciones).';
}

function pintarProyeccion(a, limites) {
  const hoy = new Date();
  const esMesActual = modo === 'mes' && dentro(hoy, a.r);
  const card = $('card-proyeccion');
  if (!esMesActual) {
    card.innerHTML = `<div class="fz-eyebrow">Del periodo</div>
      <div style="font-size:30px;font-weight:800;">${pesos(a.queda)} <span style="font-size:13px;font-weight:600;color:#c9c9d6;">te quedaron</span></div>
      <div class="fz-par" style="color:#e4e4ec;"><span>Costo de servicios por viaje</span><b>${pesos(a.nPedidos ? a.servicios / a.nPedidos : 0)}</b></div>
      <div class="fz-par" style="color:#e4e4ec;"><span>Viajes pedidos</span><b>${num(a.nPedidos)}</b></div>`;
    return;
  }
  const g = (grp) => limites.filter((l) => l.s.grupo === grp).reduce((x, l) => x + l.costoCierre, 0) * a.parte;
  const fijosMes = Array.from({ length: diasDelMes(hoy) }, (_, i) => fijoDelDia(clave(new Date(hoy.getFullYear(), hoy.getMonth(), i + 1)))).reduce((x, y) => x + y, 0);
  const gastos = g('google') + g('firebase') + g('sms') + fijosMes;
  const google = limites.filter((l) => l.s.grupo === 'google' && l.seAcaba).sort((x, y) => x.seAcaba - y.seAcaba)[0];
  card.innerHTML = `<div class="fz-eyebrow">Al cierre de ${MESES[hoy.getMonth()]}</div>
    <div style="font-size:30px;font-weight:800;">${pesos(a.cobrado - gastos)} <span style="font-size:13px;font-weight:600;color:#c9c9d6;">te quedarían</span></div>
    <div class="fz-par" style="color:#e4e4ec;"><span>Google${google ? ` (cobra desde el ${hoy.getDate() === google.seAcaba.getDate() ? 'hoy' : fechaCorta(google.seAcaba)})` : ''}</span><b>${pesos(g('google'))}</b></div>
    <div class="fz-par" style="color:#e4e4ec;"><span>Firebase</span><b>${pesos(g('firebase'))}</b></div>
    <div class="fz-par" style="color:#e4e4ec;"><span>SMS</span><b>${pesos(g('sms'))}</b></div>
    <div class="fz-par" style="color:#e4e4ec;"><span>Fijos del mes</span><b>${pesos(fijosMes)}</b></div>
    <div style="font-size:12px;color:#c9c9d6;">Con lo cobrado hasta hoy y el ritmo de los últimos 7 días.</div>`;
}

function pintarPromos(a) {
  const ciudad = $('sel-ciudad').value;
  const pendiente = taxistasFiltrados(ciudad).reduce((x, t) => x + Math.max(0, Number(t.data.creditoMembresia) || 0), 0);
  $('card-promos').innerHTML = `<h2>Promociones</h2>
    <div class="fz-par"><span>Descuentos dados en el periodo</span><b>${pesos(a.promosOtorgadas)}</b></div>
    <div class="fz-par"><span>Viajes con descuento</span><b>${num(a.nConPromo)}</b></div>
    <div class="fz-par"><span>Crédito que aún le debes a taxistas</span><b>${pesos(pendiente)}</b></div>
    <p class="fz-muted" style="margin:0;">El crédito se descuenta de su próxima membresía. <a href="promociones.html">Ver promociones</a></p>`;
}

function pintarGrafica(a) {
  const barras = [];
  const presupuesto = cfg.presupuestoDiario * a.parte;
  if (modo === 'anio') {
    for (let m = 0; m < 12; m++) {
      const ks = a.dias.filter((k) => Number(k.slice(5, 7)) === m + 1);
      if (!ks.length) continue;
      const v = ks.reduce((x, k) => x + costoServicios(k), 0) * a.parte;
      const lim = presupuesto * diasDelMes(new Date(a.r.inicio.getFullYear(), m, 1));
      barras.push({ v, lim, etiqueta: MESES[m], tip: `${MESES[m]}: ${pesos(v)}` });
    }
  } else {
    for (const k of a.dias) {
      const v = costoServicios(k) * a.parte;
      const c = porDia.get(k)?.costo || {};
      const detalle = ['google', 'firebase', 'sms'].map((g) => `${GRUPOS[g]} ${pesos(SERVICIOS.filter((s) => s.grupo === g).reduce((x, s) => x + (c[s.id] || 0), 0) * a.parte)}`).join(' · ');
      barras.push({ v, lim: presupuesto, etiqueta: fechaCorta(deClave(k)), tip: `${fechaCorta(deClave(k))}: ${pesos(v)} (${detalle})` });
    }
  }
  $('grafica-titulo').textContent = modo === 'anio' ? 'Gasto de servicios por mes' : 'Gasto de servicios por día';
  dibujarBarras('graf', barras.map((b) => ({ ...b, color: b.lim > 0 && b.v > b.lim ? '#C9852B' : '#2F6FB2' })), barras[0]?.lim || 0, pesos);
}

// Barras genericas: [{ v, etiqueta, tip, color }], linea horizontal en `linea`.
function dibujarBarras(prefijo, barras, linea, fmt) {
  const max = Math.max(1, linea, ...barras.map((b) => b.v)) * 1.12;
  $(`${prefijo}-eje`).innerHTML = `<span>${fmt(max)}</span><span>${fmt(max / 2)}</span><span>${fmt(0)}</span>`;
  const alto = 170;
  $(`${prefijo}-barras`).innerHTML =
    (linea > 0 ? `<div class="fz-linea" style="bottom:${linea / max * alto}px;"></div>` : '') +
    (barras.length ? barras.map((b) => `<div class="b" title="${esc(b.tip)}" style="height:${Math.max(b.v > 0 ? 2 : 0, b.v / max * alto)}px;background:${b.color};"></div>`).join('')
      : '<div class="fz-muted" style="margin:auto;">Sin días en este periodo todavía.</div>');
  const n = barras.length;
  const marcas = n <= 1 ? barras : [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4), n - 1].map((i) => barras[i]);
  $(`${prefijo}-x`).innerHTML = [...new Set(marcas)].map((b) => `<span>${esc(b.etiqueta)}</span>`).join('');
}

function colorPct(p) {
  if (p >= 90) return ['#C1443C', '#FCEBEB', '#791F1F', p >= 100 ? 'Pasado' : 'Casi'];
  if (p >= 80) return ['#C9852B', '#FAEEDA', '#633806', 'Cerca'];
  return ['#3B6D11', '#EAF3DE', '#27500A', 'Bien'];
}

function pintarLimites(limites) {
  $('limites').innerHTML = limites.map((l) => {
    let pct = l.pct;
    let uso = l.gratis > 0 ? `${num(l.uso)} de ${num(l.gratis)} ${l.s.periodo === 'dia' ? 'hoy' : 'este mes'}` : '';
    if (l.pct == null) { // SMS: sin gratis, se mide contra el tope
      pct = l.alerta.tope ? l.costoMes / l.alerta.tope * 100 : 0;
      uso = l.alerta.tope ? `${pesos(l.costoMes)} de tu tope de ${pesos(l.alerta.tope)}` : `${pesos(l.costoMes)} este mes · sin tope`;
    }
    const [barra, chipBg, chipFg, estado] = colorPct(pct);
    const nota = l.s.periodo === 'dia' ? 'Se reinicia cada día'
      : l.seAcaba ? `Se acaba el ${fechaCorta(l.seAcaba)}`
      : l.pct != null && l.pct >= 100 ? `Llevas ${pesos(l.costoMes)}` : l.gratis > 0 ? 'Alcanza todo el mes' : 'No tiene gratis';
    return `<button type="button" class="fz-lim" data-detalle="${l.s.id}">
      <span style="display:flex;justify-content:space-between;gap:6px;align-items:center;width:100%;">
        <span style="font-size:13px;font-weight:700;">${esc(l.s.nombre)} <span class="fz-muted" style="font-weight:500;">· ${GRUPOS[l.s.grupo]}</span></span>
        <span class="fz-chip" style="background:${chipBg};color:${chipFg};">${estado}</span>
      </span>
      <span class="fz-muted">${uso}</span>
      <span class="fz-medidor" style="width:100%;"><div style="width:${Math.min(100, pct)}%;background:${barra};"></div><span style="left:${Math.min(100, l.alerta.pct)}%;"></span></span>
      <span style="font-size:12px;">${esc(nota)}</span>
    </button>`;
  }).join('');
}

function pintarUnitarios(a) {
  const pagaron = a.nPagaron;
  const porViaje = a.nPedidos ? a.servicios / a.nPedidos : 0;
  const porTaxista = pagaron ? a.queda / pagaron : 0;
  const nuevosSet = new Set(a.nuevos);
  const descNuevos = a.conPromo.filter((v) => nuevosSet.has(v.clienteId)).reduce((x, v) => x + v.descuento, 0);
  const smsUnit = unitario(SERVICIOS.find((s) => s.id === 'sms')) * cfg.uso.smsPorRegistro;
  const porNuevo = a.nuevos.length ? (descNuevos + a.nuevos.length * smsUnit) / a.nuevos.length : 0;
  const c = (titulo, valor, extra, nota) => `<section class="fz-card" style="flex:1 1 260px;">
      <div class="fz-eyebrow">${titulo}</div>
      <div style="font-size:30px;font-weight:800;">${valor}${extra ? ` <span class="fz-muted" style="font-weight:600;">${extra}</span>` : ''}</div>
      <div class="fz-muted">${nota}</div></section>`;
  $('unitarios').innerHTML =
    c('Cada viaje te cuesta', pesos(porViaje), '', `Google ${pesos(a.nPedidos ? a.google / a.nPedidos : 0)} · Firebase ${pesos(a.nPedidos ? a.firebase / a.nPedidos : 0)} · SMS ${pesos(a.nPedidos ? a.sms / a.nPedidos : 0)}`) +
    c('Cada taxista que pagó te deja', pesos(porTaxista), '', `${pagaron} ${a.simulado ? 'taxistas simulados' : 'pagaron en el periodo'} · ya con todos los gastos`) +
    c('Cada cliente nuevo te costó', pesos(porNuevo), '', `${a.nNuevos} nuevos · descuento promedio + SMS`);
}

function pintarSimulador() {
  const tax = Math.max(0, Number($('sim-tax').value) || 0);
  const cli = Math.max(0, Number($('sim-cli').value) || 0);
  const vpt = Math.max(0, Number($('sim-via').value) || 0);
  const mem = Math.max(0, Number($('sim-mem').value) || 0);
  const viajesMes = tax * vpt;
  const totalV = viajes.length || 0;
  const alertas = totalV ? viajes.reduce((a, v) => a + v.notificados, 0) / totalV : 2;
  const u = cfg.uso;
  const usoMes = {
    rutas: viajesMes * (alertas + 2),
    autocompletar: viajesMes * u.autocompletar,
    detalles: viajesMes * u.detalles,
    geocode: viajesMes * u.geocode,
    funciones: viajesMes * u.funcionesViaje + FUNCIONES_PROGRAMADAS_DIA * 30,
    sms: cli * 0.10 * u.smsPorRegistro,
  };
  const usoDia = {
    escrituras: viajesMes / 30 * u.escriturasViaje + tax * 0.6 * u.gpsPorTaxista,
    lecturas: viajesMes / 30 * u.lecturasViaje,
  };
  let gastos = 0;
  let diaGoogle = null;
  for (const s of SERVICIOS) {
    const gratis = cfg.precios[s.id].gratis;
    if (s.periodo === 'dia') gastos += Math.max(0, usoDia[s.id] - gratis) * unitario(s) * 30;
    else {
      gastos += Math.max(0, usoMes[s.id] - gratis) * unitario(s);
      if (s.grupo === 'google' && usoMes[s.id] > gratis) {
        const dia = Math.max(1, Math.ceil(gratis / (usoMes[s.id] / 30)));
        diaGoogle = diaGoogle == null ? dia : Math.min(diaGoogle, dia);
      }
    }
  }
  const fijosMes = cfg.fijos.reduce((a, f) => a + (f.cada === 'mensual' ? f.monto : f.cada === 'anual' ? f.monto / 12 : 0), 0);
  gastos += fijosMes;
  const ingreso = tax * mem;
  const queda = ingreso - gastos;
  $('sim-res').innerHTML = `
    <div><div class="fz-muted">Viajes al mes</div><div class="v">${num(viajesMes)}</div></div>
    <div><div class="fz-muted">Ingreso</div><div class="v">${pesos(ingreso)}</div></div>
    <div><div class="fz-muted">Gastos</div><div class="v">${pesos(gastos)}</div><div style="font-size:11.5px;font-weight:600;" class="${diaGoogle ? 'mal' : 'bien'}">${diaGoogle ? `Google pasa lo gratis el día ${diaGoogle}` : 'Google dentro de lo gratis'}</div></div>
    <div style="background:${queda >= 0 ? '#EAF3DE' : '#FCEBEB'};border-right:none;"><div class="fz-muted">Te queda</div><div class="v ${queda >= 0 ? 'bien' : 'mal'}">${pesos(queda)}</div></div>`;
}

// ===== PINTAR: POR TAXISTA =====
function taxistasFiltrados(ciudad = $('sel-ciudad').value) {
  return ciudad ? taxistas.filter((t) => t.data.ciudadActual === ciudad) : taxistas;
}

let filasTaxistas = [];
function pintarTaxistas(a) {
  const costoViaje = a.pedidos ? a.servicios / a.pedidos : 0;
  const lista = taxistasFiltrados();
  filasTaxistas = lista.map((t) => {
    const mios = a.finalizados.filter((v) => v.taxistaId === t.id);
    const cobrado = a.pagos.filter((p) => p.taxistaId === t.id).reduce((x, p) => x + p.cobrado, 0);
    const credito = mios.reduce((x, v) => x + v.descuento, 0);
    const gasto = mios.length * costoViaje;
    return {
      id: t.id, nombre: t.data.nombre || 'Sin nombre', tel: t.data.telefono || '',
      vehiculo: [t.data.placa || t.data.placas, t.data.vehiculoMarca || t.data.marca, t.data.vehiculoModelo || t.data.modelo].filter(Boolean).join(' · '),
      viajes: mios.length, estado: estadoPago(t.data), cobrado, credito,
      creditoPendiente: Math.max(0, Number(t.data.creditoMembresia) || 0), gasto, deja: cobrado - gasto,
    };
  });
  const atrasados = filasTaxistas.filter((f) => f.estado === 'atrasado');
  const pagaron = new Set(a.pagos.map((p) => p.taxistaId)).size;
  const pendiente = filasTaxistas.reduce((x, f) => x + f.creditoPendiente, 0);
  $('tax-kpis').innerHTML = [
    ['Taxistas', num(lista.length), ''],
    ['Pagaron en el periodo', num(pagaron), atrasados.length ? `${atrasados.length} atrasados · ${pesos(atrasados.length * costoMembresia)}` : 'Nadie atrasado'],
    ['Crédito que les debes', pesos(pendiente), 'Se descuenta de su membresía'],
    ['Te deja cada uno', pesos(pagaron ? a.queda / pagaron : 0), 'Ya con todos los gastos', true],
  ].map(([l, v, t, o]) => `<div class="fz-kpi${o ? ' oscuro' : ''}"><div class="l">${l}</div><div class="v">${v}</div><div class="t neutro">${esc(t)}</div></div>`).join('');

  const grupos = [
    ['Sin viajes', (f) => f.viajes === 0, '#9aa7b8'],
    ['1 a 20', (f) => f.viajes >= 1 && f.viajes <= 20, '#6E9FD1'],
    ['21 a 60', (f) => f.viajes >= 21 && f.viajes <= 60, '#2F6FB2'],
    ['61 o más', (f) => f.viajes > 60, '#1a1a2e'],
  ].map(([rango, fn, color]) => {
    const fs = filasTaxistas.filter(fn);
    return { rango, n: fs.length, color, gasto: fs.length ? fs.reduce((x, f) => x + f.gasto, 0) / fs.length : 0 };
  });
  const maxG = Math.max(1, ...grupos.map((g) => g.n));
  $('tax-grupos').innerHTML = grupos.map((g) => `<span>${g.rango}</span>
    <div class="p"><div style="width:${g.n / maxG * 100}%;background:${g.color};"></div></div>
    <span class="der"><b>${g.n}</b> · gastan ~${pesos(g.gasto)} c/u</span>`).join('');
  pintarTablaTaxistas();
}

function pintarTablaTaxistas() {
  const q = $('tax-buscar').value.trim().toLowerCase();
  const filtro = $('tax-filtro').value;
  const orden = $('tax-orden').value;
  let fs = filasTaxistas.filter((f) => !q || f.nombre.toLowerCase().includes(q) || f.tel.includes(q));
  if (filtro === 'pagaron') fs = fs.filter((f) => f.estado !== 'atrasado');
  if (filtro === 'deben') fs = fs.filter((f) => f.estado === 'atrasado');
  if (filtro === 'credito') fs = fs.filter((f) => f.creditoPendiente > 0 || f.credito > 0);
  if (filtro === 'sinviajes') fs = fs.filter((f) => f.viajes === 0);
  fs.sort(orden === 'gasto' ? (x, y) => y.gasto - x.gasto : orden === 'deja' ? (x, y) => x.deja - y.deja : (x, y) => y.viajes - x.viajes);
  const ESTADOS = { al_corriente: ['Al corriente', '#EAF3DE', '#27500A'], prueba: ['Prueba gratis', '#FAEEDA', '#633806'], atrasado: ['Atrasado', '#FCEBEB', '#791F1F'] };
  $('tax-tbody').innerHTML = fs.length ? fs.slice(0, 300).map((f) => {
    const [et, bg, fg] = ESTADOS[f.estado];
    return `<tr>
      <td><div style="font-weight:600;">${esc(f.nombre)}</div><div class="fz-muted">${esc(f.vehiculo || f.tel)}</div></td>
      <td class="der">${num(f.viajes)}</td>
      <td><span class="fz-chip" style="background:${bg};color:${fg};">${et}</span></td>
      <td class="der">${f.cobrado ? pesos(f.cobrado) : '—'}</td>
      <td class="der">${f.credito ? pesos(f.credito) : '—'}${f.creditoPendiente ? `<div class="fz-muted">debes ${pesos(f.creditoPendiente)}</div>` : ''}</td>
      <td class="der">${pesos(f.gasto)}</td>
      <td class="der" style="font-weight:700;"><span class="${f.deja < 0 ? 'mal' : 'bien'}">${pesos(f.deja)}</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" style="text-align:center;color:#999;padding:24px;">Sin taxistas con ese filtro.</td></tr>';
}

// ===== PINTAR: POR CLIENTE =====
let filasClientes = [];
function pintarClientes(a) {
  const costoViaje = a.pedidos ? a.servicios / a.pedidos : 0;
  const nuevos = new Set(a.nuevos);
  // Viajes terminados de cada cliente en TODO lo cargado (para saber si regreso).
  const terminadosDe = new Map();
  for (const v of viajes) {
    if (v.esPrueba || v.estado !== 'finalizado' || !v.clienteId) continue;
    if (!terminadosDe.has(v.clienteId)) terminadosDe.set(v.clienteId, []);
    terminadosDe.get(v.clienteId).push(v.fecha);
  }
  const ids = new Set([...a.clientesActivos, ...a.nuevos]);
  const reales = a.viajesRango.filter((v) => !v.esPrueba);
  filasClientes = [...ids].map((id) => {
    const suyos = reales.filter((v) => v.clienteId === id);
    const fin = suyos.filter((v) => v.estado === 'finalizado');
    const c = clientes.get(id) || {};
    const promos = [...new Set(fin.filter((v) => v.descuento > 0).map((v) => v.promo || 'Promoción'))];
    return {
      id, nombre: c.nombre || suyos[0]?.nombre || 'Sin nombre', tel: c.telefono || '',
      nuevo: nuevos.has(id), viajes: fin.length, promos,
      descuento: fin.reduce((x, v) => x + v.descuento, 0), gasto: suyos.length * costoViaje,
      regreso: (terminadosDe.get(id) || []).length >= 2,
    };
  });
  const activos = a.clientesActivos.size;
  const regresaron = filasClientes.filter((f) => f.nuevo && f.regreso).length;
  const smsUnit = unitario(SERVICIOS.find((s) => s.id === 'sms')) * cfg.uso.smsPorRegistro;
  const descNuevos = filasClientes.filter((f) => f.nuevo).reduce((x, f) => x + f.descuento, 0);
  $('cli-kpis').innerHTML = [
    ['Clientes activos', num(activos), 'Con al menos un viaje pedido'],
    ['Nuevos', num(a.nuevos.length), 'Se registraron en el periodo'],
    ['Viajes por cliente', activos ? (a.finalizados.length / activos).toFixed(1) : '0', 'Terminados'],
    ['Cada nuevo te costó', pesos(a.nuevos.length ? (descNuevos + a.nuevos.length * smsUnit) / a.nuevos.length : 0), 'Descuento + SMS'],
    ['Nuevos que regresaron', `${regresaron} de ${a.nuevos.length}`, 'Dos viajes o más', true],
  ].map(([l, v, t, o]) => `<div class="fz-kpi${o ? ' oscuro' : ''}"><div class="l">${l}</div><div class="v">${v}</div><div class="t neutro">${esc(t)}</div></div>`).join('');

  // ¿Valio la pena cada promocion? Regreso = otro viaje terminado despues.
  const porPromo = new Map();
  for (const v of a.conPromo) {
    const k = v.promo || 'Promoción';
    if (!porPromo.has(k)) porPromo.set(k, { usos: 0, costo: 0, clientes: new Set(), volvieron: new Set() });
    const p = porPromo.get(k);
    p.usos++; p.costo += v.descuento;
    if (v.clienteId) {
      p.clientes.add(v.clienteId);
      if ((terminadosDe.get(v.clienteId) || []).some((f) => f > v.fecha)) p.volvieron.add(v.clienteId);
    }
  }
  $('cli-promos').innerHTML = porPromo.size ? [...porPromo].sort((x, y) => y[1].usos - x[1].usos).map(([nombre, p]) => {
    const pct = p.clientes.size ? Math.round(p.volvieron.size / p.clientes.size * 100) : 0;
    return `<tr><td>${esc(nombre)}</td><td class="der">${num(p.usos)}</td><td class="der">${pesos(p.costo)}</td>
      <td class="der"><b class="${pct >= 60 ? 'bien' : 'mal'}">${p.volvieron.size} (${pct}%)</b></td></tr>`;
  }).join('') : '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">Sin viajes con promoción en este periodo.</td></tr>';

  const grupos = [
    ['1 viaje', (f) => f.viajes === 1], ['2 a 5', (f) => f.viajes >= 2 && f.viajes <= 5],
    ['6 a 15', (f) => f.viajes >= 6 && f.viajes <= 15], ['16 o más', (f) => f.viajes > 15],
  ].map(([rango, fn]) => ({ rango, n: filasClientes.filter(fn).length }));
  const maxG = Math.max(1, ...grupos.map((g) => g.n));
  $('cli-grupos').innerHTML = grupos.map((g) => `<span>${g.rango}</span>
    <div class="p"><div style="width:${g.n / maxG * 100}%;background:#2F6FB2;"></div></div><b class="der">${g.n}</b>`).join('');
  pintarTablaClientes();
}

function pintarTablaClientes() {
  const q = $('cli-buscar').value.trim().toLowerCase();
  const filtro = $('cli-filtro').value;
  let fs = filasClientes.filter((f) => !q || f.nombre.toLowerCase().includes(q) || f.tel.includes(q));
  if (filtro === 'nuevos') fs = fs.filter((f) => f.nuevo);
  if (filtro === 'promo') fs = fs.filter((f) => f.promos.length);
  if (filtro === 'noregresaron') fs = fs.filter((f) => f.nuevo && !f.regreso);
  fs.sort((x, y) => y.viajes - x.viajes);
  $('cli-tbody').innerHTML = fs.length ? fs.slice(0, 300).map((f) => `<tr>
      <td><div style="font-weight:600;">${esc(f.nombre)}${f.nuevo ? ' <span class="fz-chip" style="background:#EAF3DE;color:#27500A;">Nuevo</span>' : ''}</div><div class="fz-muted">${esc(f.tel)}</div></td>
      <td class="der">${num(f.viajes)}</td>
      <td>${f.promos.length ? esc(f.promos.join(', ')) : '—'}</td>
      <td class="der">${f.descuento ? pesos(f.descuento) : '—'}</td>
      <td class="der" style="font-weight:600;">${pesos(f.gasto)}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:#999;padding:24px;">Sin clientes con ese filtro.</td></tr>';
}

// ===== PINTAR: LIMITES (pestaña) =====
function pintarTablaLimites(limites) {
  $('lim-tbody').innerHTML = limites.map((l) => {
    const usoTxt = l.pct != null ? `${Math.round(l.pct)}%` : pesos(l.costoMes);
    const [, bg, fg] = colorPct(l.pct ?? (l.alerta.tope ? l.costoMes / l.alerta.tope * 100 : 0));
    return `<tr>
      <td><div style="font-weight:600;">${esc(l.s.nombre)} <span class="fz-muted">· ${GRUPOS[l.s.grupo]}</span></div><div class="fz-muted">${esc(l.s.quien)}</div></td>
      <td class="fz-muted" style="white-space:nowrap;">${l.gratis > 0 ? `${num(l.gratis)} ${l.s.periodo === 'dia' ? 'al día' : 'al mes'}` : 'Sin gratis'}</td>
      <td><span class="fz-chip" style="background:${bg};color:${fg};">${usoTxt}</span></td>
      <td style="white-space:nowrap;"><input type="number" min="1" max="100" class="fz-input" style="width:64px;" data-lim-pct="${l.s.id}" value="${l.alerta.pct}" aria-label="Porcentaje de aviso de ${esc(l.s.nombre)}"> %</td>
      <td style="white-space:nowrap;">$ <input type="number" min="0" class="fz-input" style="width:84px;" data-lim-tope="${l.s.id}" value="${l.alerta.tope ?? ''}" placeholder="Sin tope" aria-label="Tope del mes de ${esc(l.s.nombre)}"></td>
      <td class="der">${pesos(l.costoMes)}</td>
    </tr>`;
  }).join('');
  $('inp-presupuesto').value = cfg.presupuestoDiario;
}

// ===== DETALLE DE UN SERVICIO =====
function abrirDetalle(id) {
  const s = SERVICIOS.find((x) => x.id === id);
  if (!s) return;
  const l = estadoLimites().find((x) => x.s.id === id);
  const hoy = new Date();
  const mesK = clave(hoy).slice(0, 7);
  const total = diasDelMes(hoy);
  const barras = [];
  for (let d = 1; d <= total; d++) {
    const k = `${mesK}-${String(d).padStart(2, '0')}`;
    const real = porDiaReal.get(k);
    if (s.periodo === 'mes') {
      const v = real ? real.mesAcum[id] : l.usoMes + l.promedio * (d - hoy.getDate());
      barras.push({ v, etiqueta: `${d} ${MESES[hoy.getMonth()]}`, tip: `${d} ${MESES[hoy.getMonth()]}: ${num(v)}${real ? '' : ' (proyección)'}`, color: real ? '#2F6FB2' : '#c7d7ea' });
    } else {
      const v = real ? real.uso[id] : l.promedio;
      barras.push({ v, etiqueta: `${d} ${MESES[hoy.getMonth()]}`, tip: `${d} ${MESES[hoy.getMonth()]}: ${num(v)}${real ? '' : ' (proyección)'}`, color: real ? (v > l.gratis ? '#C9852B' : '#2F6FB2') : '#c7d7ea' });
    }
  }
  $('detalle-titulo').textContent = `${s.nombre} · ${GRUPOS[s.grupo]}`;
  $('detalle-sub').textContent = `${s.quien}. ${l.gratis > 0 ? `Gratis: ${num(l.gratis)} ${s.periodo === 'dia' ? 'al día' : 'al mes'}.` : 'No tiene parte gratis.'} Precio: ${pesos(unitario(s) * (s.cada >= 1000 ? 1000 : 1))} por ${s.cada >= 1000 ? 'cada 1,000' : 'cada uno'}.`;
  dibujarBarras('det', barras, l.gratis, num);
  $('det-nota').textContent = s.periodo === 'mes'
    ? `${s.id === 'sms' ? 'Mensajes' : 'Llamadas'} acumuladas en el mes. Al cierre llegarías a ~${num(l.usoMes + l.promedio * (total - hoy.getDate()))}; pagarías ~${pesos(l.costoCierre)}.`
    : `Uso de cada día; lo gratis se reinicia diario. Llevas ${pesos(l.costoMes)} este mes; al cierre ~${pesos(l.costoCierre)}.`;
  const diasMes = [...porDiaReal.keys()].filter((k) => k.startsWith(mesK));
  const suma = (campo) => diasMes.reduce((a, k) => a + porDiaReal.get(k).fuentes[campo], 0);
  let fuentes = [];
  if (id === 'rutas') fuentes = [['Alerta del conductor (incluye las rechazadas)', suma('rutasAlerta')], ['Cotizar (app del pasajero)', suma('rutasCotizar')], ['Ir por el pasajero', suma('rutasIr')]];
  if (id === 'escrituras') fuentes = [['GPS de taxistas', suma('escriturasGps')], ['Viajes', suma('escriturasViajes')]];
  const totalF = fuentes.reduce((a, f) => a + f[1], 0) || 1;
  $('det-fuentes').innerHTML = fuentes.length
    ? '<h3 style="margin:4px 0 0;font-size:14px;">De dónde sale este mes</h3>' + fuentes.map(([n, v]) => `<div class="fz-par"><span>${esc(n)}</span><span><b>${num(v)}</b> <span class="fz-muted">(${Math.round(v / totalF * 100)}%)</span></span></div>`).join('')
    : `<p class="fz-muted" style="margin:0;">Se estima con "${esc(USO_DEF[USO_DE_SERVICIO[id]]?.etiqueta || 'uso por viaje')}" en Precios y gastos fijos.</p>`;
  abrirModal('modal-detalle');
}

// ===== VENTANA DE PRECIOS =====
let fijosEdit = [];
function abrirPrecios() {
  if (!puede('editar')) return;
  $('inp-tc').value = cfg.tipoCambio;
  $('precios-tbody').innerHTML = SERVICIOS.map((s) => `<tr>
    <td style="font-weight:600;">${esc(s.nombre)} <span class="fz-muted">· ${GRUPOS[s.grupo]}</span></td>
    <td><input type="number" step="0.01" min="0" class="fz-input" data-precio="${s.id}" value="${cfg.precios[s.id].precio}" aria-label="Precio de ${esc(s.nombre)}"></td>
    <td class="fz-muted" style="white-space:nowrap;">${s.cada === 1 ? '1 mensaje' : num(s.cada)}</td>
    <td style="white-space:nowrap;"><input type="number" min="0" class="fz-input" data-gratis="${s.id}" value="${cfg.precios[s.id].gratis}" aria-label="Gratis de ${esc(s.nombre)}"> <span class="fz-muted">${s.periodo === 'dia' ? 'al día' : 'al mes'}</span></td>
    <td></td></tr>`).join('');
  $('uso-campos').innerHTML = Object.entries(USO_DEF).map(([k, u]) => `<div class="fz-campo">
    <label for="uso-${k}">${esc(u.etiqueta)}</label>
    <input id="uso-${k}" type="number" step="0.1" min="0" class="fz-input" data-uso="${k}" value="${cfg.uso[k]}"></div>`).join('');
  fijosEdit = cfg.fijos.map((f) => ({ ...f }));
  pintarFijos();
  $('precios-aviso').style.display = 'none';
  abrirModal('modal-precios');
}
function pintarFijos() {
  $('fijos-lista').innerHTML = fijosEdit.length ? fijosEdit.map((f, i) => `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <input type="text" class="fz-input" style="flex:1 1 220px;" data-fijo-nombre="${i}" value="${esc(f.nombre)}" placeholder="Concepto (ej. Contador)" aria-label="Concepto">
      <span>$</span><input type="number" min="0" class="fz-input" style="width:100px;" data-fijo-monto="${i}" value="${f.monto}" aria-label="Monto">
      <select class="fz-select" data-fijo-cada="${i}" aria-label="Cada cuánto">
        <option value="mensual"${f.cada === 'mensual' ? ' selected' : ''}>Mensual</option>
        <option value="anual"${f.cada === 'anual' ? ' selected' : ''}>Anual</option>
        <option value="unaVez"${f.cada === 'unaVez' ? ' selected' : ''}>Una vez</option>
      </select>
      <input type="date" class="fz-input${f.cada === 'unaVez' ? '' : ' fz-oculto'}" data-fijo-fecha="${i}" value="${esc(f.fecha)}" aria-label="Fecha del pago">
      <button type="button" class="btn btn-danger btn-sm" data-fijo-quitar="${i}">Quitar</button>
    </div>`).join('') : '<p class="fz-muted" style="margin:0;">Sin gastos fijos. Agrega el contador, dominio, cuenta de Apple, etc.</p>';
}
function leerFijos() {
  document.querySelectorAll('[data-fijo-nombre]').forEach((el) => { fijosEdit[el.dataset.fijoNombre].nombre = el.value.trim(); });
  document.querySelectorAll('[data-fijo-monto]').forEach((el) => { fijosEdit[el.dataset.fijoMonto].monto = Number(el.value) || 0; });
  document.querySelectorAll('[data-fijo-cada]').forEach((el) => { fijosEdit[el.dataset.fijoCada].cada = el.value; });
  document.querySelectorAll('[data-fijo-fecha]').forEach((el) => { fijosEdit[el.dataset.fijoFecha].fecha = el.value; });
}

async function guardarCfg(nuevo, avisoId, okTxt) {
  try {
    await setDoc(doc(db, 'configuracion', 'finanzas'), nuevo);
    cfg = normalizarCfg(nuevo);
    porDiaReal = calcularPorDia();
    porDia = porDiaReal;
    pintar();
    if (avisoId) mensaje(avisoId, okTxt, true);
    return true;
  } catch (e) {
    if (avisoId) mensaje(avisoId, 'No se pudo guardar: ' + e.message, false);
    return false;
  }
}
function mensaje(id, texto, ok) {
  const el = $(id);
  el.textContent = texto;
  el.style.cssText = `display:block;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:600;background:${ok ? 'var(--badge-active-bg)' : 'var(--badge-suspended-bg)'};color:${ok ? 'var(--badge-active-text)' : 'var(--badge-suspended-text)'};`;
}

function abrirModal(id) { $(id).classList.remove('fz-oculto'); }
function cerrarModal(id) { $(id).classList.add('fz-oculto'); }

// ===== CSV =====
function exportarCsv() {
  const r = rangoDe(modo, deClave($('inp-fecha').value || clave(new Date())));
  const a = resumen(r, $('sel-ciudad').value, !!sim);
  const fac = a.simulado ? sim.factor : 1;
  const filas = [['Fecha', 'Viajes', ...SERVICIOS.map((s) => `Uso ${s.nombre}`), ...SERVICIOS.map((s) => `Costo ${s.nombre}`), 'Gastos fijos', 'Total gasto']];
  for (const k of a.dias) {
    const d = porDia.get(k);
    if (!d) continue;
    const costos = SERVICIOS.map((s) => d.costo[s.id] * a.parte);
    const fijo = fijoDelDia(k);
    filas.push([k, Math.round(a.viajesRango.filter((v) => clave(v.fecha) === k).length * fac), ...SERVICIOS.map((s) => Math.round(d.uso[s.id])),
      ...costos.map((c) => c.toFixed(2)), fijo.toFixed(2), (costos.reduce((x, y) => x + y, 0) + fijo).toFixed(2)]);
  }
  const csv = '﻿' + filas.map((f) => f.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const enlace = Object.assign(document.createElement('a'), { href: url, download: `finanzas_${clave(r.inicio)}_${modo}.csv` });
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ===== ORQUESTA =====
function pintar() {
  if (!cargadoDesde) return;
  const ref = deClave($('inp-fecha').value || clave(new Date()));
  const r = rangoDe(modo, ref);
  const ciudad = $('sel-ciudad').value;
  porDia = porDiaReal;
  const aReal = resumen(r, ciudad);
  sim = null;
  if ($('chk-sim').checked && simTaxistas > 0) {
    // Ritmo real: viajes por cada taxista que trabajo en el periodo.
    const base = new Set(aReal.finalizados.map((v) => v.taxistaId).filter(Boolean)).size;
    sim = { n: simTaxistas, base, factor: base ? simTaxistas / base : 0 };
    porDia = calcularPorDia(sim.factor);
  }
  const a = sim ? resumen(r, ciudad, true) : aReal;
  pintarAvisoSim();
  // Periodo en curso: se compara contra los MISMOS dias del anterior (24 dias
  // de este mes contra los primeros 24 del pasado), no contra el mes completo.
  let rp = rangoAnterior(modo, r);
  const manana = sumarDias(inicioDia(new Date()), 1);
  if (r.inicio < manana && r.fin > manana) {
    rp = { inicio: rp.inicio, fin: new Date(Math.min(rp.fin.getTime(), sumarDias(rp.inicio, Math.round((manana - r.inicio) / DIA)).getTime())) };
  }
  const b = $('chk-comparar').checked && !sim ? resumen(rp, ciudad) : null;
  const ultimo = sumarDias(r.fin, -1);
  $('txt-rango').textContent = modo === 'dia' ? '' : `${fechaCorta(r.inicio)} – ${fechaCorta(ultimo)} ${ultimo.getFullYear()}`;
  const limites = estadoLimites();
  pintarAvisos(avisosActivos(limites));
  // La proyeccion sigue el modo de la vista; avisos y limites, siempre lo real.
  const limitesVista = sim ? estadoLimites(porDia) : limites;
  pintarKpis(a, b);
  pintarCascada(a);
  pintarProyeccion(a, limitesVista);
  pintarPromos(a);
  pintarGrafica(a);
  pintarLimites(limites);
  pintarUnitarios(a);
  pintarSimulador();
  pintarTaxistas(aReal);
  pintarClientes(aReal);
  pintarTablaLimites(limites);
}

// Cuanto hay que tener cargado para el periodo elegido (y el anterior, y
// el mes en curso, que es de donde salen los avisos).
async function asegurarDatos() {
  const ref = deClave($('inp-fecha').value || clave(new Date()));
  const r = rangoDe(modo, ref);
  const desde = [inicioMes(r.inicio), inicioMes(new Date())];
  if ($('chk-comparar').checked) desde.push(inicioMes(rangoAnterior(modo, r).inicio));
  const necesario = new Date(Math.min(...desde.map((d) => d.getTime())));
  if (cargadoDesde && cargadoDesde <= necesario) return;
  $('estado-carga').classList.remove('fz-oculto');
  $('estado-carga').textContent = 'Cargando datos...';
  await cargarTodo(necesario);
  porDiaReal = calcularPorDia();
  porDia = porDiaReal;
  $('estado-carga').classList.add('fz-oculto');
}

async function actualizar() {
  try {
    await asegurarDatos();
    pintar();
    mostrarTab(tab);
  } catch (e) {
    $('estado-carga').classList.remove('fz-oculto');
    $('estado-carga').textContent = 'No se pudieron cargar los datos: ' + e.message;
  }
}

function mostrarTab(t) {
  tab = t;
  document.querySelectorAll('.fz-tab').forEach((b) => {
    b.classList.toggle('sel', b.dataset.tab === t);
    b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false');
  });
  if (!cargadoDesde) return;
  for (const v of ['resumen', 'taxistas', 'clientes', 'limites']) $(`vista-${v}`).classList.toggle('fz-oculto', v !== t);
}

// ===== EVENTOS =====
document.querySelectorAll('.fz-tab').forEach((b) => b.addEventListener('click', () => mostrarTab(b.dataset.tab)));
document.querySelectorAll('#seg-modo button').forEach((b) => b.addEventListener('click', () => {
  modo = b.dataset.modo;
  document.querySelectorAll('#seg-modo button').forEach((x) => x.classList.toggle('sel', x === b));
  actualizar();
}));
$('inp-fecha').addEventListener('change', actualizar);
$('sel-ciudad').addEventListener('change', pintar);
$('chk-comparar').addEventListener('change', actualizar);
$('chk-sim').addEventListener('change', pintar);
['sim-tax', 'sim-cli', 'sim-via', 'sim-mem'].forEach((id) => $(id).addEventListener('input', pintarSimulador));
['tax-buscar', 'tax-filtro', 'tax-orden'].forEach((id) => $(id).addEventListener('input', pintarTablaTaxistas));
['cli-buscar', 'cli-filtro'].forEach((id) => $(id).addEventListener('input', pintarTablaClientes));
document.addEventListener('click', (e) => {
  const det = e.target.closest('[data-detalle]');
  if (det) return abrirDetalle(det.dataset.detalle);
  const cerrar = e.target.closest('[data-cerrar]');
  if (cerrar) return cerrarModal(cerrar.dataset.cerrar);
  if (e.target.classList?.contains('fz-modal')) return cerrarModal(e.target.id);
  const quitar = e.target.closest('[data-fijo-quitar]');
  if (quitar) { leerFijos(); fijosEdit.splice(Number(quitar.dataset.fijoQuitar), 1); pintarFijos(); }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-fijo-cada]')) { leerFijos(); pintarFijos(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ['modal-precios', 'modal-detalle'].forEach(cerrarModal);
});
$('btn-precios').addEventListener('click', abrirPrecios);
$('btn-csv').addEventListener('click', exportarCsv);
$('btn-agregar-fijo').addEventListener('click', () => {
  leerFijos();
  fijosEdit.push({ nombre: '', monto: 0, cada: 'mensual', fecha: clave(new Date()) });
  pintarFijos();
});
$('btn-restablecer').addEventListener('click', () => {
  const def = cfgPorDefecto();
  SERVICIOS.forEach((s) => {
    document.querySelector(`[data-precio="${s.id}"]`).value = def.precios[s.id].precio;
    document.querySelector(`[data-gratis="${s.id}"]`).value = def.precios[s.id].gratis;
  });
});
$('btn-guardar-precios').addEventListener('click', async (e) => {
  if (!puede('editar')) return;
  leerFijos();
  const nuevo = JSON.parse(JSON.stringify(cfg));
  nuevo.tipoCambio = Number($('inp-tc').value) || cfg.tipoCambio;
  SERVICIOS.forEach((s) => {
    nuevo.precios[s.id] = {
      precio: Number(document.querySelector(`[data-precio="${s.id}"]`).value) || 0,
      gratis: Number(document.querySelector(`[data-gratis="${s.id}"]`).value) || 0,
    };
  });
  document.querySelectorAll('[data-uso]').forEach((el) => { nuevo.uso[el.dataset.uso] = Number(el.value) || 0; });
  nuevo.fijos = fijosEdit.filter((f) => f.nombre).map((f) => ({ nombre: f.nombre, monto: f.monto, cada: f.cada, fecha: f.cada === 'unaVez' ? f.fecha : '' }));
  e.currentTarget.disabled = true;
  const ok = await guardarCfg(nuevo, 'precios-aviso', 'Precios guardados.');
  e.currentTarget.disabled = false;
  if (ok) setTimeout(() => cerrarModal('modal-precios'), 600);
});
$('btn-guardar-limites').addEventListener('click', async (e) => {
  if (!puede('editar')) return;
  const nuevo = JSON.parse(JSON.stringify(cfg));
  document.querySelectorAll('[data-lim-pct]').forEach((el) => {
    nuevo.alertas[el.dataset.limPct].pct = Math.min(100, Math.max(1, Number(el.value) || 80));
  });
  document.querySelectorAll('[data-lim-tope]').forEach((el) => {
    nuevo.alertas[el.dataset.limTope].tope = el.value === '' ? null : Math.max(0, Number(el.value) || 0);
  });
  nuevo.presupuestoDiario = Math.max(0, Number($('inp-presupuesto').value) || 0);
  e.currentTarget.disabled = true;
  await guardarCfg(nuevo, 'lim-guardado', 'Límites guardados.');
  e.currentTarget.disabled = false;
});

// ===== ARRANQUE =====
$('inp-fecha').value = clave(new Date());
const fechaEl = $('fecha-actual');
if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

Promise.all([
  getDoc(doc(db, 'configuracion', 'finanzas')).catch(() => null),
  getDoc(doc(db, 'configuracion', 'suscripcion')).catch(() => null),
  getDoc(doc(db, 'configuracion', 'ciudades')).catch(() => null),
]).then(([f, s, c]) => {
  cfg = normalizarCfg(f?.exists() ? f.data() : null);
  const sus = s?.exists() ? s.data() : {};
  costoMembresia = Number(sus.costo) || 0;
  periodoMembresia = sus.periodo === 'semanal' ? 'semanal' : 'mensual';
  simTaxistas = Math.max(0, Math.round(Number(sus.cotizacion?.taxistas) || 0));
  $('chk-sim').checked = simTaxistas > 0 && sus.cotizacion?.activa === true;
  $('sim-mem').value = costoMembresia || 150;
  if (simTaxistas > 0) $('sim-tax').value = simTaxistas;
  ciudades = (c?.exists() ? (c.data().lista || []) : []).filter((x) => x && x.id);
  $('sel-ciudad').innerHTML = '<option value="">Todas</option>' +
    ciudades.map((x) => `<option value="${esc(x.id)}">${esc(x.nombre || x.id)}</option>`).join('');
  actualizar();
});
