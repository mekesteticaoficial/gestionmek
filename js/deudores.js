// Deudores: lo que deben las pacientes, agrupado por paciente.
// - Cobrar una atención entera (lo que le falta).
// - Registrar un pago a cuenta de cualquier monto: se descuenta de la
//   deuda más vieja primero (registrar_pago_cuenta en 06_cuentas.sql).
// - Cargar una deuda a mano con concepto libre.
// Todo va por la cola, así que funciona sin internet.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  let pendientes = M.LS.get('deudores', []);
  let pacientes = M.LS.get('pacientes', []);
  // Qué formulario está abierto: {tipo:'cobrar', key} | {tipo:'cuenta', ref} | {tipo:'nueva'}
  let abierto = null;
  let pagos = [{ medio: null, monto: null }];
  let nueva = { ref: null, buscar: '', concepto: '', monto: '', fecha: M.hoy() };

  const dias = (f) => Math.round((new Date(M.hoy()) - new Date(String(f).slice(0, 10))) / 86400000);
  const total = (v) => M.r2(v.items.reduce((a, i) => a + Number(i.precio_cobrado || 0), 0));
  const saldo = (v) => M.r2(total(v) - (v.pagado || 0));

  async function cargar() {
    try {
      const { data, error } = await sb.from('ventas')
        .select('id,fecha,paciente_ref,client_id,nota,creado_por,pacientes(nombre,telefono),venta_items(descripcion,precio_cobrado),venta_pagos(monto,fecha,medio)')
        .eq('estado', 'pendiente').order('fecha').order('id');
      if (error) throw error;
      pendientes = data.map((v) => ({ id: v.id, client_id: v.client_id, fecha: v.fecha, ref: v.paciente_ref, nota: v.nota,
        creado_por: v.creado_por, nombre: v.pacientes ? v.pacientes.nombre : v.paciente_ref,
        telefono: v.pacientes ? v.pacientes.telefono : null, items: v.venta_items,
        pagos: v.venta_pagos || [], pagado: M.r2((v.venta_pagos || []).reduce((a, p) => a + Number(p.monto), 0)) }));
      M.LS.set('deudores', pendientes);
    } catch (e) {
      if (navigator.onLine) M.toast('No se pudo leer: ' + M.mensaje(e), 'error');
    }
    render();
    if (!pacientes.length && navigator.onLine) {
      try { pacientes = await M.leerTodo('pacientes', 'ref,nombre,telefono,email', null, 'ref'); M.LS.set('pacientes', pacientes); } catch (e) { /* luego */ }
    }
  }

  // Lo que está en la cola todavía sin subir también cuenta.
  function lista() {
    const ops = window.Cola.leer();
    const enCola = ops.filter((o) => o.tipo === 'venta' && o.payload.estado === 'pendiente').map((o) => ({
      id: null, client_id: o.payload.client_id, fecha: o.payload.fecha, ref: o.payload.paciente_ref,
      nombre: o.payload.paciente ? o.payload.paciente.nombre : o.payload.paciente_ref,
      telefono: o.payload.paciente ? o.payload.paciente.telefono : null,
      items: o.payload.items.map((i) => ({ descripcion: i.descripcion || i.tipo, precio_cobrado: i.precio_cobrado })),
      pagos: [], pagado: 0, enCola: true }));
    const tocadas = (v) => ops.some((o) => (o.tipo === 'cobrar' || o.tipo === 'anular') &&
      ((v.id && o.payload.venta_id === v.id) || (v.client_id && o.payload.client_id === v.client_id)));
    return enCola.concat(pendientes.filter((v) => !enCola.some((c) => c.client_id === v.client_id))).filter((v) => !tocadas(v));
  }
  // Pagos a cuenta todavía sin subir, por paciente.
  const aCuentaEnCola = (ref) => window.Cola.leer().filter((o) => o.tipo === 'pago_cuenta' && o.payload.paciente_ref === ref)
    .reduce((a, o) => a + o.payload.pagos.reduce((s, p) => s + Number(p.monto), 0), 0);

  function whatsapp(tel, nombre, monto) {
    const d = String(tel || '').replace(/\D/g, '');
    if (d.length < 10) return '';
    const num = d.startsWith('54') ? d : '549' + d.replace(/^0/, '');
    const txt = 'Hola ' + nombre.split(' ')[0] + ', te escribimos de MEK Estética. Te quedó pendiente un saldo de ' + M.plata(monto) + '. ¡Gracias!';
    return ' · <a href="https://wa.me/' + num + '?text=' + encodeURIComponent(txt) + '" target="_blank" rel="noopener">WhatsApp</a>';
  }

  function htmlPagos(conMonto) {
    return '<div class="pagos">' + pagos.map((p, i) => '<div class="pago"><div class="medios">' + M.MEDIOS.map(([k, n]) =>
      '<button type="button" class="medio' + (p.medio === k ? ' activo' : '') + '" data-medio="' + i + '" data-valor="' + k + '">' + n + '</button>').join('') +
      '</div>' + (conMonto || pagos.length > 1 ? '<label class="monto">$ <input type="number" min="0" step="0.01" inputmode="decimal" data-monto="' + i + '" value="' + (p.monto ?? '') + '"' +
      (!conMonto && i === pagos.length - 1 ? ' readonly title="Lo que falta"' : '') + '></label>' : '') + '</div>').join('') +
      '<button type="button" class="link" data-dividir>' + (pagos.length > 1 ? '+ otro medio' : 'Pagó con dos medios') + '</button></div>';
  }

  function ajustar(t) {
    if (pagos.length === 1) { pagos[0].monto = t; return; }
    pagos[pagos.length - 1].monto = M.r2(t - pagos.slice(0, -1).reduce((a, p) => a + (Number(p.monto) || 0), 0));
  }

  function renderNueva() {
    const res = nueva.ref ? [] : buscarPacientes(nueva.buscar);
    const p = nueva.ref && pacientes.find((x) => x.ref === nueva.ref);
    return '<section class="card"><h2>Cargar una deuda a mano</h2>' +
      '<p class="explica">Para lo que no pasó por el cobro: una deuda vieja del Excel, algo que se llevó sin pagar… Queda en esta lista como cualquier otra deuda.</p>' +
      '<div class="form">' +
      (p ? '<div class="campo">Paciente<b>' + M.esc(p.nombre) + '</b> <button type="button" class="link" data-cambiarnueva>cambiar</button></div>'
         : '<label>Paciente <input type="search" id="nuevaBuscar" value="' + M.esc(nueva.buscar) + '" placeholder="Buscar…" autocomplete="off"></label>') +
      '<label>Fecha <input type="date" id="nuevaFecha" value="' + M.esc(nueva.fecha) + '"></label>' +
      '<label class="ancho">Concepto <input id="nuevaConcepto" value="' + M.esc(nueva.concepto) + '" placeholder="Ej.: Deuda anterior (Excel), crema que se llevó…"></label>' +
      '<label>Monto $ <input type="number" id="nuevaMonto" min="0" step="0.01" inputmode="decimal" value="' + M.esc(nueva.monto) + '"></label>' +
      '<div class="fila"><button type="button" class="primario" data-guardarnueva' + (p ? '' : ' disabled') + '>Guardar deuda</button>' +
      '<button type="button" class="link" data-cerrar>cancelar</button></div></div>' +
      (res.length ? '<ul class="resultados">' + res.map((x) => '<li><button type="button" data-nuevaref="' + M.esc(x.ref) + '"><b>' + M.esc(x.nombre) + '</b></button></li>').join('') + '</ul>' : '') +
      (!p && nueva.buscar.trim() && !res.length ? '<p class="tenue">No aparece: tiene que estar cargada en el dashboard de turnos.</p>' : '') +
      '</section>';
  }

  function buscarPacientes(q) {
    const w = M.norm(q).split(/\s+/).filter(Boolean);
    if (!w.length) return [];
    return pacientes.filter((p) => { const n = M.norm(p.nombre); return w.every((x) => n.includes(x)); })
      .sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, 8);
  }

  function render() {
    const filtro = M.norm($('#buscar').value);
    const todas = lista();
    const porPaciente = new Map();
    todas.forEach((v) => {
      if (!porPaciente.has(v.ref)) porPaciente.set(v.ref, { ref: v.ref, nombre: v.nombre, telefono: v.telefono, ventas: [] });
      porPaciente.get(v.ref).ventas.push(v);
    });
    const grupos = [...porPaciente.values()].map((g) => Object.assign(g, {
      debe: M.r2(g.ventas.reduce((a, v) => a + saldo(v), 0) - aCuentaEnCola(g.ref)),
      desde: g.ventas.reduce((a, v) => (v.fecha < a ? v.fecha : a), g.ventas[0].fecha) }))
      .filter((g) => g.debe > 0 && (!filtro || M.norm(g.nombre).includes(filtro)))
      .sort((a, b) => a.desde.localeCompare(b.desde));
    const suma = M.r2(grupos.reduce((a, g) => a + g.debe, 0));
    const viejas = todas.filter((v) => dias(v.fecha) > 7).length;
    $('#resumen').innerHTML =
      '<div class="kpi destacado"><small>Total adeudado</small><b>' + M.plata(suma) + '</b></div>' +
      '<div class="kpi"><small>Pacientes que deben</small><b>' + grupos.length + '</b><div class="det">' + todas.length + ' deuda(s)</div></div>' +
      '<div class="kpi' + (viejas ? ' destacado' : '') + '"><small>Hace más de una semana</small><b>' + viejas + '</b></div>';

    const htmlGrupo = (g) => {
      const enColaCuenta = aCuentaEnCola(g.ref);
      const abiertoCuenta = abierto && abierto.tipo === 'cuenta' && abierto.ref === g.ref;
      return '<section class="card bandeja"><div class="titulo-fila"><div><h2 style="margin:0">' + M.esc(g.nombre) + '</h2>' +
        '<div class="tenue">' + (g.telefono ? M.esc(g.telefono) : 'sin teléfono') + whatsapp(g.telefono, g.nombre, g.debe) + '</div></div>' +
        '<div style="text-align:right"><small class="tenue">debe</small><br><b style="font-size:1.4rem">' + M.plata(g.debe) + '</b></div></div>' +
        (enColaCuenta ? '<div class="aviso">Pago a cuenta de ' + M.plata(enColaCuenta) + ' sin sincronizar (ya descontado).</div>' : '') +
        (abiertoCuenta
          ? '<div class="pend"><b>Pago a cuenta</b><div class="tenue">Se descuenta de la deuda más vieja primero. Puede ser cualquier monto hasta ' + M.plata(g.debe) + '.</div>' +
            htmlPagos(true) + '<div class="acciones fila"><button type="button" class="primario" data-guardarcuenta="' + M.esc(g.ref) + '">Registrar pago</button>' +
            '<button type="button" class="link" data-cerrar>cancelar</button></div></div>'
          : '<div class="acciones fila" style="margin:4px 0 8px"><button type="button" class="secundario" style="width:auto;border-color:var(--marca);color:var(--marca)" data-cuenta="' +
            M.esc(g.ref) + '">Entregó una parte</button></div>') +
        g.ventas.map((v) => {
          const key = v.id ? 'id:' + v.id : 'c:' + v.client_id;
          const d = dias(v.fecha);
          const abiertoCobro = abierto && abierto.tipo === 'cobrar' && abierto.key === key;
          if (abiertoCobro) ajustar(saldo(v));
          return '<div class="pend"><div class="pend-top"><div>' + M.esc(v.items.map((i) => i.descripcion).join(' + ')) +
            '<div class="tenue">' + M.fechaCorta(v.fecha) + ' · ' + (d === 0 ? 'hoy' : d === 1 ? 'ayer' : 'hace ' + d + ' días') +
            (v.creado_por ? ' · cargó ' + M.esc(v.creado_por) : '') + (v.enCola ? ' · <span class="sin-sync">sin sincronizar</span>' : '') +
            (v.nota ? '<br>Nota: ' + M.esc(v.nota) : '') +
            (v.pagado ? '<br>Total ' + M.plata(total(v)) + ' · pagó a cuenta ' + v.pagos.map((p) => M.plata(p.monto) + ' el ' + M.fechaCorta(p.fecha)).join(', ') : '') +
            '</div></div><div style="text-align:right"><b>' + M.plata(saldo(v)) + '</b>' + (v.pagado ? '<br><small class="tenue">falta</small>' : '') + '</div></div>' +
            (abiertoCobro
              ? htmlPagos(false) + '<div class="acciones fila"><button type="button" class="primario" data-cobrar="' + key + '">Cobrar ' + M.plata(saldo(v)) +
                '</button><button type="button" class="link" data-cerrar>cancelar</button></div>'
              : '<div class="acciones fila"><button type="button" class="link" data-abrir="' + key + '">cobrar esta completa</button>' +
                (v.pagado ? '' : '<button type="button" class="link" data-anular="' + key + '">anular</button>') + '</div>') + '</div>';
        }).join('') + '</section>';
    };

    $('#lista').innerHTML = (abierto && abierto.tipo === 'nueva' ? renderNueva() : '') +
      (grupos.length ? grupos.map(htmlGrupo).join('')
        : '<section class="card"><p class="tenue">' + (filtro ? 'Nadie con ese nombre debe nada.' : 'No hay deudas pendientes. 🎉') + '</p></section>');
    renderSync();
  }

  function renderSync() {
    const ops = window.Cola.leer();
    const err = ops.filter((o) => o.error).length;
    const b = $('#sync');
    b.className = 'sync' + (err ? ' mal' : ops.length ? ' espera' : ' ok');
    b.textContent = (navigator.onLine ? '' : 'Sin conexión · ') + (err ? err + ' con error' : ops.length ? ops.length + ' sin sincronizar' : '✓ Todo sincronizado');
  }

  const clave = (k) => { const [t, v] = k.split(/:(.+)/); return t === 'id' ? { venta_id: Number(v) } : { client_id: v }; };
  const buscarVenta = (k) => lista().find((v) => (v.id ? 'id:' + v.id : 'c:' + v.client_id) === k);

  async function subir() { await window.Cola.procesar(sb); await cargar(); }

  function validarPagos(maximo, exacto) {
    if (pagos.some((p) => !p.medio)) return 'Elegí el medio de pago';
    const suma = M.r2(pagos.reduce((a, p) => a + (Number(p.monto) || 0), 0));
    if (pagos.some((p) => !(Number(p.monto) > 0))) return 'Falta el monto';
    if (exacto && suma !== maximo) return 'Los pagos suman ' + M.plata(suma) + ' y falta ' + M.plata(maximo);
    if (suma > maximo) return 'El pago (' + M.plata(suma) + ') es más de lo que debe (' + M.plata(maximo) + ')';
    return null;
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (t.id === 'nuevaDeuda') { abierto = { tipo: 'nueva' }; nueva = { ref: null, buscar: '', concepto: '', monto: '', fecha: M.hoy() }; render(); $('#nuevaBuscar').focus(); return; }
    if (d.nuevaref) { nueva.ref = d.nuevaref; render(); $('#nuevaConcepto').focus(); return; }
    if (d.cambiarnueva !== undefined) { nueva.ref = null; render(); return; }
    if (d.guardarnueva !== undefined) {
      const monto = M.numero(nueva.monto);
      if (!nueva.concepto.trim()) { M.toast('Falta el concepto', 'error'); return; }
      if (!(monto > 0)) { M.toast('El monto tiene que ser mayor a cero', 'error'); return; }
      const p = pacientes.find((x) => x.ref === nueva.ref);
      window.Cola.agregar('venta', { fecha: nueva.fecha || M.hoy(), paciente_ref: p.ref,
        paciente: { ref: p.ref, nombre: p.nombre, telefono: p.telefono, email: p.email }, estado: 'pendiente', pagos: [],
        items: [{ tipo: 'otro', descripcion: nueva.concepto.trim(), precio_cobrado: monto, cantidad: 1 }] });
      M.toast('Deuda cargada: ' + p.nombre + ' · ' + M.plata(monto), 'ok');
      abierto = null;
      render();
      subir();
      return;
    }
    if (d.cuenta) { abierto = { tipo: 'cuenta', ref: d.cuenta }; pagos = [{ medio: null, monto: null }]; render(); const i = document.querySelector('[data-monto="0"]'); if (i) i.focus(); return; }
    if (d.guardarcuenta) {
      const g = lista().filter((v) => v.ref === d.guardarcuenta);
      const debe = M.r2(g.reduce((a, v) => a + saldo(v), 0) - aCuentaEnCola(d.guardarcuenta));
      const e = validarPagos(debe, false);
      if (e) { M.toast(e, 'error'); return; }
      const ps = pagos.map((p) => ({ medio: p.medio, monto: Number(p.monto) }));
      const monto = M.r2(ps.reduce((a, p) => a + p.monto, 0));
      window.Cola.agregar('pago_cuenta', { paciente_ref: d.guardarcuenta, fecha: M.hoy(), pagos: ps });
      abierto = null;
      M.toast('Pago de ' + M.plata(monto) + ' registrado. Le queda ' + M.plata(M.r2(debe - monto)), 'ok', 6000);
      render();
      subir();
      return;
    }
    if (d.abrir) { abierto = { tipo: 'cobrar', key: d.abrir }; pagos = [{ medio: null, monto: null }]; render(); return; }
    if (d.cerrar !== undefined) { abierto = null; render(); return; }
    if (d.medio !== undefined) { pagos[Number(d.medio)].medio = d.valor; render(); return; }
    if (d.dividir !== undefined) {
      if (pagos.length === 1 && abierto.tipo === 'cobrar') pagos[0].monto = null;
      pagos.push({ medio: null, monto: null });
      render();
      return;
    }
    if (d.cobrar) {
      const v = buscarVenta(d.cobrar);
      const falta = saldo(v);
      ajustar(falta);
      const e = validarPagos(falta, true);
      if (e) { M.toast(e, 'error'); return; }
      const k = clave(d.cobrar);
      const ps = pagos.map((p) => ({ medio: p.medio, monto: Number(p.monto) }));
      if (!(k.client_id && window.Cola.cobrarEnCola(k.client_id, ps))) window.Cola.agregar('cobrar', Object.assign(k, { pagos: ps }));
      abierto = null;
      M.toast('Cobrado ' + M.plata(falta) + ' a ' + v.nombre, 'ok');
      render();
      subir();
      return;
    }
    if (d.anular) {
      const motivo = prompt('¿Por qué se anula? (queda registrado; no se borra)');
      if (!motivo || !motivo.trim()) return;
      window.Cola.agregar('anular', Object.assign(clave(d.anular), { motivo: motivo.trim() }));
      render();
      subir();
      return;
    }
    if (t.id === 'sync') subir();
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target, d = t.dataset;
    if (d.monto !== undefined) {
      pagos[Number(d.monto)].monto = M.numero(t.value);
      if (abierto && abierto.tipo === 'cobrar') ajustar(saldo(buscarVenta(abierto.key)));
      render();
    }
    if (t.id === 'nuevaConcepto') nueva.concepto = t.value;
    if (t.id === 'nuevaMonto') nueva.monto = t.value;
    if (t.id === 'nuevaFecha') nueva.fecha = t.value;
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'buscar') render();
    if (t.id === 'nuevaBuscar') {
      nueva.buscar = t.value;
      render();
      const f = $('#nuevaBuscar'); f.focus(); f.setSelectionRange(f.value.length, f.value.length);
    }
    if (t.id === 'nuevaConcepto') nueva.concepto = t.value;
    if (t.id === 'nuevaMonto') nueva.monto = t.value;
  });

  async function iniciar() {
    const u = await M.requerirSesion('deudores');
    if (!u) return;
    M.salirBoton();
    render();
    window.Cola.alCambiar(renderSync);
    window.addEventListener('online', subir);
    window.addEventListener('offline', renderSync);
    setInterval(() => { if (window.Cola.leer().length) subir(); }, 20000);
    await cargar();
    if (window.Cola.leer().length) subir();
  }
  iniciar();
})();
