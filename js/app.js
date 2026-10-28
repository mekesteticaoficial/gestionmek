// Pantalla de cobro.
// Flujo: paciente → qué se hizo → confirmar → listo.
// Nada se escribe directo en las tablas: todo va a la cola (js/cola.js),
// que llama a las funciones de la base (sql/02_cobro.sql).
(function () {
  'use strict';
  const C = window.Calculo;
  const CFG = window.MEK_CONFIG;
  const $ = (s) => document.querySelector(s);
  const plata = C.plata;

  const MEDIOS = [
    ['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['debito', 'Débito'],
    ['credito', 'Crédito'], ['mercadopago', 'Mercado Pago'],
  ];
  const nombreMedio = (m) => (m === 'giftcard' ? 'Gift card' : (MEDIOS.find((x) => x[0] === m) || [m, m])[1]);

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('mek.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mek.' + k, JSON.stringify(v)); } catch (e) { /* lleno o bloqueado */ } },
    del(k) { try { localStorage.removeItem('mek.' + k); } catch (e) { /* nada */ } },
  };

  const sb = window.MEK.sb;

  const hoy = () => new Date().toLocaleDateString('en-CA');   // AAAA-MM-DD, hora local
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let uidSeq = 0;

  const S = {
    usuario: LS.get('usuario', null),
    cat: LS.get('catalogo', null),
    pacientes: LS.get('pacientes', []),
    ventasHoy: LS.get('ventasHoy', []),
    pendientes: LS.get('pendientes', []),
    sinRegla: 0,
    fecha: hoy(),
    paciente: null,
    items: [],
    pagos: [{ medio: null, monto: null }],
    nota: '',
    tab: 'tratamientos',
    filtro: '',
    filtroProd: '',
    depi: { sexo: 'mujer', zonas: [] },
    cobrandoPendiente: null,   // id de venta de la bandeja que se está cobrando
    pagosPendiente: [{ medio: null, monto: null }],
    // Turnos marcados "✓ Atendida" en el dashboard (js/turnos.js).
    turnos: LS.get('turnos', { fecha: null, lista: [], cobrados: [] }),
    turnosError: null,
    turno: null,               // el turno que se está cobrando en el ticket
    parcial: null,             // "pagó una parte": {medio, monto}
    nombreOcasional: '',       // nombre libre cuando es "sin ficha"
    giftcards: LS.get('giftcards', []),   // gift cards con saldo (v_gift_cards)
  };

  // Clienta sin ficha en el dashboard (sql/09_correcciones.sql).
  const OCASIONAL = 'x_ocasional';
  const esOcasional = () => S.paciente && S.paciente.ref === OCASIONAL;

  // ------------------------------------------------------------------
  // Carga de datos
  // ------------------------------------------------------------------
  async function cargarCatalogo() {
    const q = (t, sel) => sb.from(t).select(sel || '*');
    const res = await Promise.all([
      q('profesionales').eq('activo', true).order('id'),
      q('tratamientos').eq('activo', true).order('nombre'),
      q('precios_tratamiento'),
      q('reglas_comision'),
      q('zonas_depilacion').eq('activo', true),
      q('promos_depilacion').eq('activo', true).order('id'),
      q('promo_zonas'),
      q('escala_depilacion').order('posicion'),
      q('productos').eq('activo', true).eq('tipo', 'reventa').order('nombre'),
      q('packs', 'id,paciente_ref,nombre,tratamiento_id,precio_pagado,sesiones_totales,estado,pack_sesiones(consumida_en)')
        .eq('estado', 'activo'),
    ]);
    const err = res.find((r) => r.error);
    if (err) throw err.error;
    const [prof, trat, prec, reg, zon, pro, pz, esc_, prod, packs] = res.map((r) => r.data);
    S.cat = {
      profesionales: prof, tratamientos: trat, precios: prec, reglas: reg, zonas: zon,
      promos: pro, promoZonas: pz, escala: esc_, productos: prod,
      packs: packs.map((p) => ({
        id: p.id, paciente_ref: p.paciente_ref, nombre: p.nombre, tratamiento_id: p.tratamiento_id,
        precio_pagado: p.precio_pagado, sesiones_totales: p.sesiones_totales,
        disponibles: p.pack_sesiones.filter((s) => !s.consumida_en).length,
      })),
      cargado: new Date().toISOString(),
    };
    LS.set('catalogo', S.cat);
  }

  // Solo los packs (cambian con cada sesión usada). El resto del catálogo
  // cambia poco: se recarga al abrir y con "Recargar precios y catálogo".
  async function cargarPacks() {
    if (!S.cat) return cargarCatalogo();
    const { data, error } = await sb.from('packs')
      .select('id,paciente_ref,nombre,tratamiento_id,precio_pagado,sesiones_totales,estado,pack_sesiones(consumida_en)').eq('estado', 'activo');
    if (error) throw error;
    S.cat.packs = data.map((p) => ({
      id: p.id, paciente_ref: p.paciente_ref, nombre: p.nombre, tratamiento_id: p.tratamiento_id,
      precio_pagado: p.precio_pagado, sesiones_totales: p.sesiones_totales,
      disponibles: p.pack_sesiones.filter((s) => !s.consumida_en).length,
    }));
    LS.set('catalogo', S.cat);
  }

  async function cargarPacientesEspejo() {
    const todos = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await sb.from('pacientes').select('ref,nombre,telefono,email')
        .order('ref').range(desde, desde + 999);
      if (error) throw error;
      todos.push(...data);
      if (data.length < 1000) break;
    }
    S.pacientes = todos;
    LS.set('pacientes', todos);
  }

  async function sincronizarPacientes(completo) {
    const estado = $('#pacientesEstado');
    try {
      const conocidos = new Set(S.pacientes.map((p) => p.ref));
      const r = await window.Pacientes.sincronizar(sb, conocidos, completo, (n, t) => {
        estado.textContent = 'Trayendo pacientes del dashboard… ' + n + ' de ' + t;
      });
      if (r.nuevos.length) await cargarPacientesEspejo();
      estado.textContent = S.pacientes.length + ' pacientes' +
        (r.nuevos.length ? ' · ' + r.nuevos.length + (completo ? ' actualizadas' : ' nuevas') : '');
    } catch (e) {
      estado.textContent = 'No se pudo leer el dashboard (' + (e.message || e) + '). Se usa la lista guardada: ' +
        S.pacientes.length + ' pacientes.';
    }
  }

  // Si todavía no se corrió 11_cobros_directos.sql, venta_pagos no tiene
  // cuenta/profesional_id: se piden sin esas columnas.
  let pagosConDestino = true;
  let conGift = true;   // venta_pagos.gift_card_id (12_giftcards_y_controles.sql)
  async function cargarVentas() {
    try { await cargarVentasCon(pagosConDestino); } catch (e) {
      if (conGift && /gift_card_id/.test(e.message || '')) { conGift = false; return cargarVentas(); }
      if (pagosConDestino && /cuenta|profesional_id/.test(e.message || '')) { pagosConDestino = false; return cargarVentasCon(false); }
      throw e;
    }
  }
  async function cargarVentasCon(destino) {
    const sel = 'id,fecha,paciente_ref,estado,medio_pago,nota,creado_por,client_id,a_deudores_en,' +
                'pacientes(nombre),venta_items(tipo,descripcion,precio_cobrado,profesional_id),venta_pagos(medio,monto' +
                (destino ? ',cuenta,profesional_id' + (conGift ? ',gift_card_id' : '') : '') + ')';
    const [h, p, s] = await Promise.all([
      sb.from('ventas').select(sel).eq('fecha', S.fecha).order('id', { ascending: false }),
      sb.from('ventas').select(sel).eq('estado', 'pendiente').order('fecha').order('id'),
      S.usuario && S.usuario.rol === 'admin'
        ? sb.from('v_items_sin_regla').select('venta_id,fecha,descripcion,profesional').order('fecha', { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    if (h.error) throw h.error;
    if (p.error) throw p.error;
    S.ventasHoy = h.data;
    S.pendientes = p.data;
    // Cuáles son, para poder verlos (no solo cuántos).
    S.sinReglaLista = s.data || [];
    S.sinRegla = S.sinReglaLista.length;
    LS.set('ventasHoy', S.ventasHoy);
    LS.set('pendientes', S.pendientes);
  }

  // Turnos atendidos del día elegido. Firebase solo se lee (GET).
  async function cargarTurnos() {
    if (!navigator.onLine) return;
    const fecha = S.fecha;
    try {
      const lista = (await window.Turnos.leerDia(fecha)).filter((t) => t.atendido);
      if (fecha !== S.fecha) return;
      S.turnos = { fecha, lista, cobrados: S.turnos.fecha === fecha ? S.turnos.cobrados : [] };
      S.turnosError = null;
      await marcarCobrados();
    } catch (e) {
      S.turnosError = 'No se pudieron leer los turnos del dashboard (' + (e.message || e) + ').';
    }
  }

  // Qué turnos ya tienen una venta (no anulada) en la base.
  async function marcarCobrados() {
    const refs = S.turnos.lista.map((t) => t.ref);
    if (!refs.length || !navigator.onLine) { LS.set('turnos', S.turnos); return; }
    const [{ data, error }, desc] = await Promise.all([
      sb.from('ventas').select('turno_ref').in('turno_ref', refs).neq('estado', 'anulada'),
      sb.from('turnos_descartados').select('turno_ref,restaurado_en').in('turno_ref', refs),
    ]);
    if (error) throw error;
    S.turnos.cobrados = data.map((v) => v.turno_ref);
    // Sacados a mano de la lista (si falta 11_cobros_directos.sql, no hay).
    S.turnos.descartados = desc.error ? [] : desc.data.filter((x) => !x.restaurado_en).map((x) => x.turno_ref);
    LS.set('turnos', S.turnos);
  }

  // Gift cards con saldo, para pagar con ellas (12_giftcards_y_controles.sql).
  async function cargarGiftcards() {
    if (!navigator.onLine) return;
    const { data, error } = await sb.from('v_gift_cards').select('id,beneficiaria,paciente_ref,descripcion,saldo,vence,anulada_en');
    if (error) return;   // sin el 12 todavía: no hay gift cards
    S.giftcards = data.filter((g) => !g.anulada_en && Number(g.saldo) > 0 && (!g.vence || g.vence >= S.fecha));
    LS.set('giftcards', S.giftcards);
  }

  async function refrescar() {
    if (!navigator.onLine) { render(); return; }
    try {
      await window.Cola.procesar(sb);
      await Promise.all([cargarCatalogo(), cargarVentas(), cargarTurnos(), cargarGiftcards()]);
    } catch (e) {
      toast('No se pudo actualizar: ' + (e.message || e), 'error');
    }
    render();
  }

  // ------------------------------------------------------------------
  // Sesión
  // ------------------------------------------------------------------
  async function traerUsuario() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb.from('usuarios').select('nombre,rol,profesional_id')
      .eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  function mostrar(pantalla) {
    $('#login').hidden = pantalla !== 'login';
    $('#cobro').hidden = pantalla !== 'cobro';
    $('#usuario').hidden = pantalla !== 'cobro';
    if (pantalla !== 'cobro') $('#nav').hidden = true;
    $('#sync').hidden = pantalla !== 'cobro';
  }

  async function entrar(ev) {
    ev.preventDefault();
    const errEl = $('#loginError');
    errEl.hidden = true;
    const { error } = await sb.auth.signInWithPassword({
      email: $('#loginEmail').value.trim(), password: $('#loginPass').value,
    });
    if (error) { errEl.textContent = 'No se pudo entrar: ' + error.message; errEl.hidden = false; return; }
    $('#loginPass').value = '';
    try {
      const u = await traerUsuario();
      if (!u) {
        errEl.textContent = 'Tu usuario existe pero no está habilitado en la app (falta correr sql/03_usuarios.sql).';
        errEl.hidden = false;
        await sb.auth.signOut();
        return;
      }
      S.usuario = u;
      LS.set('usuario', u);
    } catch (e) {
      errEl.textContent = 'Error: ' + (e.message || e); errEl.hidden = false; return;
    }
    await arrancarCobro();
  }

  async function salir() {
    const pend = window.Cola.leer().length;
    if (pend && !confirm('Hay ' + pend + ' operaciones sin subir. Si cerrás sesión quedan guardadas en este navegador, ' +
                         'pero no se suben hasta que alguien vuelva a entrar acá. ¿Cerrar igual?')) return;
    await sb.auth.signOut();
    S.usuario = null;
    LS.del('usuario');
    mostrar('login');
  }

  async function arrancarCobro() {
    mostrar('cobro');
    window.MEK.nav('cobro', S.usuario);
    $('#usuarioNombre').textContent = S.usuario.nombre;
    $('#syncPacientes').hidden = S.usuario.rol !== 'admin';
    render();
    if (!navigator.onLine) return;
    try {
      await Promise.all([cargarCatalogo(), cargarPacientesEspejo(), cargarVentas(), cargarGiftcards()]);
    } catch (e) {
      toast('No se pudo cargar todo: ' + (e.message || e), 'error');
    }
    render();
    sincronizarPacientes(false).then(render);
    cargarTurnos().then(render);
    window.Cola.procesar(sb).then(refrescarSiCambio);
  }

  // ------------------------------------------------------------------
  // Ticket
  // ------------------------------------------------------------------
  function profDefault() {
    if (S.turno && S.turno.profesional_id) return S.turno.profesional_id;
    return (S.usuario && S.usuario.profesional_id) || LS.get('ultimoProf', null);
  }

  function agregarItem(it) {
    it.uid = ++uidSeq;
    it.cantidad = it.cantidad || 1;
    it.costo_insumo = null;
    if (it.precio_cobrado === undefined) it.precio_cobrado = precioLista(it);  // variable: null, hay que escribirlo
    S.items.push(it);
    render();
    const inp = document.querySelector('[data-precio="' + it.uid + '"]');
    if (inp && it.precio_cobrado == null) inp.focus();
    toast('Agregado', 'ok', 900);
  }

  // Precio completo de lista, el que paga la paciente (sin descontar la
  // parte de una profesional externa).
  function precioLista(it) {
    return C.calcularItem(S.cat, Object.assign({}, it, { precio_cobrado: null, profesional_id: null }), S.fecha).lista;
  }

  function necesitaProf(it) {
    if (it.tipo === 'depilacion') return true;
    if (it.tipo !== 'tratamiento') return false;
    const t = S.cat.tratamientos.find((x) => x.id === it.tratamiento_id);
    return t && t.categoria !== 'cabina';
  }

  function calcular() {
    const filas = S.items.map((it) => ({ it, r: C.calcularItem(S.cat, it, S.fecha) }));
    const total = C.r2(filas.reduce((a, f) => a + (f.r.cobrado || 0), 0));
    return { filas, total };
  }

  function lineaComision(r) {
    if (r.sinRegla) return '<div class="alerta">⚠ ' + esc(r.avisos.find((a) => a.startsWith('No hay regla'))) + '</div>';
    if (!r.comision) return '';
    const c = r.comision, p = c.prof;
    const cuanto = c.tipo === 'porcentaje' ? c.valor + '%' : plata(c.valor) + ' fijo';
    if (p.modelo === 'invitado_cobra_mek') {
      return '<div class="com tercero">Para ' + esc(p.nombre) + ' (' + cuanto + '): <b>' + plata(r.tercero) +
             '</b> · queda para MEK ' + plata(C.r2(r.cobrado - r.tercero)) + '</div>';
    }
    if (p.modelo === 'invitado_cobra_el') {
      return '<div class="com tercero">Cobra ' + esc(p.nombre) + ' y se lleva ' + cuanto +
             '. Entra a MEK: <b>' + plata(r.parteMek) + '</b></div>';
    }
    if (c.monto === 0) return '<div class="com">Sin comisión (queda todo para MEK)</div>';
    return '<div class="com">Comisión ' + esc(p.nombre.split(' ')[0]) + ' (' + cuanto + '): <b>' + plata(c.monto) + '</b></div>';
  }

  function htmlItem(f) {
    const { it, r } = f;
    const trat = it.tratamiento_id && S.cat.tratamientos.find((t) => t.id === it.tratamiento_id);
    const prof = it.profesional_id && S.cat.profesionales.find((p) => p.id === it.profesional_id);
    const cobraEl = prof && prof.modelo === 'invitado_cobra_el';
    const variable = trat && trat.precio_variable;
    const mg = C.margen(r);
    const opciones = S.cat.profesionales.map((p) =>
      '<option value="' + p.id + '"' + (p.id === it.profesional_id ? ' selected' : '') + '>' + esc(p.nombre) + '</option>').join('');
    let ref = '';
    if (variable && trat.precio_min != null) ref = 'Referencia ' + plata(trat.precio_min) + '–' + plata(trat.precio_max);
    else if (variable) ref = 'Precio a presupuestar';
    else if (r.lista != null && !cobraEl) ref = 'Lista ' + plata(r.lista) +
      (r.cobrado != null && r.cobrado !== r.lista ? ' · <span class="dif">' + (r.cobrado < r.lista ? '−' : '+') +
       plata(Math.abs(C.r2(r.cobrado - r.lista))) + '</span>' : '');

    return '<div class="item' + (r.errores.length ? ' con-error' : '') + '" data-uid="' + it.uid + '">' +
      '<div class="item-top"><div class="desc">' + esc(r.descripcion || '—') + '</div>' +
      '<button type="button" class="quitar" data-quitar="' + it.uid + '" aria-label="Quitar">✕</button></div>' +
      (necesitaProf(it) ? '<label class="fila">Lo hizo <select data-prof="' + it.uid + '">' +
        '<option value="">— elegir —</option>' + opciones + '</select></label>' : '') +
      '<div class="fila precio"><label>' + (cobraEl ? 'Pagó la paciente' : 'Cobrado') + ' $' +
        '<input type="number" inputmode="decimal" min="0" step="1" data-precio="' + it.uid + '" value="' +
        (it.precio_cobrado == null ? '' : it.precio_cobrado) + '" placeholder="' + (variable ? 'Monto' : '') + '"></label>' +
        (it.tipo === 'producto' ? '<label>Cant. <input type="number" min="1" step="1" class="cant" data-cant="' + it.uid +
          '" value="' + it.cantidad + '"></label>' : '') +
        '<span class="ref">' + ref + '</span></div>' +
      lineaComision(r) +
      r.avisos.filter((a) => !a.startsWith('No hay regla')).map((a) => '<div class="aviso">' + esc(a) + '</div>').join('') +
      r.errores.map((e) => '<div class="error">' + esc(e) + '</div>').join('') +
      '<div class="margen">Margen: ' + (mg == null ? '<i>sin dato</i>' : plata(mg)) +
        ' · <button type="button" class="link" data-costo="' + it.uid + '">' +
        (it.costo_insumo == null ? 'cargar costo de insumo' : 'costo ' + plata(it.costo_insumo)) + '</button></div>' +
      '</div>';
  }

  // pacRef: de quién es la venta, para mostrar primero sus gift cards.
  function htmlPagos(pagos, total, prefijo, pacRef) {
    const medios = MEDIOS.concat(S.giftcards.length ? [['giftcard', '🎁 Gift card']] : []);
    const filas = pagos.map((p, i) => {
      const ultimo = i === pagos.length - 1 && pagos.length > 1;
      return '<div class="pago">' +
        '<div class="medios">' + medios.map(([k, n]) =>
          '<button type="button" class="medio' + (p.medio === k ? ' activo' : '') + '" data-' + prefijo + 'medio="' + i +
          '" data-valor="' + k + '">' + n + '</button>').join('') + '</div>' +
        (p.medio === 'giftcard' ? htmlGift(p, 'data-' + prefijo + 'gift="' + i + '"', pacRef)
                                : htmlDestino(p, 'data-' + prefijo + 'destino="' + i + '"')) +
        (pagos.length > 1 ? '<label class="monto">$ <input type="number" inputmode="decimal" min="0" data-' + prefijo +
          'monto="' + i + '" value="' + (p.monto == null ? '' : p.monto) + '"' + (ultimo ? ' readonly title="Se calcula solo: lo que falta"' : '') +
          '></label>' + '<button type="button" class="link" data-' + prefijo + 'sacar="' + i + '">sacar</button>' : '') +
        '</div>';
    }).join('');
    return filas + '<button type="button" class="link" data-' + prefijo + 'dividir>' +
      (pagos.length > 1 ? '+ otro medio' : 'Pagó con dos medios') + '</button>';
  }

  // ¿A quién le llegó? Obligatorio en transferencias; en los demás medios,
  // solo si hay profesionales que cobran (Juan Cruz, Daniela, Yael).
  function htmlDestino(p, attr) {
    if (!p.medio || !S.cat) return '';
    const profs = S.cat.profesionales || [];
    if (p.medio !== 'transferencia' && !profs.some((x) => x.recibe_pagos)) return '';
    return '<label class="destino' + (p.medio === 'transferencia' && !p.destino ? ' falta' : '') + '">' +
      (p.medio === 'transferencia' ? 'Fue a ' : 'Recibió ') +
      '<select ' + attr + '>' + window.MEK.opcionesDestino(p.medio, p.destino || '', profs) + '</select></label>';
  }
  // Qué gift card: primero las de esta paciente.
  function htmlGift(p, attr, pacRef) {
    const cards = S.giftcards.slice().sort((a, b) => (b.paciente_ref === pacRef) - (a.paciente_ref === pacRef) || a.beneficiaria.localeCompare(b.beneficiaria));
    const g = S.giftcards.find((x) => x.id === p.gift);
    return '<label class="destino' + (!p.gift ? ' falta' : '') + '">Cuál <select ' + attr + '><option value="">— elegir —</option>' +
      cards.map((c) => '<option value="' + c.id + '"' + (c.id === p.gift ? ' selected' : '') + '>' + esc(c.beneficiaria) +
        (c.descripcion ? ' · ' + esc(c.descripcion) : '') + ' · le quedan ' + plata(c.saldo) + '</option>').join('') + '</select></label>' +
      (g && Number(p.monto) > Number(g.saldo) ? '<div class="aviso">Le quedan ' + plata(g.saldo) + ': tocá "Pagó con dos medios" y poné el resto en otro medio.</div>' : '');
  }
  const pagoPayload = (x) => (x.medio === 'giftcard'
    ? { medio: 'giftcard', monto: Number(x.monto), gift_card_id: x.gift }
    : Object.assign({ medio: x.medio, monto: Number(x.monto) }, window.MEK.destinoAPago(x.destino || '')));

  // En pagos divididos, el último medio se completa con lo que falta.
  function ajustarPagos(pagos, total) {
    if (pagos.length === 1) { pagos[0].monto = total; return; }
    const otros = pagos.slice(0, -1).reduce((a, p) => a + (Number(p.monto) || 0), 0);
    pagos[pagos.length - 1].monto = C.r2(total - otros);
  }

  function validarPagos(pagos, total) {
    if (total === 0) return null;
    if (pagos.some((p) => !p.medio)) return 'Elegí el medio de pago';
    if (pagos.some((p) => p.medio === 'transferencia' && !p.destino)) return 'Elegí a qué cuenta fue la transferencia';
    if (pagos.some((p) => p.medio === 'giftcard' && !p.gift)) return 'Elegí qué gift card usa';
    for (const p of pagos.filter((x) => x.medio === 'giftcard')) {
      const g = S.giftcards.find((x) => x.id === p.gift);
      const usa = pagos.filter((x) => x.medio === 'giftcard' && x.gift === p.gift).reduce((a, x) => a + Number(x.monto), 0);
      if (g && usa > Number(g.saldo)) return 'A la gift card le quedan ' + plata(g.saldo) + ': poné el resto en otro medio';
    }
    if (pagos.some((p) => !(Number(p.monto) > 0))) return 'Hay un pago sin monto o negativo';
    const suma = C.r2(pagos.reduce((a, p) => a + Number(p.monto), 0));
    if (suma !== total) return 'Los pagos suman ' + plata(suma) + ' y el total es ' + plata(total);
    return null;
  }

  function htmlTurnoTicket() {
    const t = S.turno;
    if (!t) return '';
    return '<div class="turno-ticket"><div><b>Turno del dashboard</b> · ' + horaTurno(t.hora) + ' · ' + esc(t.nom) +
      ' · ' + esc(t.tr || 'sin tratamiento') + (t.profNombre ? ' · ' + esc(t.profNombre) : '') +
      (t.obs ? '<div class="tenue">Nota del turno: ' + esc(t.obs) + '</div>' : '') +
      (t.aviso ? '<div class="aviso">' + esc(t.aviso) + '</div>' : '') +
      '</div><button type="button" class="link" data-soltarturno>no es de este turno</button></div>';
  }

  function renderTicket() {
    const el = $('#ticket');
    if (!S.items.length) {
      el.innerHTML = htmlTurnoTicket() + '<p class="tenue">Elegí lo que se hizo en el paso 2.</p>';
      renderBarraMovil(0);
      return;
    }
    const { filas, total } = calcular();
    ajustarPagos(S.pagos, total);
    const errores = filas.some((f) => f.r.errores.length);
    const errPago = validarPagos(S.pagos, total);
    const faltaPaciente = !S.paciente;
    const ocasional = esOcasional();
    if (ocasional || total <= 0) S.parcial = null;
    const pa = S.parcial;
    const debe = pa && Number(pa.monto) > 0 ? C.r2(total - Number(pa.monto)) : null;
    const errParcial = pa && (!pa.medio ? 'Elegí con qué pagó'
      : pa.medio === 'transferencia' && !pa.destino ? 'Elegí a qué cuenta fue la transferencia'
      : !(Number(pa.monto) > 0) ? 'Escribí cuánto pagó'
      : debe <= 0 ? 'Si pagó todo, usá "Cobrar"' : null);

    el.innerHTML = htmlTurnoTicket() + filas.map(htmlItem).join('') +
      '<div class="total"><span>Total</span><b>' + plata(total) + '</b></div>' +
      (total > 0 && !pa ? '<div class="pagos">' + htmlPagos(S.pagos, total, 't', S.paciente && S.paciente.ref) + '</div>' : '') +
      (pa ? '<div class="pagos parcial"><b>Pagó una parte</b>' +
        '<div class="medios">' + MEDIOS.map(([k, n]) => '<button type="button" class="medio' + (pa.medio === k ? ' activo' : '') +
          '" data-pmedio="' + k + '">' + n + '</button>').join('') + '</div>' +
        htmlDestino(pa, 'id="parcialDestino"') +
        '<label class="monto">Pagó $ <input type="number" inputmode="decimal" min="0" id="parcialMonto" value="' + (pa.monto == null ? '' : esc(pa.monto)) + '"></label>' +
        '<div id="parcialDebe">' + (debe != null && debe > 0 ? 'Queda debiendo <b class="error">' + plata(debe) + '</b> (pasa a Deudores)' : '') + '</div>' +
        '</div>' : '') +
      (ocasional ? '<label class="nota">Nombre <input type="text" id="nombreOcasional" value="' + esc(S.nombreOcasional) +
        '" placeholder="Opcional, para saber quién fue"></label>' : '') +
      '<label class="nota">Nota <input type="text" id="nota" value="' + esc(S.nota) + '" placeholder="Opcional"></label>' +
      (faltaPaciente ? '<div class="error">Falta elegir la paciente</div>' : '') +
      '<div class="acciones">' +
        (pa
          ? '<button type="button" class="primario grande" id="btnParcial" data-bloqueado="' + (errores || faltaPaciente ? 1 : 0) + '"' +
              (errores || faltaPaciente || errParcial ? ' disabled' : '') + '>' +
              (debe > 0 ? 'Guardar: pagó ' + plata(pa.monto) + ', debe ' + plata(debe) : 'Guardar') + '</button>' +
            '<button type="button" class="link" id="cancelarParcial">no, pagó todo o nada</button>'
          : '<button type="button" class="primario grande" id="btnCobrar"' +
              (errores || faltaPaciente || errPago ? ' disabled' : '') + '>' +
              (total > 0 ? 'Cobrar ' + plata(total) : 'Confirmar') + '</button>' +
            (ocasional ? '<div class="tenue centro">Sin ficha se cobra en el momento: no puede quedar debiendo.</div>'
              : (total > 0 ? '<button type="button" class="secundario" id="btnParcialAbrir"' + (errores || faltaPaciente ? ' disabled' : '') +
                  '>Pagó una parte y debe el resto</button>' : '') +
                '<button type="button" class="secundario" id="btnPendiente"' + (errores || faltaPaciente ? ' disabled' : '') +
                  '>Se fue sin pagar · guardar sin cobrar</button>')) +
      '</div>' +
      (pa && errParcial && !errores && !faltaPaciente ? '<div class="tenue centro">' + esc(errParcial) + '</div>' : '') +
      (!pa && errPago && !errores && !faltaPaciente && total > 0 ? '<div class="tenue centro">' + esc(errPago) + '</div>' : '');
    renderBarraMovil(total);
  }

  function renderBarraMovil(total) {
    const b = $('#barraMovil');
    b.hidden = !S.items.length;
    b.innerHTML = '<span>' + S.items.length + (S.items.length === 1 ? ' ítem' : ' ítems') + ' · <b>' + plata(total) +
      '</b></span><button type="button" class="primario" id="irTicket">Ver y cobrar</button>';
  }

  function limpiarTicket() {
    S.items = [];
    S.pagos = [{ medio: null, monto: null }];
    S.nota = '';
    S.paciente = null;
    S.turno = null;
    S.parcial = null;
    S.nombreOcasional = '';
    $('#buscarPaciente').value = '';
  }

  function payloadItem(it) {
    const o = { tipo: it.tipo, cantidad: it.cantidad, precio_cobrado: it.precio_cobrado };
    if (it.tratamiento_id) o.tratamiento_id = it.tratamiento_id;
    if (it.producto_id) o.producto_id = it.producto_id;
    if (it.pack_id) o.pack_id = it.pack_id;
    if (it.tipo === 'depilacion') { o.sexo = it.sexo; o.zona_ids = it.zona_ids; }
    if (it.profesional_id) o.profesional_id = it.profesional_id;
    if (it.costo_insumo != null) o.costo_insumo = it.costo_insumo;
    return o;
  }

  function nuevaVenta(estado, items, pagos) {
    const p = S.paciente;
    return {
      fecha: S.fecha, paciente_ref: p.ref,
      paciente: { ref: p.ref, nombre: p.nombre, telefono: p.telefono, email: p.email },
      estado, pagos: estado === 'cobrada' ? pagos.filter((x) => Number(x.monto) > 0) : [],
      nota: [esOcasional() && S.nombreOcasional.trim() ? 'Nombre: ' + S.nombreOcasional.trim() : '', S.nota]
        .filter(Boolean).join(' · ') || null,
      items,
      // Turno del dashboard que se cobra: así no vuelve a aparecer.
      turno_ref: S.turno ? S.turno.ref : null,
    };
  }

  function confirmar(estado) {
    const { filas, total } = calcular();
    if (filas.some((f) => f.r.errores.length) || !S.paciente) return;
    if (estado === 'cobrada') {
      const e = validarPagos(S.pagos, total);
      if (e) { toast(e, 'error'); return; }
    }
    if (estado === 'pendiente' && esOcasional()) { toast('Sin ficha no puede quedar debiendo', 'error'); return; }
    // "Pagó una parte": se guarda pendiente con lo que dejó.
    const pa = estado === 'parcial' ? S.parcial : null;
    if (pa) {
      if (!pa.medio || !(Number(pa.monto) > 0) || Number(pa.monto) >= total) { toast('Revisá cuánto pagó', 'error'); return; }
      if (pa.medio === 'transferencia' && !pa.destino) { toast('Elegí a qué cuenta fue la transferencia', 'error'); return; }
      estado = 'pendiente';
    }
    const sinRegla = filas.filter((f) => f.r.sinRegla);
    if (sinRegla.length && !confirm('Sin regla de comisión:\n\n' +
        sinRegla.map((f) => '• ' + f.r.descripcion + ' — ' +
          S.cat.profesionales.find((p) => p.id === f.it.profesional_id).nombre).join('\n') +
        '\n\nSe guarda sin comisión y queda en la lista para que Franco cargue la regla. ¿Seguir?')) return;

    const venta = nuevaVenta(estado, S.items.map(payloadItem), S.pagos.map(pagoPayload));
    if (pa) { venta.entrega = [pagoPayload(pa)]; venta.entrega_id = window.Cola.uuid(); }
    const op = window.Cola.agregar('venta', venta);
    const nombre = esOcasional() ? (S.nombreOcasional.trim() || 'Sin ficha') : S.paciente.nombre;
    const prof = S.items.map((i) => i.profesional_id).find(Boolean);
    if (prof && !(S.usuario && S.usuario.profesional_id)) LS.set('ultimoProf', prof);
    limpiarTicket();
    render();
    toast((pa ? 'Pagó ' + plata(pa.monto) + ' y debe ' + plata(C.r2(total - Number(pa.monto))) + ': '
           : estado === 'cobrada' ? 'Cobrado: ' : 'Guardado sin cobrar: ') + nombre + ' · ' + plata(total) +
          (navigator.onLine ? '' : ' (sin conexión: se sube solo)'), 'ok');
    subir();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return op;
  }

  // Un toque: consume una sesión del pack y la registra ya.
  function usarSesion(packId) {
    const pk = S.cat.packs.find((p) => p.id === packId);
    if (!pk || pk.disponibles <= 0) return;
    const tp = S.cat.tratamientos.find((t) => t.id === pk.tratamiento_id);
    const ts = tp && tp.pack_tratamiento_id ? S.cat.tratamientos.find((t) => t.id === tp.pack_tratamiento_id) : tp;
    const item = { tipo: 'pack_sesion', pack_id: pk.id, cantidad: 1 };
    if (!ts || ts.categoria !== 'cabina') {
      const prof = profDefault();
      if (!prof) { toast('Elegí quién hizo la sesión (en el menú de profesional del ticket)', 'error'); return; }
      item.profesional_id = prof;
    }
    const r = C.calcularItem(S.cat, item, S.fecha);
    if (r.errores.length) { toast(r.errores.join(' · '), 'error'); return; }
    const venta = nuevaVenta('cobrada', [item], []);
    const op = window.Cola.agregar('venta', venta);
    S.turno = null;   // si venía de un turno, la sesión del pack lo cierra
    pk.disponibles--;
    LS.set('catalogo', S.cat);
    render();
    toast(r.descripcion + ' registrada', 'ok', 6000, {
      texto: 'Deshacer',
      accion: () => {
        window.Cola.agregar('anular', { client_id: op.payload.client_id, motivo: 'Sesión cargada por error (deshacer)' });
        pk.disponibles++;
        LS.set('catalogo', S.cat);
        render();
        subir();
        toast('Sesión devuelta al pack', 'ok');
      },
    });
    subir();
  }

  // ------------------------------------------------------------------
  // Paciente
  // ------------------------------------------------------------------
  function buscarPacientes(q) {
    const palabras = norm(q).split(/\s+/).filter(Boolean);
    if (!palabras.length) return [];
    return S.pacientes.filter((p) => { const n = norm(p.nombre); return p.ref !== OCASIONAL && palabras.every((w) => n.includes(w)); })
      .sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, 8);
  }

  function renderPaciente() {
    const box = $('#pacienteElegido');
    $('#pacienteBuscar').hidden = !!S.paciente;
    box.hidden = !S.paciente;
    if (!S.paciente) {
      const q = $('#buscarPaciente').value;
      const res = buscarPacientes(q);
      $('#resultadosPaciente').innerHTML = res.map((p) =>
        '<li><button type="button" data-paciente="' + esc(p.ref) + '"><b>' + esc(p.nombre) + '</b>' +
        (p.telefono ? '<span class="tenue"> · …' + esc(String(p.telefono).slice(-4)) + '</span>' : '') + '</button></li>').join('') +
        (q.trim() && !res.length ? '<li class="tenue">No aparece. Tiene que estar cargada en el dashboard; ' +
          'si la acaban de cargar, esperá unos segundos y buscá de nuevo.</li>' : '') +
        '<li class="sin-ficha"><button type="button" class="secundario" id="sinFicha">No tiene ficha · vino de paso (ej. una cabina)</button></li>';
      if (!$('#pacientesEstado').textContent) $('#pacientesEstado').textContent = S.pacientes.length + ' pacientes';
      return;
    }
    const packs = S.cat ? S.cat.packs.filter((p) => p.paciente_ref === S.paciente.ref && p.disponibles > 0) : [];
    const tr = S.transfiriendo && packs.find((p) => p.id === S.transfiriendo);
    const destinos = tr ? buscarPacientes(S.buscarDestino || '').filter((p) => p.ref !== S.paciente.ref) : [];
    box.innerHTML = '<div class="paciente"><b>' + esc(S.paciente.nombre) + '</b>' +
      '<button type="button" class="link" id="cambiarPaciente">cambiar</button></div>' +
      (packs.length ? '<div class="packs">' + packs.map((p) =>
        '<div><button type="button" class="pack" data-sesion="' + p.id + '"><span>' + esc(p.nombre) + '</span>' +
        '<b>Usar sesión</b><small>' + p.disponibles + ' de ' + p.sesiones_totales + ' disponibles</small></button>' +
        '<button type="button" class="link" data-transferir="' + p.id + '">transferir a otra paciente</button></div>').join('') +
        '</div>' : '') +
      (tr ? '<div class="card" style="margin-top:8px"><b>Transferir ' + esc(tr.nombre) + ' (' + tr.disponibles + ' sesiones)</b>' +
        '<input type="search" id="buscarDestino" placeholder="¿A quién?" value="' + esc(S.buscarDestino || '') + '" autocomplete="off">' +
        '<ul class="resultados">' + destinos.map((p) => '<li><button type="button" data-destino="' + esc(p.ref) + '">' + esc(p.nombre) + '</button></li>').join('') +
        '</ul><button type="button" class="link" id="cancelarTransf">cancelar</button></div>' : '') +
      htmlHistorial();
  }

  // Últimas visitas de la paciente (solo con conexión; es una consulta).
  function htmlHistorial() {
    const h = S.historial;
    if (!h || h.ref !== S.paciente.ref) return '';
    if (h.cargando) return '<div class="historial tenue">Buscando sus últimas visitas…</div>';
    if (!h.ventas.length) return '<div class="historial tenue">Primera vez que se le cobra en el sistema.</div>';
    return '<div class="historial"><b>Últimas visitas</b>' + h.ventas.map((v) =>
      '<div class="linea' + (v.estado === 'anulada' ? ' tenue' : '') + '"><span>' + C.fechaCorta(v.fecha) + ' · ' +
      esc(v.venta_items.map((i) => i.descripcion + quienLoHizo(i.profesional_id)).join(' + ')) + (v.estado === 'pendiente' ? ' <b class="error">sin cobrar</b>' : '') +
      (v.estado === 'anulada' ? ' (anulada)' : '') + '</span><span>' +
      plata(v.venta_items.reduce((a, i) => a + Number(i.precio_cobrado), 0)) + '</span></div>').join('') + '</div>';
  }

  async function cargarHistorial(ref) {
    if (!navigator.onLine) { S.historial = null; return; }
    S.historial = { ref, cargando: true, ventas: [] };
    renderPaciente();
    const { data, error } = await sb.from('ventas').select('id,fecha,estado,venta_items(descripcion,precio_cobrado,profesional_id)')
      .eq('paciente_ref', ref).order('fecha', { ascending: false }).order('id', { ascending: false }).range(0, 5);
    if (!S.historial || S.historial.ref !== ref) return;
    S.historial = error ? null : { ref, ventas: data };
    if (S.paciente && S.paciente.ref === ref) renderPaciente();
  }

  async function transferir(packId, ref) {
    const pk = S.cat.packs.find((p) => p.id === packId);
    const destino = S.pacientes.find((p) => p.ref === ref);
    if (!confirm('¿Pasar las ' + pk.disponibles + ' sesiones de "' + pk.nombre + '" de ' + S.paciente.nombre + ' a ' + destino.nombre +
                 '? No se devuelve plata: es la misma compra.')) return;
    if (!navigator.onLine) { toast('Para transferir hace falta conexión', 'error'); return; }
    const { error } = await sb.rpc('transferir_pack', { p_pack: packId, p_paciente_ref: ref, p_motivo: null });
    if (error) { toast(error.message, 'error'); return; }
    S.transfiriendo = null;
    S.buscarDestino = '';
    toast('Pack transferido a ' + destino.nombre, 'ok');
    await cargarCatalogo().catch(() => {});
    render();
  }

  // ------------------------------------------------------------------
  // Catálogo
  // ------------------------------------------------------------------
  function renderCatalogo() {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('activo', b.dataset.tab === S.tab));
    const el = $('#catalogo');
    if (!S.cat) { el.innerHTML = '<p class="tenue">Cargando catálogo…</p>'; return; }
    const precio = (t) => {
      if (t.precio_variable) return t.precio_min != null ? plata(t.precio_min) + '–' + plata(t.precio_max) : 'a presupuestar';
      const p = C.precioVigente(S.cat, t.id, S.fecha);
      return p == null ? 'sin precio' : plata(p);
    };

    if (S.tab === 'tratamientos') {
      const f = norm(S.filtro);
      const lista = S.cat.tratamientos.filter((t) => t.categoria !== 'cabina' && (!f || norm(t.nombre).includes(f)));
      const cats = [...new Set(lista.map((t) => t.categoria))];
      const boton = (t) => '<button type="button" class="opcion" data-trat="' + t.id + '"><span>' + esc(t.nombre) + '</span><small>' +
        precio(t) + '</small></button>';
      // Los 6 que más se cobran en este navegador, para no buscarlos cada vez.
      const usos = LS.get('usos', {});
      const top = f ? [] : S.cat.tratamientos.filter((t) => usos['t' + t.id] && t.categoria !== 'cabina')
        .sort((a, b) => usos['t' + b.id] - usos['t' + a.id]).slice(0, 6);
      el.innerHTML = '<input type="search" id="filtroTrat" placeholder="Buscar tratamiento…" value="' + esc(S.filtro) + '">' +
        (top.length ? '<h3>Más usados</h3><div class="grilla">' + top.map(boton).join('') + '</div>' : '') +
        cats.map((c) => '<h3>' + esc(c.replace('_', ' ')) + '</h3><div class="grilla">' +
          lista.filter((t) => t.categoria === c).map(boton).join('') + '</div>').join('') +
        (f && !lista.length ? '<p class="tenue">Ningún tratamiento con ese nombre.</p>' : '');
    } else if (S.tab === 'cabina') {
      const lista = S.cat.tratamientos.filter((t) => t.categoria === 'cabina');
      el.innerHTML = (!S.paciente ? '<div class="aviso-cabina"><span>¿Vino de paso y no tiene ficha?</span>' +
          '<button type="button" class="secundario" data-sinficha style="width:auto">Cobrar sin ficha</button></div>' : '') +
        '<div class="grilla">' + lista.map((t) =>
        '<button type="button" class="opcion" data-cabina="' + t.id + '"><span>' + esc(t.nombre) + '</span><small>' +
        precio(t) + (t.pack_sesiones ? ' · ' + t.pack_sesiones + ' sesiones' : '') + '</small></button>').join('') + '</div>' +
        '<p class="tenue">Para usar una sesión de un pack ya comprado, elegí la paciente: aparece arriba.</p>';
    } else if (S.tab === 'productos') {
      const f = norm(S.filtroProd);
      const lista = S.cat.productos.filter((p) => !f || f.split(/\s+/).every((w) => norm(p.nombre + ' ' + (p.laboratorio || '')).includes(w)));
      // "Línea · Producto": se agrupa por la línea; si no tiene, por laboratorio.
      const grupo = (p) => (p.nombre.includes(' · ') ? (p.laboratorio ? p.laboratorio + ' ' : '') + p.nombre.split(' · ')[0] : (p.laboratorio || 'Otros'));
      const grupos = [...new Set(lista.map(grupo))];
      el.innerHTML = S.cat.productos.length
        ? '<input type="search" id="filtroProd" placeholder="Buscar producto o línea…" value="' + esc(S.filtroProd || '') + '">' +
          (!f && lista.length > 24 ? '<p class="tenue">' + lista.length + ' productos. Escribí parte del nombre para encontrarlo rápido.</p>' : '') +
          grupos.map((g) => '<h3>' + esc(g) + '</h3><div class="grilla">' + lista.filter((p) => grupo(p) === g).map((p) =>
            '<button type="button" class="opcion" data-prod="' + p.id + '"><span>' + esc(p.nombre.includes(' · ') ? p.nombre.split(' · ').slice(1).join(' · ') : p.nombre) +
            '</span><small>' + (p.precio_venta == null ? 'sin precio' : plata(p.precio_venta)) + '</small></button>').join('') + '</div>').join('') +
          (f && !lista.length ? '<p class="tenue">Ningún producto con ese nombre.</p>' : '')
        : '<p class="tenue">No hay productos de reventa cargados.</p>';
    } else {
      renderDepilacion(el);
    }
  }

  function renderDepilacion(el) {
    const d = S.depi;
    const zonas = C.zonasVigentes(S.cat, d.sexo, S.fecha).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const promos = S.cat.promos.filter((p) => p.sexo === d.sexo);
    const cot = d.zonas.length ? C.cotizarDepilacion(S.cat, d.zonas, d.sexo, S.fecha) : null;
    const suelto = d.zonas.reduce((a, id) => a + Number((S.cat.zonas.find((z) => z.id === id) || {}).precio || 0), 0);
    el.innerHTML =
      '<div class="sexo">' + ['mujer', 'hombre'].map((s) =>
        '<button type="button" data-sexo="' + s + '" class="' + (d.sexo === s ? 'activo' : '') + '">' +
        (s === 'mujer' ? 'Mujer' : 'Hombre') + '</button>').join('') + '</div>' +
      '<h3>Promos</h3><div class="grilla">' + promos.map((p) => {
        const zs = S.cat.promoZonas.filter((x) => x.promo_id === p.id)
          .map((x) => S.cat.zonas.find((z) => z.id === x.zona_id)).filter(Boolean);
        return '<button type="button" class="opcion' + (cot && cot.promo && cot.promo.id === p.id ? ' activo' : '') +
          '" data-promo="' + p.id + '"><span>' + esc(p.nombre) + '</span><small>' + esc(zs.map((z) => z.nombre).join(' + ')) +
          ' · ' + plata(p.precio_fijado) + '</small></button>';
      }).join('') + '</div>' +
      '<h3>Zonas</h3><div class="zonas">' + zonas.map((z) =>
        '<label class="zona"><input type="checkbox" data-zona="' + z.id + '"' + (d.zonas.includes(z.id) ? ' checked' : '') +
        '> ' + esc(z.nombre) + ' <small>' + plata(z.precio) + '</small></label>').join('') + '</div>' +
      '<div class="cotizacion">' + (cot
        ? (cot.promo ? '<b>' + esc(cot.promo.nombre) + '</b>: ' : 'Combinación libre: ') + '<b>' + plata(cot.precio) + '</b>' +
          (suelto !== cot.precio ? ' <span class="tenue">(sueltas ' + plata(suelto) + ')</span>' : '') +
          '<button type="button" class="primario" id="agregarDepi">Agregar</button>'
        : '<span class="tenue">Tocá una promo o marcá las zonas.</span>') + '</div>';
  }

  // ------------------------------------------------------------------
  // Bandeja "sin cobrar" y cargado hoy
  // ------------------------------------------------------------------
  function ventasEnCola() {
    return window.Cola.leer().filter((o) => o.tipo === 'venta').map((o) => ({
      client_id: o.payload.client_id, fecha: o.payload.fecha, estado: o.payload.estado, paciente_ref: o.payload.paciente_ref,
      pacienteNombre: o.payload.paciente ? o.payload.paciente.nombre : o.payload.paciente_ref,
      descripcion: o.payload.items.map((i) => descItem(i) + quienLoHizo(i.profesional_id)).join(' + '),
      total: o.payload.items.reduce((a, i) => a + (i.tipo === 'pack_sesion' ? 0 : Number(i.precio_cobrado) || 0), 0) -
             (o.payload.entrega || []).reduce((a, p) => a + Number(p.monto), 0),
      pagos: o.payload.estado === 'pendiente' ? (o.payload.entrega || []) : (o.payload.pagos || []),
      enCola: true, error: o.error,
    }));
  }

  // " (Yael)": quién hizo el ítem, para ver de un vistazo si se cargó bien.
  function quienLoHizo(profId) {
    if (!profId || !S.cat) return '';
    const p = S.cat.profesionales.find((x) => x.id === profId);
    return p ? ' (' + p.nombre.split(' ')[0] + ')' : '';
  }

  function descItem(i) {
    if (!S.cat) return i.tipo;
    try { return C.calcularItem(S.cat, i, S.fecha).descripcion || i.tipo; } catch (e) { return i.tipo; }
  }

  const deServidor = (v) => ({
    id: v.id, client_id: v.client_id, fecha: v.fecha, estado: v.estado, medio: v.medio_pago, paciente_ref: v.paciente_ref,
    pacienteNombre: v.paciente_ref === OCASIONAL
      ? ((/Nombre: ([^·|]+)/.exec(v.nota || '') || [])[1] || '').trim().concat(' (sin ficha)').trim()
      : v.pacientes ? v.pacientes.nombre : v.paciente_ref,
    descripcion: v.venta_items.map((i) => i.descripcion + quienLoHizo(i.profesional_id)).join(' + '),
    // En una deuda con pagos a cuenta, lo que falta (lo que se cobra ahora).
    total: v.venta_items.reduce((a, i) => a + Number(i.precio_cobrado), 0) -
           (v.estado === 'pendiente' ? (v.venta_pagos || []).reduce((a, p) => a + Number(p.monto), 0) : 0),
    pagos: v.venta_pagos || [], nota: v.nota, a_deudores: !!v.a_deudores_en,
  });

  function operacionesSobre(v) {
    return window.Cola.leer().filter((o) => (o.tipo === 'cobrar' || o.tipo === 'anular' || o.tipo === 'a_deudores') &&
      ((v.id && o.payload.venta_id === v.id) || (v.client_id && o.payload.client_id === v.client_id)));
  }

  function renderBandeja() {
    const el = $('#bandeja');
    const cola = ventasEnCola().filter((v) => v.estado === 'pendiente');
    // Las que se pasaron a deudores no molestan acá: siguen en Deudores.
    const srv = S.pendientes.map(deServidor).filter((v) => !v.a_deudores && !cola.some((c) => c.client_id === v.client_id));
    const lista = cola.concat(srv).filter((v) => !operacionesSobre(v).length);
    el.hidden = !lista.length;
    if (!lista.length) return;
    el.innerHTML = '<div class="titulo-fila"><h2>Sin cobrar (' + lista.length + ')</h2><a href="deudores.html">ver todos los deudores</a></div>' + lista.map((v) => {
      const key = v.id ? 'id:' + v.id : 'c:' + v.client_id;
      const abierto = S.cobrandoPendiente === key;
      if (abierto) ajustarPagos(S.pagosPendiente, C.r2(v.total));
      return '<div class="pend">' +
        '<div class="pend-top"><div><b>' + esc(v.pacienteNombre) + '</b> · ' + esc(v.descripcion) +
        '<div class="tenue">' + (v.fecha === hoy() ? 'hoy' : C.fechaCorta(v.fecha)) + (v.enCola ? ' · sin sincronizar' : '') +
        '</div></div><b>' + plata(v.total) + '</b></div>' +
        (abierto
          ? '<div class="pagos">' + htmlPagos(S.pagosPendiente, v.total, 'b', v.paciente_ref) + '</div>' +
            '<div class="acciones fila"><button type="button" class="primario" data-cobrarpend="' + key + '">Cobrar ' +
            plata(v.total) + '</button><button type="button" class="link" data-cerrarpend>cancelar</button></div>'
          : '<div class="acciones fila"><button type="button" class="primario" data-abrirpend="' + key + '">Cobrar</button>' +
            '<button type="button" class="secundario" style="width:auto" data-adeudores="' + key + '">Pasar a deudores</button>' +
            '<button type="button" class="link" data-anular="' + key + '">anular</button></div>') +
        '</div>';
    }).join('');
  }

  // ------------------------------------------------------------------
  // Turnos atendidos en el dashboard que todavía no se cobraron
  // ------------------------------------------------------------------
  const horaTurno = (h) => (Number.isFinite(h) ? String(Math.floor(h)).padStart(2, '0') + ':' + (h % 1 ? '30' : '00') : '—');

  function turnosSinCobrar() {
    if (S.turnos.fecha !== S.fecha) return [];
    const enCola = new Set(window.Cola.leer().filter((o) => o.tipo === 'venta' && o.payload.turno_ref).map((o) => o.payload.turno_ref));
    const fuera = new Set(S.turnos.cobrados.concat(S.turnos.descartados || []));
    return S.turnos.lista.filter((t) => !fuera.has(t.ref) && !enCola.has(t.ref));
  }

  function renderTurnos() {
    const el = $('#turnos');
    const lista = turnosSinCobrar();
    el.hidden = !lista.length && !S.turnosError;
    if (el.hidden) return;
    const profs = S.cat ? S.cat.profesionales : [];
    el.innerHTML = '<div class="titulo-fila"><h2>Atendidas en el dashboard, sin cobrar (' + lista.length + ')</h2>' +
      '<button type="button" class="link" id="recargarTurnos">actualizar</button></div>' +
      (S.turnosError ? '<p class="error">' + esc(S.turnosError) + '</p>' : '') +
      lista.map((t) => {
        const p = window.Turnos.profesional(t.prof, profs);
        const actual = S.turno && S.turno.ref === t.ref;
        return '<div class="pend"><div class="pend-top"><div><b>' + esc(t.nom || '(sin nombre)') + '</b> · ' + esc(t.tr || '—') +
          '<div class="tenue">' + horaTurno(t.hora) + (p ? ' · ' + esc(p.nombre) : '') + (t.obs ? ' · ' + esc(t.obs) : '') + '</div></div>' +
          (actual ? '<span class="tenue">en el ticket</span>'
                  : '<div class="fila" style="flex-wrap:nowrap"><button type="button" class="primario" data-turno="' + esc(t.ref) + '">Cobrar</button>' +
                    '<button type="button" class="link" data-sacarturno="' + esc(t.ref) + '" title="Ya se cobró por otro lado, o no se cobra">quitar</button></div>') +
          '</div></div>';
      }).join('');
  }

  // Sacar un turno de la lista (ya se cobró por otro lado, o no se cobra).
  // Queda guardado en la base para todos; no toca el dashboard.
  async function sacarTurno(ref) {
    const t = S.turnos.lista.find((x) => x.ref === ref);
    const motivo = prompt('¿Sacar a ' + (t ? t.nom : 'este turno') + ' de la lista? Contá por qué (opcional):', 'Ya se cobró');
    if (motivo === null) return;
    if (!navigator.onLine) { toast('Para sacarlo de la lista hace falta conexión', 'error'); return; }
    const { error } = await sb.rpc('descartar_turno', { p_ref: ref, p_motivo: motivo });
    if (error) { toast(/descartar_turno/.test(error.message || '') ? 'Falta correr 11_cobros_directos.sql en Supabase' : error.message, 'error'); return; }
    S.turnos.descartados = (S.turnos.descartados || []).concat(ref);
    if (S.turno && S.turno.ref === ref) S.turno = null;
    LS.set('turnos', S.turnos);
    render();
    toast('Sacado de la lista', 'ok', 6000, {
      texto: 'Deshacer',
      accion: async () => {
        const r = await sb.rpc('restaurar_turno', { p_ref: ref });
        if (r.error) { toast(r.error.message, 'error'); return; }
        S.turnos.descartados = S.turnos.descartados.filter((x) => x !== ref);
        LS.set('turnos', S.turnos);
        render();
      },
    });
  }

  // Un toque: arma el ticket con lo que dice el turno. Lo que no se puede
  // saber con seguridad (zonas de depilación, cuál "Facial") lo elige
  // quien cobra; nunca se inventa un precio.
  function usarTurno(ref) {
    const t = S.turnos.lista.find((x) => x.ref === ref);
    if (!t || !S.cat) return;
    if (S.items.length && !confirm('El ticket tiene cosas cargadas. ¿Reemplazarlas por el turno de ' + t.nom + '?')) return;
    S.items = [];
    S.pagos = [{ medio: null, monto: null }];
    S.nota = '';
    S.transfiriendo = null;
    const prof = window.Turnos.profesional(t.prof, S.cat.profesionales);
    S.turno = Object.assign({}, t, { profesional_id: prof ? prof.id : null, profNombre: prof ? prof.nombre : null, aviso: null });

    const m = window.Turnos.paciente(t, S.pacientes);
    S.paciente = m.paciente || null;
    $('#buscarPaciente').value = m.paciente ? '' : t.nom;
    if (S.paciente) cargarHistorial(S.paciente.ref);

    const trat = window.Turnos.tratamiento(t, S.cat.tratamientos);
    const avisos = [];
    if (!m.paciente) avisos.push(m.opciones.length ? 'Hay ' + m.opciones.length + ' pacientes con ese nombre: elegí cuál en el paso 1.'
                                                  : 'No se encontró la paciente por el nombre: buscala en el paso 1.');
    if (!prof && t.prof !== 'otro') avisos.push('No se reconoció la profesional del turno: elegila en el ticket.');
    if (trat) {
      agregarItem({ tipo: 'tratamiento', tratamiento_id: trat.id, profesional_id: profDefault() });
    } else if (window.Turnos.esDepilacion(t)) {
      S.tab = 'depilacion';
      avisos.push('Marcá las zonas de depilación en el paso 2.');
    } else {
      S.tab = 'tratamientos';
      S.filtro = '';
      avisos.push('"' + (t.tr || 'sin tratamiento') + '" no está con ese nombre en la lista de precios: elegí el tratamiento en el paso 2.');
    }
    S.turno.aviso = avisos.join(' ');
    render();
    (S.paciente ? (trat ? $('#ticketCard') : $('#catalogo')) : $('#buscarPaciente')).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderHoy() {
    $('#tituloHoy').textContent = S.fecha === hoy() ? 'Cargado hoy' : 'Cargado el ' + C.fechaCorta(S.fecha);
    const cola = ventasEnCola().filter((v) => v.fecha === S.fecha);
    const srv = S.ventasHoy.map(deServidor).filter((v) => !cola.some((c) => c.client_id === v.client_id));
    const lista = cola.concat(srv);
    const el = $('#hoy');
    if (!lista.length) { el.innerHTML = '<p class="tenue">Todavía nada.</p>'; return; }
    // Lo que recibió directo una profesional no entró a MEK: va aparte.
    // Con gift card tampoco es plata nueva: entró cuando se vendió.
    const fuera = (p) => !!p.profesional_id || p.medio === 'giftcard';
    const sumaPagos = (v, f) => (v.pagos || []).filter(f).reduce((s, p) => s + Number(p.monto), 0);
    const validas = lista.filter((v) => v.estado !== 'anulada');
    const directo = validas.reduce((a, v) => a + sumaPagos(v, (p) => !!p.profesional_id), 0);
    const pagadoGift = validas.reduce((a, v) => a + sumaPagos(v, (p) => p.medio === 'giftcard'), 0);
    const cobrado = validas.filter((v) => v.estado === 'cobrada').reduce((a, v) => a + v.total - sumaPagos(v, fuera), 0) +
      validas.filter((v) => v.estado === 'pendiente').reduce((a, v) => a + sumaPagos(v, (p) => !fuera(p)), 0);
    // Las anuladas no suman en nada (caja, comisiones, liquidaciones):
    // quedan guardadas solo como registro, plegadas al final.
    const fila = (v) => {
        const ops = operacionesSobre(v);
        const anulando = ops.some((o) => o.tipo === 'anular');
        const estado = anulando ? 'anulando…' : v.estado;
        const key = v.id ? 'id:' + v.id : 'c:' + v.client_id;
        const profs = S.cat ? S.cat.profesionales : [];
        const unPago = (p) => nombreMedio(p.medio) + (window.MEK.textoDestino(p, profs) ? ' ' + window.MEK.textoDestino(p, profs) : '');
        const pagos = v.pagos && v.pagos.length > 1 ? v.pagos.map((p) => unPago(p) + ' ' + plata(p.monto)).join(' + ')
          : v.pagos && v.pagos.length === 1 ? unPago(v.pagos[0])
          : (v.medio ? nombreMedio(v.medio) : '');
        return '<div class="hoy ' + esc(v.estado) + (anulando ? ' anulada' : '') + '">' +
          '<div><b>' + esc(v.pacienteNombre) + '</b> · ' + esc(v.descripcion) +
          '<div class="tenue">' + esc(estado) + (pagos ? ' · ' + esc(pagos) : '') +
          (v.enCola ? ' · <span class="sin-sync">' + (v.error ? 'error' : 'sin sincronizar') + '</span>' : '') + '</div></div>' +
          '<div class="der"><b>' + plata(v.total) + '</b>' +
          (v.estado !== 'anulada' && !anulando ? '<button type="button" class="link" data-anular="' + key + '">anular</button>' : '') +
          '</div></div>';
    };
    const anuladas = lista.filter((v) => v.estado === 'anulada');
    el.innerHTML = '<div class="tenue">Cobrado (bruto, caja): <b>' + plata(C.r2(cobrado)) + '</b>' +
      (directo ? ' · cobrado directo por profesionales: <b>' + plata(C.r2(directo)) + '</b>' : '') +
      (pagadoGift ? ' · con gift card: <b>' + plata(C.r2(pagadoGift)) + '</b>' : '') + '</div>' +
      lista.filter((v) => v.estado !== 'anulada').map(fila).join('') +
      (anuladas.length ? '<details class="anuladas"><summary>' + anuladas.length + (anuladas.length === 1 ? ' anulada' : ' anuladas') +
        ' (no cuentan para nada, quedan solo como registro)</summary>' + anuladas.map(fila).join('') + '</details>' : '');
  }

  function renderSync() {
    const ops = window.Cola.leer();
    const errores = ops.filter((o) => o.error).length;
    const b = $('#sync');
    b.className = 'sync' + (errores ? ' mal' : ops.length ? ' espera' : ' ok') + (navigator.onLine ? '' : ' offline');
    b.textContent = errores ? errores + (errores === 1 ? ' operación con error' : ' operaciones con error')
      : ops.length ? ops.length + (ops.length === 1 ? ' operación sin sincronizar' : ' operaciones sin sincronizar')
      : '✓ Todo sincronizado';
    if (!navigator.onLine) b.textContent = 'Sin conexión · ' + b.textContent;
    if (S.sinRegla) b.textContent += ' · ' + S.sinRegla + ' sin regla de comisión';
  }

  function renderAvisoFecha() {
    const a = $('#avisoFecha');
    a.hidden = S.fecha === hoy();
    a.textContent = 'Estás cargando con fecha ' + C.fechaCorta(S.fecha) + ', no la de hoy.';
  }

  function render() {
    if (!S.usuario) return;
    renderAvisoFecha();
    renderSync();
    renderTurnos();
    renderBandeja();
    renderPaciente();
    renderCatalogo();
    renderTicket();
    renderHoy();
  }

  function renderDlgCola() {
    const d = $('#dlgCola');
    const ops = window.Cola.leer();
    d.innerHTML = '<h2>Operaciones guardadas en este navegador</h2>' +
      (ops.length ? ops.map((o) => '<div class="op"><div><b>' + esc(o.tipo) + '</b> · ' +
        esc(new Date(o.creado).toLocaleString('es-AR')) +
        (o.tipo === 'venta' ? ' · ' + esc(o.payload.paciente ? o.payload.paciente.nombre : o.payload.paciente_ref) : '') +
        (o.error ? '<div class="error">' + esc(o.error) + '</div>'
          : '<div class="tenue">esperando para subir (' + o.intentos + ' intentos)' +
            (o.ultimo && o.intentos ? ' · último motivo: ' + esc(o.ultimo) : '') + '</div>') +
        '</div>' + (o.error ? '<div class="fila"><button type="button" data-reintentar="' + o.id + '">Reintentar</button>' +
        '<button type="button" class="link peligro" data-descartar="' + o.id + '">descartar</button></div>' : '') +
        '</div>').join('') : '<p class="tenue">No hay nada pendiente.</p>') +
      (S.sinRegla ? '<h3 style="margin-top:14px">Cobros sin regla de comisión (' + S.sinRegla + ')</h3>' +
        '<p class="tenue">Se guardaron sin comisión porque cuando se cobraron no había regla para esa profesional y ese tratamiento.</p>' +
        S.sinReglaLista.slice(0, 15).map((x) => '<div class="op"><div>' + C.fechaCorta(x.fecha) + ' · ' + esc(x.descripcion) +
          ' · <b>' + esc(x.profesional) + '</b></div></div>').join('') +
        (S.sinRegla > 15 ? '<p class="tenue">…y ' + (S.sinRegla - 15) + ' más.</p>' : '') +
        '<div class="fila"><button type="button" id="resolverSinRegla" class="primario">Recalcular con las reglas de ahora</button>' +
        '<a href="catalogo.html#comisiones">cargar una regla</a></div>' : '') +
      '<div class="acciones fila"><button type="button" id="subirAhora" class="primario">Subir ahora</button>' +
      '<button type="button" id="cerrarDlg">Cerrar</button></div>';
  }

  // ------------------------------------------------------------------
  // Eventos
  // ------------------------------------------------------------------
  let refrescoPendiente = null;
  async function subir() {
    const antes = window.Cola.leer().length;
    await window.Cola.procesar(sb);
    await refrescarSiCambio(antes);
  }
  async function refrescarSiCambio(antes) {
    if (antes !== undefined && window.Cola.leer().length === antes) { renderSync(); return; }
    clearTimeout(refrescoPendiente);
    refrescoPendiente = setTimeout(async () => {
      try { await Promise.all([cargarVentas(), cargarPacks(), marcarCobrados(), cargarGiftcards()]); } catch (e) { /* se reintenta en el próximo ciclo */ }
      render();
    }, 300);
  }

  function buscarVentaKey(key) {
    const [t, v] = key.split(/:(.+)/);
    return t === 'id' ? { venta_id: Number(v) } : { client_id: v };
  }

  function buscarVentaPend(key) {
    if (!key) return null;
    const k = buscarVentaKey(key);
    return ventasEnCola().concat(S.pendientes.map(deServidor))
      .find((x) => (k.venta_id && x.id === k.venta_id) || (k.client_id && x.client_id === k.client_id)) || null;
  }

  function totalDeKey(key) {
    const k = buscarVentaKey(key);
    const v = ventasEnCola().concat(S.pendientes.map(deServidor))
      .find((x) => (k.venta_id && x.id === k.venta_id) || (k.client_id && x.client_id === k.client_id));
    return v ? C.r2(v.total) : 0;
  }

  function onClick(ev) {
    const t = ev.target.closest('button, [data-paciente]');
    if (!t) return;
    const d = t.dataset;

    if (d.paciente) {
      S.paciente = S.pacientes.find((p) => p.ref === d.paciente);
      S.transfiriendo = null;
      render();
      cargarHistorial(S.paciente.ref);
      return;
    }
    if (t.id === 'sinFicha' || d.sinficha !== undefined) {
      S.paciente = S.pacientes.find((p) => p.ref === OCASIONAL) || { ref: OCASIONAL, nombre: 'Sin ficha (ocasional)', telefono: null, email: null };
      S.transfiriendo = null;
      S.historial = null;
      render();
      return;
    }
    if (t.id === 'btnParcialAbrir') { S.parcial = { medio: null, monto: null }; renderTicket(); $('#parcialMonto').focus(); return; }
    if (t.id === 'cancelarParcial') { S.parcial = null; renderTicket(); return; }
    if (d.pmedio) {
      S.parcial.medio = d.pmedio;
      if (S.parcial.destino && !S.parcial.destino.startsWith('p:') && d.pmedio !== 'transferencia') S.parcial.destino = '';
      renderTicket();
      return;
    }
    if (t.id === 'btnParcial') { confirmar('parcial'); return; }
    if (d.turno) { usarTurno(d.turno); return; }
    if (d.sacarturno) { sacarTurno(d.sacarturno); return; }
    if (d.soltarturno !== undefined) { S.turno = null; render(); return; }
    if (t.id === 'recargarTurnos') { cargarTurnos().then(render); return; }
    if (t.id === 'cambiarPaciente') { S.paciente = null; S.transfiriendo = null; render(); $('#buscarPaciente').focus(); return; }
    if (d.transferir) { S.transfiriendo = Number(d.transferir); S.buscarDestino = ''; renderPaciente(); $('#buscarDestino').focus(); return; }
    if (t.id === 'cancelarTransf') { S.transfiriendo = null; renderPaciente(); return; }
    if (d.destino) { transferir(S.transfiriendo, d.destino); return; }
    if (d.sesion) { usarSesion(Number(d.sesion)); return; }
    if (d.tab) { S.tab = d.tab; renderCatalogo(); return; }

    if (d.trat) {
      const usos = LS.get('usos', {});
      usos['t' + d.trat] = (usos['t' + d.trat] || 0) + 1;
      LS.set('usos', usos);
      agregarItem({ tipo: 'tratamiento', tratamiento_id: Number(d.trat), profesional_id: profDefault() });
      return;
    }
    if (d.cabina) {
      const tr = S.cat.tratamientos.find((x) => x.id === Number(d.cabina));
      if (tr.pack_sesiones && esOcasional()) { toast('La promo tiene que quedar a nombre de alguien con ficha: buscá a la paciente en el paso 1', 'error', 6000); return; }
      agregarItem({ tipo: tr.pack_sesiones ? 'pack_venta' : 'cabina', tratamiento_id: tr.id });
      return;
    }
    if (d.prod) { agregarItem({ tipo: 'producto', producto_id: Number(d.prod) }); return; }

    if (d.sexo) { S.depi = { sexo: d.sexo, zonas: [] }; renderCatalogo(); return; }
    if (d.promo) {
      S.depi.zonas = S.cat.promoZonas.filter((x) => x.promo_id === Number(d.promo))
        .map((x) => C.zonaVigente(S.cat, x.zona_id, S.fecha)).filter(Boolean).map((z) => z.id);
      renderCatalogo();
      return;
    }
    if (t.id === 'agregarDepi') {
      agregarItem({ tipo: 'depilacion', sexo: S.depi.sexo, zona_ids: S.depi.zonas.slice(), profesional_id: profDefault() });
      S.depi.zonas = [];
      renderCatalogo();
      return;
    }

    if (d.quitar) { S.items = S.items.filter((i) => i.uid !== Number(d.quitar)); render(); return; }
    if (d.costo) {
      const it = S.items.find((i) => i.uid === Number(d.costo));
      const v = prompt('Costo de insumo de este ítem (vacío = sin dato):', it.costo_insumo == null ? '' : it.costo_insumo);
      if (v === null) return;
      it.costo_insumo = v.trim() === '' ? null : Math.max(0, Number(v.replace(',', '.')) || 0);
      renderTicket();
      return;
    }

    // pagos del ticket (prefijo t) y de la bandeja (prefijo b)
    for (const [pre, lista] of [['t', S.pagos], ['b', S.pagosPendiente]]) {
      if (d[pre + 'medio'] !== undefined) {
        const pg = lista[Number(d[pre + 'medio'])];
        pg.medio = d.valor;
        // Las cuentas (alias/QR) son solo de transferencias.
        if (pg.destino && !pg.destino.startsWith('p:') && d.valor !== 'transferencia') pg.destino = '';
        if (d.valor === 'giftcard') {
          pg.destino = '';
          // Si la paciente tiene una sola gift card, va esa.
          const ref = pre === 't' ? S.paciente && S.paciente.ref : (buscarVentaPend(S.cobrandoPendiente) || {}).paciente_ref;
          const suyas = S.giftcards.filter((g) => g.paciente_ref && g.paciente_ref === ref);
          if (!pg.gift && suyas.length === 1) pg.gift = suyas[0].id;
        } else pg.gift = null;
        pre === 't' ? renderTicket() : renderBandeja();
        return;
      }
      if (d[pre + 'dividir'] !== undefined) {
        if (lista.length === 1) lista[0].monto = null;
        lista.push({ medio: null, monto: null });
        pre === 't' ? renderTicket() : renderBandeja();
        return;
      }
      if (d[pre + 'sacar'] !== undefined) {
        lista.splice(Number(d[pre + 'sacar']), 1);
        pre === 't' ? renderTicket() : renderBandeja();
        return;
      }
    }

    if (t.id === 'btnCobrar') { confirmar('cobrada'); return; }
    if (t.id === 'btnPendiente') { confirmar('pendiente'); return; }
    if (t.id === 'irTicket') { $('#ticketCard').scrollIntoView({ behavior: 'smooth' }); return; }

    if (d.abrirpend) { S.cobrandoPendiente = d.abrirpend; S.pagosPendiente = [{ medio: null, monto: null }]; renderBandeja(); return; }
    if (d.cerrarpend !== undefined) { S.cobrandoPendiente = null; renderBandeja(); return; }
    if (d.cobrarpend) {
      const total = totalDeKey(d.cobrarpend);
      ajustarPagos(S.pagosPendiente, total);
      const e = validarPagos(S.pagosPendiente, total);
      if (e) { toast(e, 'error'); return; }
      const pagos = S.pagosPendiente.map(pagoPayload);
      const k = buscarVentaKey(d.cobrarpend);
      if (!(k.client_id && window.Cola.cobrarEnCola(k.client_id, pagos))) {
        window.Cola.agregar('cobrar', Object.assign(k, { pagos }));
      }
      S.cobrandoPendiente = null;
      render();
      toast('Cobrado ' + plata(total), 'ok');
      subir();
      return;
    }
    if (d.adeudores) {
      window.Cola.agregar('a_deudores', buscarVentaKey(d.adeudores));
      render();
      subir();
      toast('Pasó a Deudores: ya no aparece acá', 'ok', 4000, { texto: 'Ver deudores', accion: () => { location.href = 'deudores.html'; } });
      return;
    }
    if (d.anular) {
      const motivo = prompt('¿Por qué se anula? (queda registrado; la venta no se borra)');
      if (!motivo || !motivo.trim()) return;
      window.Cola.agregar('anular', Object.assign(buscarVentaKey(d.anular), { motivo: motivo.trim() }));
      render();
      subir();
      return;
    }

    if (t.id === 'sync') { renderDlgCola(); $('#dlgCola').showModal(); return; }
    if (t.id === 'cerrarDlg') { $('#dlgCola').close(); return; }
    if (t.id === 'resolverSinRegla') {
      sb.rpc('resolver_items_sin_regla').then(async ({ data, error }) => {
        if (error) { toast(error.message, 'error'); return; }
        toast(data.resueltos + ' recalculado(s)' + (data.quedan ? '; quedan ' + data.quedan + ' sin regla: falta cargarles la regla' : ''), data.quedan ? 'error' : 'ok', 7000);
        await cargarVentas().catch(() => {});
        renderDlgCola(); renderSync();
      });
      return;
    }
    if (t.id === 'subirAhora') { subir().then(() => { renderDlgCola(); }); return; }
    if (d.reintentar) { window.Cola.reintentar(d.reintentar); subir().then(renderDlgCola); return; }
    if (d.descartar) {
      if (confirm('Esta operación NO está en la base. Si la descartás, se pierde. ¿Descartar?') &&
          confirm('¿Seguro? Anotá los datos antes si hace falta.')) {
        window.Cola.quitar(d.descartar);
        renderDlgCola();
        render();
      }
      return;
    }

    if (t.id === 'menuBtn') { $('#menu').hidden = !$('#menu').hidden; return; }
    if (t.id === 'salir') { $('#menu').hidden = true; salir(); return; }
    if (t.id === 'recargarCatalogo') { $('#menu').hidden = true; refrescar().then(() => toast('Catálogo actualizado', 'ok')); return; }
    if (t.id === 'syncPacientes') {
      $('#menu').hidden = true;
      sincronizarPacientes(true).then(render);
      return;
    }
  }

  function onInput(ev) {
    const t = ev.target;
    const d = t.dataset;
    if (t.id === 'buscarPaciente') { renderPaciente(); return; }
    if (t.id === 'buscarDestino') {
      S.buscarDestino = t.value;
      renderPaciente();
      const f = $('#buscarDestino'); f.focus(); f.setSelectionRange(f.value.length, f.value.length);
      return;
    }
    if (t.id === 'filtroTrat' || t.id === 'filtroProd') {
      S[t.id === 'filtroTrat' ? 'filtro' : 'filtroProd'] = t.value;
      renderCatalogo();
      const f = $('#' + t.id); f.focus(); f.setSelectionRange(f.value.length, f.value.length);
      return;
    }
    if (t.id === 'nota') { S.nota = t.value; return; }
    if (t.id === 'nombreOcasional') { S.nombreOcasional = t.value; return; }
    if (d.tdestino !== undefined) { S.pagos[Number(d.tdestino)].destino = t.value; renderTicket(); return; }
    if (d.tgift !== undefined) { S.pagos[Number(d.tgift)].gift = t.value ? Number(t.value) : null; renderTicket(); return; }
    if (d.bgift !== undefined) { S.pagosPendiente[Number(d.bgift)].gift = t.value ? Number(t.value) : null; renderBandeja(); return; }
    if (d.bdestino !== undefined) { S.pagosPendiente[Number(d.bdestino)].destino = t.value; renderBandeja(); return; }
    if (t.id === 'parcialDestino') { S.parcial.destino = t.value; renderTicket(); return; }
    if (t.id === 'parcialMonto') {
      // Se actualiza en el lugar, sin redibujar: si no, el clic en
      // "Guardar" justo después de escribir se pierde.
      S.parcial.monto = t.value.trim() === '' ? null : Math.max(0, Number(t.value.replace(',', '.')) || 0);
      const total = calcular().total;
      const debe = C.r2(total - (Number(S.parcial.monto) || 0));
      const ok = S.parcial.medio && Number(S.parcial.monto) > 0 && debe > 0 &&
        !(S.parcial.medio === 'transferencia' && !S.parcial.destino);
      $('#parcialDebe').innerHTML = Number(S.parcial.monto) > 0 && debe > 0
        ? 'Queda debiendo <b class="error">' + plata(debe) + '</b> (pasa a Deudores)'
        : Number(S.parcial.monto) > 0 ? '<span class="error">Si pagó todo, usá "Cobrar"</span>' : '';
      const b = $('#btnParcial');
      b.disabled = !ok || b.dataset.bloqueado === '1';
      b.textContent = ok ? 'Guardar: pagó ' + plata(S.parcial.monto) + ', debe ' + plata(debe) : 'Guardar';
      return;
    }
    if (d.zona) {
      const id = Number(d.zona);
      S.depi.zonas = t.checked ? S.depi.zonas.concat(id) : S.depi.zonas.filter((z) => z !== id);
      renderCatalogo();
      return;
    }
    if (d.prof) {
      S.items.find((i) => i.uid === Number(d.prof)).profesional_id = t.value ? Number(t.value) : null;
      renderTicket();
      return;
    }
    // Precio, cantidad y montos de pago: se recalcula al salir del campo
    // (en 'change') para no perder el foco mientras se escribe.
  }

  function onChange(ev) {
    const t = ev.target;
    const d = t.dataset;
    const n = (v) => (v.trim() === '' ? null : Math.max(0, Number(v.replace(',', '.'))));
    if (t.id === 'fecha') {
      S.fecha = t.value || hoy();
      render();
      if (navigator.onLine) cargarVentas().then(render).catch(() => {});
      if (S.turno) S.turno = null;
      cargarTurnos().then(render);
      return;
    }
    if (d.precio) { S.items.find((i) => i.uid === Number(d.precio)).precio_cobrado = n(t.value); renderTicket(); return; }
    if (d.cant) {
      const it = S.items.find((i) => i.uid === Number(d.cant));
      const antes = precioLista(it);
      it.cantidad = Math.max(1, Math.round(Number(t.value) || 1));
      // si el precio no se había tocado, sigue al de lista
      if (it.precio_cobrado === antes) it.precio_cobrado = precioLista(it);
      renderTicket();
      return;
    }
    if (d.tmonto !== undefined) { S.pagos[Number(d.tmonto)].monto = n(t.value); renderTicket(); return; }
    if (d.bmonto !== undefined) { S.pagosPendiente[Number(d.bmonto)].monto = n(t.value); renderBandeja(); return; }
  }

  let toastTimer = null;
  function toast(texto, tipo, ms, boton) {
    const t = $('#toast');
    t.className = 'toast ' + (tipo || '');
    t.innerHTML = '<span>' + esc(texto) + '</span>' + (boton ? '<button type="button" id="toastBtn">' + esc(boton.texto) + '</button>' : '');
    t.hidden = false;
    if (boton) $('#toastBtn').onclick = () => { t.hidden = true; boton.accion(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (tipo === 'error' ? 6000 : 3500));
  }

  // ------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------
  async function iniciar() {
    $('#fecha').value = S.fecha;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    $('#loginForm').addEventListener('submit', entrar);
    window.Cola.alCambiar(() => renderSync());
    window.addEventListener('online', () => { renderSync(); refrescar(); });
    window.addEventListener('offline', renderSync);
    setInterval(() => { if (window.Cola.leer().length) subir(); }, 20000);
    // Turnos recién marcados "Atendida" en el dashboard: cada 2 minutos y
    // al volver a esta pestaña.
    setInterval(() => { if (S.usuario && !document.hidden) cargarTurnos().then(renderTurnos); }, 120000);
    document.addEventListener('visibilitychange', () => { if (S.usuario && !document.hidden) cargarTurnos().then(renderTurnos); });
    // Si la app queda abierta de un día para el otro, la fecha avanza sola
    // (salvo que alguien la haya cambiado a mano).
    let ultimoHoy = hoy();
    setInterval(() => {
      if (hoy() !== ultimoHoy) {
        if (S.fecha === ultimoHoy) { S.fecha = hoy(); $('#fecha').value = S.fecha; }
        ultimoHoy = hoy();
        refrescar();
      }
    }, 60000);

    const { data: { session } } = await sb.auth.getSession();
    const confirmar = async () => {
      const u = await traerUsuario();
      if (u) { LS.set('usuario', u); } else { LS.del('usuario'); }
      return u;
    };
    if (session && navigator.onLine) {
      if (S.usuario) {
        // Abre enseguida con el usuario guardado y lo confirma por detrás.
        confirmar().then((u) => { if (!u || u.rol !== S.usuario.rol) location.reload(); }).catch(() => {});
      } else {
        try { S.usuario = await confirmar(); } catch (e) { /* sin red */ }
      }
    }
    // Sin conexión se puede seguir cobrando con la sesión y el catálogo guardados.
    if (S.usuario && (session || !navigator.onLine) && (S.cat || navigator.onLine)) await arrancarCobro();
    else mostrar('login');
  }

  iniciar();
})();
