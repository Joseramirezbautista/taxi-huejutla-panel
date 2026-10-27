// ===== PERMISOS.JS =====
// Script plano (no ES module) para poder incluirse igual en páginas que usan
// el SDK modular y en las que usan el SDK compat. Solo lee la sesión guardada
// en localStorage por auth.js — no depende de Firebase.
(function () {
  const SESSION_KEY = 'taxi_admin_session';

  const SECCIONES = [
    { id: 'dashboard',    label: 'Dashboard' },
    { id: 'taxistas',     label: 'Taxistas' },
    { id: 'clientes',     label: 'Clientes' },
    { id: 'viajes',       label: 'Viajes' },
    { id: 'reportes',     label: 'Reportes' },
    { id: 'zonas',        label: 'Zonas' },
    { id: 'promociones',  label: 'Promociones' },
    { id: 'cotizador',    label: 'Cotizador y pruebas' },
    { id: 'finanzas',     label: 'Finanzas' },
    { id: 'puntos',       label: 'Puntos de taxistas' },
    { id: 'tarifas',       label: 'Tarifas' },
    { id: 'suscripciones', label: 'Suscripciones' },
    { id: 'roles',        label: 'Roles' },
    { id: 'basededatos',  label: 'Base de datos' },
    { id: 'distribucion', label: 'Distribución APK' },
    { id: 'privacidad',   label: 'Privacidad' },
    { id: 'pruebas',      label: 'Pruebas' },
  ];
  const ACCIONES = [
    { id: 'ver',      label: 'Ver' },
    { id: 'crear',    label: 'Crear' },
    { id: 'editar',   label: 'Editar' },
    { id: 'eliminar', label: 'Eliminar' },
  ];

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  }

  // Admin "completo" (sin permisos personalizados) puede todo. Los admins con
  // rol 'personalizado' solo tienen lo que diga su objeto `permisos`.
  function esFullAdmin() {
    const s = getSession();
    return !!s && s.rol !== 'personalizado';
  }

  function puede(seccion, accion) {
    if (esFullAdmin()) return true;
    const s = getSession();
    const permitidas = s?.permisos?.[seccion];
    return Array.isArray(permitidas) && permitidas.includes(accion);
  }

  function verSeccion(seccion) {
    return puede(seccion, 'ver');
  }

  // Oculta del menú lateral los <a class="nav-item" data-seccion="x"> que el
  // usuario actual no puede ver, y los encabezados de grupo ("Gestión",
  // "Administrador"...) que se quedan sin ningún ítem visible debajo.
  function aplicarVisibilidadMenu() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    document.querySelectorAll('.nav-item[data-seccion]').forEach((el) => {
      if (!verSeccion(el.dataset.seccion)) el.style.display = 'none';
    });
    nav.querySelectorAll('.nav-label').forEach((label) => {
      let sibling = label.nextElementSibling;
      let algunoVisible = false;
      while (sibling && !sibling.classList.contains('nav-label')) {
        if (sibling.style.display !== 'none') { algunoVisible = true; break; }
        sibling = sibling.nextElementSibling;
      }
      label.style.display = algunoVisible ? '' : 'none';
    });
  }

  // Oculta cualquier elemento que coincida con el selector si el usuario no
  // tiene el permiso indicado. Útil para botones de crear/editar/eliminar.
  function ocultarSiNoPuede(selector, seccion, accion) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!puede(seccion, accion)) el.style.display = 'none';
    });
  }

  // Bloquea toda la página si el usuario no tiene el permiso indicado
  // (por defecto "ver"). Debe llamarse lo antes posible en cada página.
  function protegerPagina(seccion, accion) {
    if (puede(seccion, accion || 'ver')) return true;
    document.documentElement.innerHTML =
      '<head><meta charset="UTF-8"><title>Sin acceso</title></head>' +
      '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
      'height:100vh;font-family:Inter,Arial,sans-serif;color:#888;text-align:center;' +
      'padding:24px;background:#f7f7fb;">' +
      '<div><div style="font-size:44px;">🔒</div>' +
      '<p style="margin-top:14px;font-size:14px;">No tienes permiso para ver esta sección.</p>' +
      '<a href="dashboard.html" style="color:#3B6D11;font-weight:600;text-decoration:none;">← Volver al inicio</a>' +
      '</div></body>';
    return false;
  }

  window.Permisos = {
    SECCIONES, ACCIONES,
    esFullAdmin, puede, verSeccion,
    aplicarVisibilidadMenu, ocultarSiNoPuede, protegerPagina,
  };
})();
