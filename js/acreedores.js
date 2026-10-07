// Acreedores (solo Franco): todo lo que MEK debe.
// Los números salen de acreedores() en la base (06_cuentas.sql).
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const P = M.plata;
  let datos = null;
  let pagando = null;   // {tipo:'deuda', id} | {tipo:'consig', nombre}
  let pago = { monto: '', medio: null, fecha: M.hoy(), cid: null };

  async function cargar() {
    const { data, error } = await sb.rpc('acreedores');
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    datos = data;
    render();
  }

  function formPago(maximo) {
    return '<div class="pend"><div class="form">' +
      '<label>Monto $ <input type="number" id="pagoMonto" min="0" step="0.01" inputmode="decimal" value="' + M.esc(pago.monto) + '" placeholder="hasta ' + P(maximo) + '"></label>' +
      '<label>Fecha <input type="date" id="pagoFecha" value="' + M.esc(pago.fecha) + '"></label></div>' +
      '<div class="medios" style="margin-top:8px">' + M.MEDIOS.map(([k, n]) => '<button type="button" class="medio' + (pago.medio === k ? ' activo' : '') +
        '" data-medio="' + k + '">' + n + '</button>').join('') + '</div>' +
      '<div class="acciones fila"><button type="button" class="primario" data-confirmar>Registrar pago</button>' +
      '<button type="button" class="link" data-total="' + maximo + '">pagar todo (' + P(maximo) + ')</button>' +
      '<button type="button" class="link" data-cancelar>cancelar</button></div></div>';
  }

  function render() {
    if (!datos) return;
    const d = datos;
    const vivas = d.deudas.filter((x) => !x.anulada_en);
    const totDeudas = M.r2(vivas.reduce((a, x) => a + Number(x.saldo), 0));
    const totConsig = M.r2(d.consignacion.reduce((a, x) => a + Math.max(Number(x.saldo), 0), 0));
    const totOtros = M.r2(d.comisiones.reduce((a, x) => a + Number(x.monto), 0) + d.terceros.reduce((a, x) => a + Number(x.total_adeudado), 0) +
      d.compras.reduce((a, x) => a + Number(x.total), 0));
    $('#resumen').innerHTML =
      '<div class="kpi destacado"><small>MEK debe en total</small><b>' + P(M.r2(totDeudas + totConsig + totOtros)) + '</b></div>' +
      '<div class="kpi"><small>Préstamos y deudas</small><b>' + P(totDeudas) + '</b></div>' +
      '<div class="kpi"><small>Consignación</small><b>' + P(totConsig) + '</b></div>' +
      '<div class="kpi"><small>Comisiones, terceros y proveedores</small><b>' + P(totOtros) + '</b></div>';

    const pagosDe = (id) => d.pagos_deudas.filter((p) => p.deuda_id === id && !p.anulado);
    $('#deudas').innerHTML = d.deudas.length ? d.deudas.map((x) => {
      const vencida = x.vencimiento && x.vencimiento < M.hoy() && Number(x.saldo) > 0 && !x.anulada_en;
      const estado = x.anulada_en ? '<span class="pill">anulada</span>' : Number(x.saldo) === 0 ? '<span class="pill ok">pagada</span>'
        : vencida ? '<span class="pill mal">vencida</span>' : '';
      const ps = pagosDe(x.id);
      return '<div class="pend' + (x.anulada_en ? ' tenue' : '') + '"><div class="pend-top"><div><b>' + M.esc(x.acreedor) + '</b> · ' + M.esc(x.concepto) + ' ' + estado +
        '<div class="tenue">' + P(x.monto) + ' del ' + M.fechaCorta(x.fecha) + (x.vencimiento ? ' · vence ' + M.fechaCorta(x.vencimiento) : '') +
        (x.entro_a_caja ? ' · entró a la caja (' + M.esc(M.nombreMedio(x.medio)) + ')' : '') + (x.nota ? '<br>' + M.esc(x.nota) : '') +
        (ps.length ? '<br>Pagos: ' + ps.map((p) => P(p.monto) + ' el ' + M.fechaCorta(p.fecha)).join(', ') : '') +
        (x.anulada_motivo ? '<br>Anulada: ' + M.esc(x.anulada_motivo) : '') + '</div></div>' +
        '<div style="text-align:right"><b style="font-size:1.15rem">' + P(x.saldo) + '</b><br><small class="tenue">saldo</small></div></div>' +
        (pagando && pagando.tipo === 'deuda' && pagando.id === x.id ? formPago(Number(x.saldo))
          : !x.anulada_en && Number(x.saldo) > 0 ? '<div class="acciones fila"><button type="button" class="primario" data-pagardeuda="' + x.id + '">Pagar</button>' +
            (ps.length ? '' : '<button type="button" class="link" data-anular="' + x.id + '">anular</button>') + '</div>' : '') + '</div>';
    }).join('') : '<p class="tenue">No hay préstamos ni deudas cargados.</p>';

    const sinAsignar = d.productos_consignacion.filter((p) => !p.consignante || p.margen == null);
    $('#consignacion').innerHTML = (d.consignacion.length ? '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Quién lo trajo</th><th class="num">Por lo vendido</th>' +
      '<th class="num">Pagado</th><th class="num">Se le debe</th><th></th></tr></thead><tbody>' +
      d.consignacion.map((c) => '<tr><td>' + M.esc(c.consignante) + (Number(c.ventas_sin_dato) ? '<div class="aviso">' + c.ventas_sin_dato +
        ' venta(s) sin margen cargado: no suman</div>' : '') + '</td><td class="num">' + P(c.debe_por_ventas) + '</td><td class="num">' + P(c.pagado) +
        '</td><td class="num"><b>' + P(c.saldo) + '</b></td><td>' + (c.consignante !== '(sin asignar)' && Number(c.saldo) > 0
          ? '<button type="button" class="primario" data-pagarconsig="' + M.esc(c.consignante) + '">Pagar</button>' : '') + '</td></tr>' +
        (pagando && pagando.tipo === 'consig' && pagando.nombre === c.consignante ? '<tr><td colspan="5">' + formPago(Number(c.saldo)) + '</td></tr>' : '')).join('') +
      '</tbody></table></div>' : '<p class="tenue">Todavía no se vendió nada en consignación.</p>') +
      (sinAsignar.length ? '<div class="aviso">Productos en consignación sin quién lo trajo o sin margen: ' + sinAsignar.map((p) => M.esc(p.nombre)).join(', ') + '.</div>' : '') +
      (!d.productos_consignacion.length ? '<p class="tenue">No hay productos marcados como "en consignación". Se marcan en Precios → Productos.</p>' : '');

    $('#otros').innerHTML = '<div class="tabla-wrap"><table class="tabla"><tbody>' +
      d.comisiones.map((x) => '<tr><td>Comisiones sin liquidar · ' + M.esc(x.profesional) + '</td><td class="num">' + P(x.monto) + '</td><td><a href="liquidaciones.html">liquidar</a></td></tr>').join('') +
      d.terceros.map((x) => '<tr><td>A ' + M.esc(x.profesional) + ' (' + x.operaciones + ' op., desde ' + M.fechaCorta(x.desde) + ')</td><td class="num">' + P(x.total_adeudado) +
        '</td><td><a href="liquidaciones.html">liquidar</a></td></tr>').join('') +
      d.compras.map((x) => '<tr class="' + (x.vencimiento && x.vencimiento < M.hoy() ? 'rojo' : '') + '"><td>Proveedor ' + M.esc(x.proveedor) +
        (x.vencimiento ? ' · vence ' + M.fechaCorta(x.vencimiento) : '') + '</td><td class="num">' + P(x.total) + '</td><td><a href="compras.html">pagar</a></td></tr>').join('') +
      (!d.comisiones.length && !d.terceros.length && !d.compras.length ? '<tr><td class="tenue">Nada pendiente.</td></tr>' : '') + '</tbody></table></div>';
  }

  async function confirmar() {
    const monto = M.numero(pago.monto);
    if (!(monto > 0)) { M.toast('Falta el monto', 'error'); return; }
    if (!pago.medio) { M.toast('Elegí el medio de pago', 'error'); return; }
    pago.cid = pago.cid || window.Cola.uuid();   // mismo id si se reintenta: no duplica
    const { data, error } = pagando.tipo === 'deuda'
      ? await sb.rpc('pagar_deuda_mek', { p_deuda: pagando.id, p_monto: monto, p_fecha: pago.fecha, p_medio: pago.medio, p_client_id: pago.cid })
      : await sb.rpc('pagar_consignacion', { p_consignante: pagando.nombre, p_monto: monto, p_fecha: pago.fecha, p_medio: pago.medio, p_client_id: pago.cid });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Pago registrado. Queda ' + P(data), 'ok');
    pagando = null;
    cargar();
  }

  function dialogoNueva() {
    return new Promise((ok) => {
      let d = document.getElementById('dlg');
      if (!d) { d = document.createElement('dialog'); d.id = 'dlg'; document.body.appendChild(d); }
      d.innerHTML = '<form method="dialog" class="form" style="grid-template-columns:1fr"><h2 style="margin:0">Deuda nueva de MEK</h2>' +
        '<label>¿A quién se le debe? <input name="acreedor" required></label>' +
        '<label>Concepto <input name="concepto" required placeholder="Préstamo, seña de un equipo…"></label>' +
        '<label>Monto $ <input name="monto" type="number" step="0.01" min="0" inputmode="decimal" required></label>' +
        '<label>Fecha <input name="fecha" type="date" value="' + M.hoy() + '"></label>' +
        '<label>Vence (opcional) <input name="vencimiento" type="date"></label>' +
        '<label>¿Esa plata entró a la caja de MEK? <select name="caja"><option value="no">No (es una deuda por otra cosa)</option>' +
          M.MEDIOS.map(([k, n]) => '<option value="' + k + '">Sí, por ' + n + '</option>').join('') + '</select></label>' +
        '<label>Nota <input name="nota"></label>' +
        '<div class="fila"><button value="ok" class="primario">Guardar</button><button value="no" formnovalidate>Cancelar</button></div></form>';
      d.onclose = () => {
        if (d.returnValue !== 'ok') { ok(null); return; }
        const f = new FormData(d.querySelector('form'));
        ok(Object.fromEntries(f.entries()));
      };
      d.showModal();
    });
  }

  async function nueva() {
    const v = await dialogoNueva();
    if (!v) return;
    const { error } = await sb.rpc('registrar_deuda_mek', { p: {
      client_id: window.Cola.uuid(), acreedor: v.acreedor, concepto: v.concepto, monto: M.numero(v.monto), fecha: v.fecha,
      vencimiento: v.vencimiento || null, entro_a_caja: v.caja !== 'no', medio: v.caja !== 'no' ? v.caja : null, nota: v.nota || null } });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Deuda cargada', 'ok');
    cargar();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (t.id === 'nueva') { nueva(); return; }
    if (d.pagardeuda) { pagando = { tipo: 'deuda', id: Number(d.pagardeuda) }; pago = { monto: '', medio: null, fecha: M.hoy(), cid: null }; render(); return; }
    if (d.pagarconsig) { pagando = { tipo: 'consig', nombre: d.pagarconsig }; pago = { monto: '', medio: null, fecha: M.hoy(), cid: null }; render(); return; }
    if (d.cancelar !== undefined) { pagando = null; render(); return; }
    if (d.medio) { pago.medio = d.medio; render(); return; }
    if (d.total) { pago.monto = d.total; render(); return; }
    if (d.confirmar !== undefined) { confirmar(); return; }
    if (d.anular) {
      const motivo = prompt('¿Por qué se anula? (queda registrado)');
      if (!motivo || !motivo.trim()) return;
      const { error } = await sb.rpc('anular_deuda_mek', { p_deuda: Number(d.anular), p_motivo: motivo.trim() });
      if (error) { M.toast(M.mensaje(error), 'error'); return; }
      cargar();
    }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'pagoMonto') { pago.monto = ev.target.value; pago.cid = null; }
    if (ev.target.id === 'pagoFecha') pago.fecha = ev.target.value;
  });

  async function iniciar() {
    const u = await M.requerirSesion('acreedores', { admin: true });
    if (!u) return;
    M.salirBoton();
    cargar();
  }
  iniciar();
})();
