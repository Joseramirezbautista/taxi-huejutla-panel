// ===== REPORTES.JS =====
if (!localStorage.getItem('taxi_admin_session')) {
  window.location.href = 'login.html';
}

const db = firebase.firestore();

let todosLosViajes = [];
let periodoActivo  = 'semana';
let chartIngresos  = null;
let chartHoras     = null;

// ===== FORMATO MONEDA =====
function fmtMXN(n) {
  return '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ===== FILTRAR POR PERÍODO =====
function filtrarPorPeriodo(viajes, periodo) {
  const ahora = new Date();
  return viajes.filter(v => {
    const fecha = v.fechaSolicitud?.toDate?.() ?? null;
    if (!fecha) return false;
    switch (periodo) {
      case 'hoy': {
        const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
        return fecha >= inicio;
      }
      case 'semana': {
        const inicio = new Date(ahora);
        inicio.setDate(ahora.getDate() - ahora.getDay());
        inicio.setHours(0, 0, 0, 0);
        return fecha >= inicio;
      }
      case 'mes':
        return fecha.getMonth() === ahora.getMonth() &&
               fecha.getFullYear() === ahora.getFullYear();
      case 'anio':
        return fecha.getFullYear() === ahora.getFullYear();
      default:
        return true;
    }
  });
}

// ===== KPIs =====
function renderKPIs(viajes) {
  const total    = viajes.reduce((s, v) => s + (v.tarifa || 0), 0);
  const promedio = viajes.length ? total / viajes.length : 0;

  const porHora = new Array(24).fill(0);
  viajes.forEach(v => {
    const h = v.fechaSolicitud?.toDate?.()?.getHours();
    if (typeof h === 'number') porHora[h]++;
  });
  const horaPico = porHora.indexOf(Math.max(...porHora));
  const horaPicoText = viajes.length ? `${horaPico}:00 – ${horaPico + 1}:00` : '—';

  document.getElementById('kpi-ingresos').textContent    = fmtMXN(total);
  document.getElementById('kpi-viajes').textContent      = viajes.length;
  document.getElementById('kpi-promedio').textContent    = fmtMXN(promedio);
  document.getElementById('kpi-hora-pico').textContent   = horaPicoText;
  document.getElementById('kpi-ingresos-badge').textContent = fmtMXN(total);
}

// ===== DATOS GRÁFICA INGRESOS =====
function getIngresosData(viajes, periodo) {
  const ahora = new Date();

  if (periodo === 'hoy') {
    const labels = Array.from({ length: 24 }, (_, i) => `${i}h`);
    const data   = new Array(24).fill(0);
    viajes.forEach(v => {
      const h = v.fechaSolicitud?.toDate?.()?.getHours();
      if (typeof h === 'number') data[h] += v.tarifa || 0;
    });
    return { labels, data };
  }

  if (periodo === 'semana') {
    const dias  = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const data  = new Array(7).fill(0);
    viajes.forEach(v => {
      const d = v.fechaSolicitud?.toDate?.()?.getDay();
      if (typeof d === 'number') data[d] += v.tarifa || 0;
    });
    return { labels: dias, data };
  }

  if (periodo === 'mes') {
    const diasEnMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate();
    const labels    = Array.from({ length: diasEnMes }, (_, i) => `${i + 1}`);
    const data      = new Array(diasEnMes).fill(0);
    viajes.forEach(v => {
      const d = v.fechaSolicitud?.toDate?.()?.getDate();
      if (typeof d === 'number') data[d - 1] += v.tarifa || 0;
    });
    return { labels, data };
  }

  if (periodo === 'anio') {
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const data  = new Array(12).fill(0);
    viajes.forEach(v => {
      const m = v.fechaSolicitud?.toDate?.()?.getMonth();
      if (typeof m === 'number') data[m] += v.tarifa || 0;
    });
    return { labels: meses, data };
  }

  // Histórico → últimos 12 meses
  const labels = [];
  const data   = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    labels.push(d.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' }));
    data.push(0);
  }
  viajes.forEach(v => {
    const fecha = v.fechaSolicitud?.toDate?.();
    if (!fecha) return;
    for (let i = 0; i < 12; i++) {
      const ref = new Date(ahora.getFullYear(), ahora.getMonth() - (11 - i), 1);
      if (fecha.getMonth() === ref.getMonth() && fecha.getFullYear() === ref.getFullYear()) {
        data[i] += v.tarifa || 0;
        break;
      }
    }
  });
  return { labels, data };
}

// ===== DATOS GRÁFICA HORAS =====
function getHorasData(viajes) {
  const data = new Array(24).fill(0);
  viajes.forEach(v => {
    const h = v.fechaSolicitud?.toDate?.()?.getHours();
    if (typeof h === 'number') data[h]++;
  });
  return {
    labels: Array.from({ length: 24 }, (_, i) => `${i}h`),
    data
  };
}

// ===== TÍTULOS POR PERÍODO =====
const periodoLabels = {
  hoy:    'Hoy',
  semana: 'Esta semana',
  mes:    'Este mes',
  anio:   'Este año',
  todo:   'Histórico (12 meses)',
};

// ===== ACTUALIZAR TODO =====
function actualizar() {
  const viajes = filtrarPorPeriodo(todosLosViajes, periodoActivo);

  renderKPIs(viajes);

  document.getElementById('chart-ingresos-titulo').textContent =
    `Ingresos — ${periodoLabels[periodoActivo]}`;

  const { labels, data } = getIngresosData(viajes, periodoActivo);
  chartIngresos.data.labels            = labels;
  chartIngresos.data.datasets[0].data  = data;
  chartIngresos.update();

  // Horas: en "todo" usa todos los viajes; en otros, solo el período
  const viajesHoras = periodoActivo === 'todo' ? todosLosViajes : viajes;
  const horas = getHorasData(viajesHoras);
  chartHoras.data.datasets[0].data = horas.data;
  chartHoras.update();

  document.getElementById('chart-horas-badge').textContent =
    `${viajesHoras.length} viaje${viajesHoras.length !== 1 ? 's' : ''}`;
}

// ===== INICIALIZAR GRÁFICAS =====
function initCharts() {
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size   = 12;

  chartIngresos = new Chart(
    document.getElementById('chart-ingresos').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Ingresos',
          data: [],
          backgroundColor: 'rgba(59, 109, 17, 0.75)',
          borderColor: '#3B6D11',
          borderWidth: 0,
          borderRadius: 5,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + fmtMXN(ctx.parsed.y)
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#aaa' }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: {
              color: '#aaa',
              callback: val => '$' + val.toLocaleString('es-MX')
            }
          }
        }
      }
    }
  );

  chartHoras = new Chart(
    document.getElementById('chart-horas').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${i}h`),
        datasets: [{
          label: 'Viajes',
          data: new Array(24).fill(0),
          backgroundColor: 'rgba(55, 138, 221, 0.7)',
          borderColor: '#378ADD',
          borderWidth: 0,
          borderRadius: 4,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.parsed.y} viaje${ctx.parsed.y !== 1 ? 's' : ''}`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#aaa' }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#aaa', stepSize: 1 },
            grid: { color: 'rgba(0,0,0,0.04)' }
          }
        }
      }
    }
  );
}

// ===== FILTROS UI =====
document.querySelectorAll('#periodo-btns .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#periodo-btns .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    periodoActivo = btn.dataset.periodo;
    actualizar();
  });
});

// ===== LOGOUT =====
document.getElementById('btn-logout')?.addEventListener('click', () => {
  localStorage.removeItem('taxi_admin_session');
  firebase.auth().signOut().finally(function() { window.location.href = 'login.html'; });
});

// ===== FECHA TOPBAR =====
const fechaEl = document.getElementById('fecha-actual');
if (fechaEl) {
  fechaEl.textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ===== ARRANQUE =====
initCharts();

firebase.auth().onAuthStateChanged(function(user) {
  if (!user) { window.location.href = 'login.html'; return; }
  db.collection('viajes')
    .where('estado', '==', 'finalizado')
    .get()
    .then(snap => {
      todosLosViajes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      actualizar();
    })
    .catch(err => console.error('Error cargando reportes:', err));
});
