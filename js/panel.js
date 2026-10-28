// Panel del período (solo Franco). Los números salen de panel() en la
// base: acá solo se muestran. Nada se guarda calculado.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const P = M.plata;
  const GRUPOS = {
    facial: 'Faciales', corporal: 'Corporales', depilacion: 'Depilación', combo: 'Combos', capilar: 'Capilar',
    masajes: 'Masajes', plasma: 'Plasma (Estefanía)', tatuajes: 'Tatuajes (Estefanía)', estetica_externa: 'Estética externa',
    cabina: 'Cabina suelta', consulta: 'Consultas',
  };
  const TIPOS = { costo_operativo: 'Costos del negocio', sueldo: 'Sueldos', pago_tercero: 'Pagos a terceros',
                  compra_producto: 'Compras de mercadería', pago_deuda: 'Pagos de deudas y préstamos', retiro_socio: 'Retiros de socio' };

  const f = (d) => d.toLocaleDateString('en-CA');
  function rango(p) {
    const h = new Date();
    const lunes = new Date(h); lunes.setDate(h.getDate() - ((h.getDay() + 6) % 7));
    if (p === 'semana') return [f(lunes), f(h)];
    if (p === 'semana_ant') { const a = new Date(lunes); a.setDate(a.getDate() - 7); const b = new Date(lunes); b.setDate(b.getDate() - 1); return [f(a), f(b)]; }
    if (p === 'mes') return [f(new Date(h.getFullYear(), h.getMonth(), 1)), f(h)];
    return [f(new Date(h.getFullYear(), h.getMonth() - 1, 1)), f(new Date(h.getFullYear(), h.getMonth(), 0))];
  }

  async function ver() {
    const rango = { p_desde: $('#desde').value, p_hasta: $('#hasta').value };
    const [{ data, error }, caja, gan] = await Promise.all([sb.rpc('panel', rango), sb.rpc('panel_caja', rango), sb.rpc('ganancias', rango)]);
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    // De dónde sale lo que queda para MEK (14_ganancias.sql). Sin el 14,
    // queda la tabla de rubros de siempre.
    data.ganancias = gan.error ? null : gan.data;
    // La caja cuenta la plata el día que entró (pagos a cuenta incluidos) y
    // los préstamos que entraron. Si 06 no está corrida, queda la de panel().
    if (!caja.error && caja.data) {
      const c = caja.data;
      data.medios = c.medios;
      data.caja.de_profesionales = Number(c.de_profesionales || 0);
      data.caja.directo = c.directo || [];
      data.caja.giftcards = Number(c.giftcards || 0);
      data.caja.pagado_con_giftcard = Number(c.pagado_con_giftcard || 0);
      data.caja.entradas = M.r2(Number(c.cobros) + Number(c.prestamos) + data.caja.de_profesionales + data.caja.giftcards);
      data.caja.movimiento = M.r2(data.caja.entradas - Number(data.caja.salidas));
      data.caja.a_cuenta = c.a_cuenta;
      data.caja.prestamos = c.prestamos;
    }
    render(data);
  }

  // Nombre de cada rubro. Los terceros van por persona, con lo que hacen.
  const QUE_HACE = { 'juan cruz': 'masajes', daniela: 'cejas, pestañas y uñas', estefania: 'plasma y tatuajes' };
  function nombreRubro(r) {
    if (r.clase === 'tercero') {
      const n = M.norm(r.rubro);
      const k = Object.keys(QUE_HACE).find((x) => n.startsWith(x));
      return r.rubro + (k ? ' · ' + QUE_HACE[k] : '');
    }
    return ({ productos_propio: 'Productos propios', productos_consignacion: 'Productos en consignación',
              otros: 'Otros cobros', cabina: 'Cabina' })[r.rubro] || GRUPOS[r.rubro] || r.rubro;
  }

  // La cuenta completa: cobrado → lo de las profesionales → costo → queda
  // para MEK → costos del negocio → ganancia neta. Y de dónde sale.
  function htmlGanancia(g) {
    const linea = (txt, v, cl, det) => '<div class="eerr-linea ' + (cl || '') + '"><span>' + txt + (det ? '<small>' + det + '</small>' : '') +
      '</span><b>' + v + '</b></div>';
    const varia = Number(g.ganancia_previa) ? (() => {
      const d = Number(g.ganancia) - Number(g.ganancia_previa);
      return (d >= 0 ? '▲ ' : '▼ ') + P(Math.abs(d)) + ' vs. el período anterior (' + P(g.ganancia_previa) + ')';
    })() : '';
    const max = Math.max(1, ...g.rubros.map((r) => Number(r.mek)));
    const total = Number(g.queda_mek) || 1;
    return '<section class="card"><h2>Ganancia del negocio</h2>' +
      '<div class="eerr">' +
        linea('Se cobró a las pacientes', P(g.cobrado), '', Number(g.sin_cobrar) ? 'incluye ' + P(g.sin_cobrar) + ' que todavía deben' : '') +
        linea('− Lo que es de las profesionales', '−' + P(g.profesionales), 'menos', 'comisión de Yael y la parte de Juan Cruz, Daniela, Estefanía y el Dr. Márquez') +
        (Number(g.costo_productos) ? linea('− Costo de los productos vendidos', '−' + P(g.costo_productos), 'menos',
          Number(g.productos_sin_costo) ? g.productos_sin_costo + ' venta(s) sin costo cargado: no se restan' : '') : '') +
        linea('= Queda para MEK', P(g.queda_mek), 'sub') +
        linea('− Costos del negocio', '−' + P(g.costos_negocio), 'menos',
          g.costos_detalle.map((c) => M.esc(c.categoria) + ' ' + P(c.monto)).join(' · ') || 'no hay gastos cargados en el período') +
        (Number(g.sueldos_manuales) ? linea('− Sueldos fuera de liquidación', '−' + P(g.sueldos_manuales), 'menos') : '') +
        linea('= Ganancia neta', P(g.ganancia), 'total', varia) +
        (Number(g.retiros_socio) ? '<p class="tenue" style="margin-top:6px">Aparte, retiros de socio: ' + P(g.retiros_socio) + ' (no son costo del negocio).</p>' : '') +
      '</div>' +
      '<h3 style="margin-top:18px">De dónde sale lo que queda para MEK</h3>' +
      '<div class="rubros">' + (g.rubros.length ? g.rubros.map((r) => {
        const pct = Number(r.cobrado) ? Math.round(Number(r.mek) / Number(r.cobrado) * 100) : null;
        const tercero = r.clase === 'tercero';
        return '<details class="rubro"><summary>' +
          '<div class="rubro-top"><span class="rubro-nombre">' + M.esc(nombreRubro(r)) + '</span><b>' + P(r.mek) + '</b></div>' +
          '<div class="hpista"><div class="hbarra" style="width:' + Math.max(0, Number(r.mek)) / max * 100 + '%"></div></div>' +
          '<div class="rubro-det">' + r.cantidad + (tercero ? ' atención(es)' : '') + ' · se cobró ' + P(r.cobrado) +
            (Number(r.profesional) ? ' · ' + (tercero ? 'su parte' : 'comisión') + ' ' + P(r.profesional) : '') +
            (Number(r.costo) ? ' · costo ' + P(r.costo) : '') +
            (pct != null && (tercero || Number(r.profesional) || Number(r.costo)) ? ' · <b>MEK se queda el ' + pct + '%</b>' : '') +
            ' · ' + Math.round(Number(r.mek) / total * 100) + '% de lo que queda' +
            (Number(r.sin_cobrar) ? ' · <span class="error">' + P(r.sin_cobrar) + ' sin cobrar</span>' : '') + '</div>' +
          '</summary>' +
          '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Qué</th><th class="num">Cant.</th><th class="num">Cobrado</th><th class="num">Queda MEK</th></tr></thead><tbody>' +
            (r.detalle || []).map((x) => '<tr><td>' + M.esc(x.concepto) + '</td><td class="num">' + x.cantidad + '</td><td class="num">' + P(x.cobrado) +
              '</td><td class="num">' + P(x.mek) + '</td></tr>').join('') + '</tbody></table></div></details>';
      }).join('') : '<p class="tenue">Sin atenciones en el período.</p>') + '</div>' +
      '<p class="explica">Cuenta lo atendido en el período, cobrado o no (las anuladas no). Tocá un rubro para ver el detalle. ' +
        'De los terceros se muestra lo que le dejan a MEK, no el total del tratamiento.</p></section>';
  }

  const kpi = (titulo, valor, det, clase) => '<div class="kpi ' + (clase || '') + '"><small>' + titulo + '</small><b>' + valor + '</b>' +
    (det ? '<div class="det">' + det + '</div>' : '') + '</div>';

  function render(d) {
    const i = d.ingresos, r = d.resultado, c = d.caja;
    const alertas = [];
    if (d.sin_regla) alertas.push('<a href="catalogo.html#comisiones">' + d.sin_regla + ' cobro(s) sin regla de comisión</a>');
    if (d.promos_revisar) alertas.push('<a href="catalogo.html#depilacion">' + d.promos_revisar + ' promo(s) de depilación para revisar</a>');
    if (d.pendientes_cobro.ventas) alertas.push('<a href="deudores.html">' + d.pendientes_cobro.ventas + ' atención(es) sin cobrar por ' + P(d.pendientes_cobro.monto) + '</a>');
    const vencidas = d.compras_a_pagar.filter((x) => x.vencimiento && x.vencimiento < M.hoy());
    if (vencidas.length) alertas.push('<a href="compras.html">' + vencidas.length + ' compra(s) vencida(s) sin pagar</a>');
    $('#alertas').innerHTML = alertas.length ? '<div class="alerta">⚠ ' + alertas.join(' · ') + '</div>' : '';

    const maxGrupo = Math.max(1, ...d.grupos.map((g) => Number(g.neto)));
    const gastosPorTipo = {};
    d.gastos.forEach((g) => { (gastosPorTipo[g.tipo] = gastosPorTipo[g.tipo] || []).push(g); });

    const g = d.ganancias;
    $('#contenido').innerHTML =
      '<div class="kpis">' +
        (g ? kpi('Ganancia neta', P(g.ganancia), 'lo que queda para MEK − costos del negocio', 'destacado') +
             kpi('Queda para MEK', P(g.queda_mek), 'después de pagar comisiones y terceros', 'destacado') +
             kpi('Se cobró a las pacientes', P(g.cobrado), i.atenciones + ' atenciones')
           : kpi('Ingreso neto de MEK', P(i.neto), 'lo cobrado sin lo de terceros, comisiones ni costo de insumos', 'destacado') +
             kpi('Resultado', P(r.resultado), 'neto − costos del negocio' + (Number(r.sueldos_manuales) ? ' − sueldos a mano' : ''), 'destacado') +
             kpi('Cobrado (bruto, caja)', P(i.bruto), i.atenciones + ' atenciones')) +
        kpi('Comisiones devengadas', P(i.comisiones), 'Yael') +
        kpi('Para terceros', P(i.terceros), 'Juan Cruz, Daniela, Estefanía, Dr. Márquez') +
        kpi('Descuentos otorgados', P(i.descuentos), 'lista − cobrado') +
        kpi('Retiros de socio', P(r.retiros_socio), 'aparte: no son costo del negocio', 'aparte') +
        kpi('Movimiento de caja', P(c.movimiento), 'entró ' + P(c.entradas) + ' · salió ' + P(c.salidas)) +
      '</div>' +

      (g ? htmlGanancia(g) : '') +

      '<div class="dos">' +
      (g ? '' : '<section class="card"><h2>Ingresos por rubro</h2><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Rubro</th><th class="num">Cant.</th>' +
        '<th class="num">Cobrado</th><th class="num">Terceros</th><th class="num">Comisiones</th><th class="num">Neto MEK</th><th style="width:20%"></th></tr></thead><tbody>' +
        (d.grupos.length ? d.grupos.map((g) => '<tr><td>' + M.esc(GRUPOS[g.grupo] || g.grupo) + '</td><td class="num">' + g.cantidad +
          '</td><td class="num">' + P(g.bruto) + '</td><td class="num">' + (Number(g.terceros) ? P(g.terceros) : '—') +
          '</td><td class="num">' + (Number(g.comisiones) ? P(g.comisiones) : '—') + '</td><td class="num"><b>' + P(g.neto) +
          '</b></td><td><div class="barra-h" style="width:' + Math.max(0, Number(g.neto)) / maxGrupo * 100 + '%"></div></td></tr>').join('')
          : '<tr><td colspan="7" class="tenue">Sin cobros en el período.</td></tr>') +
        '</tbody></table></div>' +
        '<p class="explica">Las sesiones de pack no traen plata (se cobró al vender el pack); muestran la comisión que generan cuando se usan.</p></section>') +

      '<section class="card"><h2>Caja por medio de pago</h2><div class="tabla-wrap"><table class="tabla"><tbody>' +
        (d.medios.length ? d.medios.map((m) => '<tr><td>' + M.esc(M.nombreMedio(m.medio)) +
            (m.cuenta ? ' <span class="tenue">' + M.esc(M.textoDestino({ medio: m.medio, cuenta: m.cuenta })) + '</span>' : '') +
            '</td><td class="num">' + P(m.monto) + '</td></tr>').join('') +
          (Number(c.prestamos) ? '<tr><td>Préstamos que entraron</td><td class="num">' + P(c.prestamos) + '</td></tr>' : '') +
          (c.de_profesionales ? '<tr><td>Lo que pagaron profesionales que debían</td><td class="num">' + P(c.de_profesionales) + '</td></tr>' : '') +
          (c.giftcards ? '<tr><td>Gift cards vendidas</td><td class="num">' + P(c.giftcards) + '</td></tr>' : '') +
          '<tr class="total"><td>Total</td><td class="num">' + P(c.entradas) + '</td></tr>' : '<tr><td class="tenue">Sin pagos.</td></tr>') +
        (Number(c.a_cuenta) ? '<tr><td colspan="2" class="tenue">Incluye ' + P(c.a_cuenta) + ' de pagos a cuenta de deudoras.</td></tr>' : '') +
        (c.pagado_con_giftcard ? '<tr><td colspan="2" class="tenue">Además se usaron ' + P(c.pagado_con_giftcard) + ' de gift cards (no es plata nueva: entró cuando se vendieron).</td></tr>' : '') +
        ((c.directo || []).length ? '<tr><td colspan="2" class="tenue">No entraron a MEK (los cobraron directo y se les descuenta en la liquidación): ' +
          c.directo.map((x) => M.esc(x.profesional) + ' ' + P(x.monto)).join(' · ') + '</td></tr>' : '') +
        '</tbody></table></div>' +
        '<h2 style="margin-top:16px">Por profesional</h2><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Profesional</th><th class="num">Atenc.</th>' +
        '<th class="num">Cobrado</th><th class="num">Comisión / su parte</th></tr></thead><tbody>' +
        d.profesionales.map((p) => '<tr><td>' + M.esc(p.profesional) + '</td><td class="num">' + p.atenciones + '</td><td class="num">' + P(p.bruto) +
          '</td><td class="num">' + P(p.modelo === 'interno' ? p.comision : p.tercero) + '</td></tr>').join('') +
        '</tbody></table></div></section>' +
      '</div>' +

      '<div class="dos">' +
      '<section class="card"><h2>Gastos</h2><div class="tabla-wrap"><table class="tabla"><tbody>' +
        (Object.keys(gastosPorTipo).length ? Object.keys(TIPOS).filter((t) => gastosPorTipo[t]).map((t) => {
          const lista = gastosPorTipo[t];
          const tot = lista.reduce((a, g) => a + Number(g.monto), 0);
          return '<tr class="total"><td>' + TIPOS[t] + '</td><td class="num">' + P(tot) + '</td></tr>' +
            lista.map((g) => '<tr><td style="padding-left:20px">' + M.esc(g.categoria) + ' <span class="tenue">(' + g.cantidad + ')</span></td><td class="num">' +
              P(g.monto) + '</td></tr>').join('');
        }).join('') : '<tr><td class="tenue">Sin gastos cargados.</td></tr>') +
        '</tbody></table></div>' +
        '<p class="explica">En el resultado se restan solo los costos del negocio. Los sueldos que salen de liquidaciones no se restan otra vez (esa comisión ya está descontada del neto) ' +
        'y las compras de mercadería entran al stock: su costo se cuenta cuando se vende.</p></section>' +

      '<section class="card"><h2>Productos</h2>' +
        (d.productos.length ? '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Modalidad</th><th class="num">Vendido</th><th class="num">Margen</th></tr></thead><tbody>' +
          d.productos.map((p) => {
            const conCosto = Number(p.vendido_con_costo);
            const margen = conCosto ? P(p.margen_conocido) + ' (' + Math.round(Number(p.margen_conocido) / conCosto * 100) + '%)' : '<i>sin dato</i>';
            return '<tr><td>' + (p.modalidad === 'propio' ? 'Propios' : 'En consignación') + '</td><td class="num">' + P(p.vendido) + '</td><td class="num">' + margen +
              (p.lineas_sin_costo ? '<div class="tenue">' + p.lineas_sin_costo + ' venta(s) sin costo cargado: no entran en el margen</div>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div><p class="explica">Propios y en consignación no se promedian: son negocios distintos.</p>'
          : '<p class="tenue">Sin ventas de productos en el período.</p>') +
        '<h2 style="margin-top:16px">Lo que se debe</h2><div class="tabla-wrap"><table class="tabla"><tbody>' +
        d.comisiones_pendientes.map((x) => '<tr><td>Comisiones sin liquidar · ' + M.esc(x.profesional) + '</td><td class="num">' + P(x.monto) + '</td></tr>').join('') +
        d.a_pagar_terceros.map((x) => '<tr><td>A pagar a ' + M.esc(x.profesional) + ' (' + x.operaciones + ' op., desde ' + M.fechaCorta(x.desde) + ')</td><td class="num">' + P(x.total_adeudado) + '</td></tr>').join('') +
        d.compras_a_pagar.map((x) => '<tr class="' + (x.vencimiento && x.vencimiento < M.hoy() ? 'rojo' : '') + '"><td>Compra a ' + M.esc(x.proveedor) +
          (x.vencimiento ? ' · vence ' + M.fechaCorta(x.vencimiento) : '') + '</td><td class="num">' + P(x.total) + '</td></tr>').join('') +
        (!d.comisiones_pendientes.length && !d.a_pagar_terceros.length && !d.compras_a_pagar.length ? '<tr><td class="tenue">Nada pendiente.</td></tr>' : '') +
        '</tbody></table></div><p class="explica">Esto es lo pendiente a hoy, no solo del período.</p></section>' +
      '</div>';
  }

  // ------------------------------------------------------------ exportar
  async function cargarXLSX() {
    if (window.XLSX) return;
    await new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = ok; s.onerror = () => mal(new Error('No se pudo cargar el generador de Excel'));
      document.head.appendChild(s);
    });
  }

  async function exportar() {
    const est = $('#exportEstado');
    const hojas = [
      ['Ventas', 'v_export_ventas', 'venta'], ['Pagos', 'venta_pagos', 'id'], ['Gastos', 'gastos', 'id'],
      ['Liquidaciones', 'liquidaciones', 'id'], ['Liquidación ítems', 'liquidacion_items', 'venta_item_id'],
      ['Ajustes', 'liquidacion_ajustes', 'id'], ['Packs', 'packs', 'id'], ['Sesiones de pack', 'pack_sesiones', 'id'],
      ['Compras', 'compras', 'id'], ['Compra ítems', 'compra_items', 'id'], ['Productos', 'productos', 'id'],
      ['Pacientes', 'pacientes', 'ref'],
    ];
    try {
      est.textContent = ' Preparando…';
      await cargarXLSX();
      const wb = window.XLSX.utils.book_new();
      for (const [nombre, tabla, orden] of hojas) {
        est.textContent = ' Leyendo ' + nombre.toLowerCase() + '…';
        const filas = await M.leerTodo(tabla, '*', null, orden);
        window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(filas.length ? filas : [{ '(vacío)': '' }]), nombre.slice(0, 31));
      }
      window.XLSX.writeFile(wb, 'MEK-' + M.hoy() + '.xlsx');
      est.textContent = ' Listo.';
    } catch (e) {
      est.textContent = '';
      M.toast('No se pudo exportar: ' + M.mensaje(e), 'error');
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.p) {
      const [a, b] = rango(t.dataset.p);
      $('#desde').value = a; $('#hasta').value = b;
      document.querySelectorAll('#presets .chip').forEach((x) => x.classList.toggle('activo', x === t));
      ver();
    }
    if (t.id === 'ver') { document.querySelectorAll('#presets .chip').forEach((x) => x.classList.remove('activo')); ver(); }
    if (t.id === 'exportar') exportar();
  });

  async function iniciar() {
    const u = await M.requerirSesion('panel', { admin: true });
    if (!u) return;
    M.salirBoton();
    document.querySelector('[data-p="mes"]').click();
  }
  iniciar();
})();
