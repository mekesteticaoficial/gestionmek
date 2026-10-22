// Cabinas y packs: estado de cada pack por paciente (packs_estado en
// 07_mejoras.sql). "Usar sesión" va por la cola, igual que en Cobro.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  let packs = M.LS.get('packs_estado', []);
  let usuario = null;
  let tratamientos = M.LS.get('catalogo', { tratamientos: [] }).tratamientos || [];

  const dias = (f) => Math.round((new Date(M.hoy()) - new Date(String(f).slice(0, 10))) / 86400000);

  async function cargar() {
    try {
      const { data, error } = await sb.rpc('packs_estado', { p_incluir_terminados: $('#terminados').checked });
      if (error) throw error;
      packs = data || [];
      M.LS.set('packs_estado', packs);
    } catch (e) {
      if (navigator.onLine) M.toast(/packs_estado/.test(e.message || '') ? 'Falta correr 07_mejoras.sql en Supabase' : M.mensaje(e), 'error');
    }
    render();
  }

  // Sesiones usadas acá que todavía no subieron.
  const enCola = (id) => window.Cola.leer().filter((o) => o.tipo === 'venta' && o.payload.items.some((i) => i.tipo === 'pack_sesion' && i.pack_id === id)).length;

  // ¿La sesión necesita profesional? Solo si no es cabina.
  function esCabina(p) {
    const t = tratamientos.find((x) => x.id === p.tratamiento_id);
    return !t || t.categoria === 'cabina';
  }

  function render() {
    const f = M.norm($('#buscar').value);
    const lista = packs.filter((p) => !f || M.norm(p.paciente + ' ' + p.nombre).includes(f));
    const activos = packs.filter((p) => p.estado === 'activo');
    const quedan = activos.reduce((a, p) => a + (p.total - p.usadas - enCola(p.id)), 0);
    const sinVenir = activos.filter((p) => (p.ultima ? dias(p.ultima) : dias(p.fecha_venta)) > 30).length;
    $('#resumen').innerHTML =
      '<div class="kpi destacado"><small>Packs activos</small><b>' + activos.length + '</b></div>' +
      '<div class="kpi"><small>Sesiones por usar</small><b>' + quedan + '</b><div class="det">ya pagadas</div></div>' +
      '<div class="kpi' + (sinVenir ? ' destacado' : '') + '"><small>Sin venir hace más de 30 días</small><b>' + sinVenir + '</b><div class="det">para escribirles</div></div>';

    $('#lista').innerHTML = lista.length ? '<div class="packs-grilla">' + lista.map((p) => {
      const cola = enCola(p.id);
      const usadas = p.usadas + cola;
      const libres = p.total - usadas;
      const ultima = p.ultima ? dias(p.ultima) : null;
      const puntos = p.sesiones.map((s, i) => {
        const usada = s.fecha || i < usadas;
        return '<span class="punto' + (usada ? ' usada' : '') + '" title="Sesión ' + s.numero + (s.fecha ? ': ' + M.fechaCorta(s.fecha) + (s.profesional ? ' · ' + s.profesional : '') : usada ? ': hoy (sin sincronizar)' : ': disponible') + '"></span>';
      }).join('');
      return '<section class="card pack-card' + (p.estado !== 'activo' ? ' terminado' : '') + '">' +
        '<div class="titulo-fila"><div><b>' + M.esc(p.paciente) + '</b><div class="tenue">' + M.esc(p.nombre) + '</div></div>' +
        '<div style="text-align:right"><b style="font-size:1.3rem">' + usadas + ' de ' + p.total + '</b><div class="tenue">' +
        (p.estado === 'activo' ? (libres === 1 ? 'le queda 1' : 'le quedan ' + libres) : p.estado === 'agotado' ? 'terminado' : 'transferido') + '</div></div></div>' +
        '<div class="puntos" aria-label="' + usadas + ' de ' + p.total + ' sesiones usadas">' + puntos + '</div>' +
        '<div class="tenue">Comprado el ' + M.fechaCorta(p.fecha_venta) + (p.transferido_de ? ' · transferido de ' + M.esc(p.transferido_de) : '') +
        (p.ultima ? ' · última sesión ' + (ultima === 0 ? 'hoy' : ultima === 1 ? 'ayer' : 'hace ' + ultima + ' días') : ' · todavía no vino') + '</div>' +
        (p.sesiones.some((s) => s.fecha) ? '<div class="tenue" style="font-size:.8rem;margin-top:4px">' +
          p.sesiones.filter((s) => s.fecha).map((s) => s.numero + 'ª ' + M.fechaCorta(s.fecha).slice(0, 5)).join(' · ') + '</div>' : '') +
        (p.estado === 'activo' && libres > 0 ? '<div class="acciones fila"><button type="button" class="primario" data-usar="' + p.id + '">Usar sesión</button></div>' : '') +
        '</section>';
    }).join('') + '</div>'
      : '<section class="card"><p class="tenue">' + (f ? 'Nadie con ese nombre tiene un pack.' : 'No hay packs activos.') + '</p></section>';
    renderSync();
  }

  function renderSync() {
    const ops = window.Cola.leer();
    const err = ops.filter((o) => o.error).length;
    const b = $('#sync');
    b.className = 'sync' + (err ? ' mal' : ops.length ? ' espera' : ' ok');
    b.textContent = (navigator.onLine ? '' : 'Sin conexión · ') + (err ? err + ' con error' : ops.length ? ops.length + ' sin sincronizar' : '✓ Todo sincronizado');
  }

  function usar(id) {
    const p = packs.find((x) => x.id === id);
    const item = { tipo: 'pack_sesion', pack_id: p.id, cantidad: 1 };
    if (!esCabina(p)) {
      const prof = usuario.profesional_id || M.LS.get('ultimoProf', null);
      if (!prof) { M.toast('Esta sesión necesita quién la hizo: usala desde Cobro', 'error'); return; }
      item.profesional_id = prof;
    }
    if (!confirm('¿Usar una sesión de ' + p.nombre + ' de ' + p.paciente + ' hoy?')) return;
    window.Cola.agregar('venta', { fecha: M.hoy(), paciente_ref: p.paciente_ref,
      paciente: { ref: p.paciente_ref, nombre: p.paciente, telefono: p.telefono }, estado: 'cobrada', pagos: [], items: [item] });
    M.toast('Sesión registrada: ' + p.paciente, 'ok');
    render();
    subir();
  }

  // ------------------------------------------------------------ cabina suelta
  // Sin ficha: va a la paciente fija 'x_ocasional' (sql/09_correcciones.sql),
  // siempre cobrada. El nombre, si lo dicen, queda en la nota.
  const OCASIONAL = { ref: 'x_ocasional', nombre: 'Sin ficha (ocasional)', telefono: null, email: null };
  let cabinas = M.LS.get('cabinas_sueltas', []);
  let profs = M.LS.get('profs_pagos', []);   // para "¿a qué cuenta fue?"
  const vacia = () => ({ id: null, precio: null, medio: null, destino: '', nombre: '', paciente: null, buscar: '' });
  let suelta = vacia();
  // Pacientes del espejo (las mismas que en Cobro). Un pack sí necesita
  // a alguien con ficha: tiene que quedar a su nombre.
  let pacientes = M.LS.get('pacientes', []);
  async function cargarPacientes() {
    try {
      pacientes = await M.leerTodo('pacientes', 'ref,nombre,telefono,email', null, 'ref');
      M.LS.set('pacientes', pacientes);
    } catch (e) { /* sin red: la lista guardada */ }
  }
  function buscarPac(q) {
    const w = M.norm(q).split(/\s+/).filter(Boolean);
    if (!w.length) return [];
    return pacientes.filter((p) => p.ref !== OCASIONAL.ref && w.every((x) => M.norm(p.nombre).includes(x)))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, 8);
  }

  async function cargarCabinas() {
    try {
      const [t, p, pr] = await Promise.all([
        sb.from('tratamientos').select('id,nombre,categoria,pack_sesiones,activo').eq('categoria', 'cabina').eq('activo', true).order('nombre'),
        sb.from('precios_tratamiento').select('tratamiento_id,precio,vigente_desde'),
        sb.from('profesionales').select('*').eq('activo', true),
      ]);
      if (t.error || p.error) throw t.error || p.error;
      if (!pr.error) { profs = pr.data; M.LS.set('profs_pagos', profs); }
      const hoy = M.hoy();
      const min = (n) => parseInt(n.replace(/\D+/g, ' ').trim(), 10) || 0;
      cabinas = t.data.map((x) => {
        const v = p.data.filter((r) => r.tratamiento_id === x.id && String(r.vigente_desde).slice(0, 10) <= hoy)
          .sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1))[0];
        return { id: x.id, nombre: x.nombre, precio: v ? Number(v.precio) : null, pack: x.pack_sesiones || null };
      }).sort((a, b) => (!!a.pack - !!b.pack) || min(a.nombre) - min(b.nombre));
      M.LS.set('cabinas_sueltas', cabinas);
    } catch (e) { /* sin red: se usa la lista guardada */ }
    renderSuelta();
  }

  function renderSuelta() {
    const el = $('#suelta');
    if (!cabinas.length) { el.innerHTML = '<p class="tenue">Cargando cabinas…</p>'; return; }
    const elegida = cabinas.find((c) => c.id === suelta.id);
    const boton = (c) => '<button type="button" class="opcion' + (c.id === suelta.id ? ' activo' : '') +
      '" data-suelta="' + c.id + '"><span>' + M.esc(c.nombre) + '</span><small>' + (c.precio == null ? 'sin precio' : M.plata(c.precio)) +
      (c.pack ? ' · ' + c.pack + ' sesiones' : '') + '</small></button>';
    const sueltas = cabinas.filter((c) => !c.pack), promos = cabinas.filter((c) => c.pack);
    const quien = suelta.paciente
      ? '<div class="paciente" style="margin-top:10px"><b>' + M.esc(suelta.paciente.nombre) + '</b> <button type="button" class="link" id="sueltaOtra">cambiar</button></div>'
      : '<label style="margin-top:10px;display:block">' + (elegida && elegida.pack ? '¿Quién compra la promo? (tiene que tener ficha)' : '¿Quién? Si tiene ficha, buscala; si no, dejalo vacío') +
        ' <input type="search" id="sueltaBuscar" value="' + M.esc(suelta.buscar) + '" placeholder="Buscar paciente…" autocomplete="off"></label>' +
        '<ul class="resultados" id="sueltaRes">' + htmlRes() + '</ul>' +
        (elegida && !elegida.pack ? '<label>Nombre <input id="sueltaNombre" value="' + M.esc(suelta.nombre) + '" placeholder="Opcional, si no tiene ficha"></label>' : '');
    el.innerHTML = '<h3>Sueltas</h3><div class="grilla">' + sueltas.map(boton).join('') + '</div>' +
      (promos.length ? '<h3>Promos (packs)</h3><div class="grilla">' + promos.map(boton).join('') + '</div>' : '') +
      (elegida ? quien + '<div class="form" style="margin-top:10px">' +
        '<label>Cobrado $ <input type="number" id="sueltaPrecio" min="0" step="1" inputmode="decimal" value="' + (suelta.precio == null ? '' : suelta.precio) + '"></label></div>' +
        '<div class="medios" style="margin-top:8px">' + M.MEDIOS.map(([k, n]) => '<button type="button" class="medio' + (suelta.medio === k ? ' activo' : '') +
          '" data-sueltamedio="' + k + '">' + n + '</button>').join('') + '</div>' +
        (suelta.medio && (suelta.medio === 'transferencia' || profs.some((x) => x.recibe_pagos))
          ? '<label class="destino" style="margin-top:8px;display:block">' + (suelta.medio === 'transferencia' ? 'Fue a ' : 'Recibió ') +
            '<select id="sueltaDestino">' + M.opcionesDestino(suelta.medio, suelta.destino, profs) + '</select></label>' : '') +
        '<div class="acciones fila"><button type="button" class="primario" id="sueltaGuardar">Registrar ' + M.esc(elegida.nombre) + '</button>' +
        '<button type="button" class="link" id="sueltaCancelar">cancelar</button></div>' : '');
  }

  function htmlRes() {
    const res = buscarPac(suelta.buscar);
    return res.map((p) => '<li><button type="button" data-sueltapac="' + M.esc(p.ref) + '"><b>' + M.esc(p.nombre) + '</b>' +
      (p.telefono ? '<span class="tenue"> · …' + M.esc(String(p.telefono).slice(-4)) + '</span>' : '') + '</button></li>').join('') +
      (suelta.buscar.trim() && !res.length ? '<li class="tenue">No aparece: tiene que estar cargada en el dashboard.</li>' : '');
  }

  // Lee lo escrito antes de redibujar (no se pierde al tocar un botón).
  function leerForm() {
    if ($('#sueltaPrecio')) suelta.precio = M.numero($('#sueltaPrecio').value);
    if ($('#sueltaNombre')) suelta.nombre = $('#sueltaNombre').value;
    if ($('#sueltaBuscar')) suelta.buscar = $('#sueltaBuscar').value;
    if ($('#sueltaDestino')) suelta.destino = $('#sueltaDestino').value;
  }

  function guardarSuelta() {
    leerForm();
    const c = cabinas.find((x) => x.id === suelta.id);
    const precio = suelta.precio;
    const nombre = (suelta.nombre || '').trim();
    if (!(precio > 0)) { M.toast('Falta lo que pagó', 'error'); return; }
    if (!suelta.medio) { M.toast('Elegí con qué pagó', 'error'); return; }
    if (suelta.medio === 'transferencia' && !suelta.destino) { M.toast('Elegí a qué cuenta fue la transferencia', 'error'); return; }
    if (c.pack && !suelta.paciente) { M.toast('La promo tiene que quedar a nombre de una paciente con ficha', 'error'); return; }
    const pac = suelta.paciente || OCASIONAL;
    window.Cola.agregar('venta', { fecha: M.hoy(), paciente_ref: pac.ref, paciente: pac, estado: 'cobrada',
      pagos: [Object.assign({ medio: suelta.medio, monto: precio }, M.destinoAPago(suelta.destino))], nota: !suelta.paciente && nombre ? 'Nombre: ' + nombre : null,
      items: [{ tipo: c.pack ? 'pack_venta' : 'cabina', tratamiento_id: c.id, cantidad: 1, precio_cobrado: precio }] });
    M.toast(c.nombre + (c.pack ? ' vendida a ' + pac.nombre + ': aparece abajo para ir usando las sesiones' : ' registrada') + ' · ' + M.plata(precio) +
      (navigator.onLine ? '' : ' (sin conexión: se sube sola)'), 'ok', c.pack ? 6000 : null);
    suelta = vacia();
    renderSuelta();
    renderSync();
    subir();
  }

  async function subir() { await window.Cola.procesar(sb); await cargar(); }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.usar) usar(Number(t.dataset.usar));
    if (t.dataset.suelta) {
      leerForm();
      const c = cabinas.find((x) => x.id === Number(t.dataset.suelta));
      suelta.id = c.id; suelta.precio = c.precio;
      renderSuelta();
    }
    if (t.dataset.sueltamedio) {
      leerForm();
      suelta.medio = t.dataset.sueltamedio;
      if (suelta.destino && !suelta.destino.startsWith('p:') && suelta.medio !== 'transferencia') suelta.destino = '';
      renderSuelta();
    }
    if (t.dataset.sueltapac) { leerForm(); suelta.paciente = pacientes.find((p) => p.ref === t.dataset.sueltapac); suelta.buscar = ''; renderSuelta(); }
    if (t.id === 'sueltaOtra') { leerForm(); suelta.paciente = null; renderSuelta(); $('#sueltaBuscar').focus(); }
    if (t.id === 'sueltaGuardar') guardarSuelta();
    if (t.id === 'sueltaCancelar') { suelta = vacia(); renderSuelta(); }
    if (t.id === 'sync') subir();
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'buscar') render();
    if (ev.target.id === 'sueltaBuscar') { suelta.buscar = ev.target.value; $('#sueltaRes').innerHTML = htmlRes(); }
  });
  document.addEventListener('change', (ev) => { if (ev.target.id === 'terminados') cargar(); });

  async function iniciar() {
    usuario = await M.requerirSesion('cabinas');
    if (!usuario) return;
    M.salirBoton();
    render();
    renderSuelta();
    cargarCabinas();
    cargarPacientes();
    window.Cola.alCambiar(renderSync);
    window.addEventListener('online', subir);
    if (!tratamientos.length && navigator.onLine) {
      const { data } = await sb.from('tratamientos').select('id,categoria');
      tratamientos = data || [];
    }
    await cargar();
    if (window.Cola.leer().length) subir();
  }
  iniciar();
})();
