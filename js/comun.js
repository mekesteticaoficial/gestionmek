// Lo que comparten todas las pantallas: conexión, sesión, menú y utilidades.
(function () {
  'use strict';
  const CFG = window.MEK_CONFIG;

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mek.auth' },
  });

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('mek.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mek.' + k, JSON.stringify(v)); } catch (e) { /* lleno o bloqueado */ } },
    del(k) { try { localStorage.removeItem('mek.' + k); } catch (e) { /* nada */ } },
  };

  const MEDIOS = [
    ['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['debito', 'Débito'],
    ['credito', 'Crédito'], ['mercadopago', 'Mercado Pago'],
  ];
  const nombreMedio = (m) => (MEDIOS.find((x) => x[0] === m) || [m, m || '—'])[1];

  const hoy = () => new Date().toLocaleDateString('en-CA');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function plata(n) {
    if (n === null || n === undefined || n === '') return '—';
    const v = Number(n);
    return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  }
  function fechaCorta(f) {
    if (!f) return '—';
    const [y, m, d] = String(f).slice(0, 10).split('-');
    return d + '/' + m + '/' + y;
  }
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  // Número escrito por una persona. Los campos numéricos del navegador
  // dan "1234.5"; si alguien escribe "1.234,5" (con coma), también vale.
  const numero = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    let s = String(v).trim();
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // Pantallas. 'admin' = solo Franco.
  const PAGINAS = [
    { id: 'cobro', href: 'index.html', nombre: 'Cobro' },
    { id: 'deudores', href: 'deudores.html', nombre: 'Deudores' },
    { id: 'gastos', href: 'gastos.html', nombre: 'Gastos' },
    { id: 'liquidaciones', href: 'liquidaciones.html', nombre: 'Liquidaciones', admin: true },
    { id: 'panel', href: 'panel.html', nombre: 'Panel', admin: true },
    { id: 'acreedores', href: 'acreedores.html', nombre: 'Acreedores', admin: true },
    { id: 'compras', href: 'compras.html', nombre: 'Compras', admin: true },
    { id: 'catalogo', href: 'catalogo.html', nombre: 'Precios', admin: true },
  ];

  function nav(actual, usuario) {
    const el = document.getElementById('nav');
    if (!el) return;
    const esAdmin = usuario && usuario.rol === 'admin';
    el.innerHTML = PAGINAS.filter((p) => !p.admin || esAdmin).map((p) =>
      '<a href="' + p.href + '"' + (p.id === actual ? ' class="activo" aria-current="page"' : '') + '>' + p.nombre + '</a>').join('');
    el.hidden = false;
  }

  async function usuarioActual() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb.from('usuarios').select('nombre,rol,profesional_id').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  // Para las pantallas que no son la de cobro: si no hay sesión, al
  // cobro (que tiene el login). Si piden admin y no lo es, avisa.
  async function requerirSesion(pagina, opciones) {
    const op = opciones || {};
    let usuario = LS.get('usuario', null);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.href = 'index.html'; return null; }
    const verificar = async () => {
      const u = await usuarioActual();
      if (u) LS.set('usuario', u); else LS.del('usuario');
      return u;
    };
    if (usuario) {
      // Con el usuario guardado se abre enseguida; se confirma por detrás.
      // Si le sacaron el permiso, en la próxima carga vuelve al login.
      if (navigator.onLine) verificar().then((u) => { if (!u || u.rol !== usuario.rol) location.reload(); }).catch(() => {});
    } else if (navigator.onLine) {
      try { usuario = await verificar(); } catch (e) { /* sin red */ }
    }
    if (!usuario) { location.href = 'index.html'; return null; }
    nav(pagina, usuario);
    const nombre = document.getElementById('usuarioNombre');
    if (nombre) nombre.textContent = usuario.nombre;
    if (op.admin && usuario.rol !== 'admin') {
      document.querySelector('main').innerHTML = '<section class="card"><h2>Esta pantalla es solo para Franco</h2>' +
        '<p><a href="index.html">Volver al cobro</a></p></section>';
      return null;
    }
    return usuario;
  }

  let toastTimer = null;
  function toast(texto, tipo, ms, boton) {
    const t = document.getElementById('toast');
    if (!t) { alert(texto); return; }
    t.className = 'toast ' + (tipo || '');
    t.innerHTML = '<span>' + esc(texto) + '</span>' + (boton ? '<button type="button" id="toastBtn">' + esc(boton.texto) + '</button>' : '');
    t.hidden = false;
    if (boton) document.getElementById('toastBtn').onclick = () => { t.hidden = true; boton.accion(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (tipo === 'error' ? 7000 : 3500));
  }

  // Mensaje legible de un error de la base o de la red.
  function mensaje(e) {
    if (!e) return 'Error desconocido';
    if (e instanceof TypeError || /fetch|network/i.test(e.message || '')) return 'Sin conexión. Probá de nuevo cuando vuelva internet.';
    return e.message || String(e);
  }

  // Lee una tabla o vista entera, de a 1000 filas.
  async function leerTodo(tabla, sel, filtrar, orden) {
    const out = [];
    for (let desde = 0; ; desde += 1000) {
      let q = sb.from(tabla).select(sel || '*');
      if (filtrar) q = filtrar(q);
      if (orden) q = q.order(orden);
      const { data, error } = await q.range(desde, desde + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  function salirBoton() {
    const b = document.getElementById('salir');
    if (!b) return;
    b.addEventListener('click', async () => {
      const pend = window.Cola ? window.Cola.leer().length : 0;
      if (pend && !confirm('Hay ' + pend + ' operaciones sin subir. Quedan guardadas en este navegador. ¿Cerrar sesión igual?')) return;
      await sb.auth.signOut();
      LS.del('usuario');
      location.href = 'index.html';
    });
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin cache offline */ });
  }

  window.MEK = {
    sb, LS, MEDIOS, nombreMedio, hoy, esc, norm, plata, fechaCorta, r2, numero,
    nav, usuarioActual, requerirSesion, toast, mensaje, leerTodo, salirBoton,
  };
})();
