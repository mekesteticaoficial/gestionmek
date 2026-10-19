// Resumen visual de la semana (Liquidaciones, solo Franco).
// Los números salen de resumen_periodo() en la base (07_mejoras.sql).
// Un solo color (el de la marca): cada gráfico tiene una sola serie.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const P = M.plata;
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  let lunes = null;

  const iso = (d) => d.toLocaleDateString('en-CA');
  function lunesDe(d) { const x = new Date(d); x.setHours(12); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  const mas = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fecha = (s) => new Date(s + 'T12:00:00');

  function variacion(actual, previo) {
    if (!previo) return '';
    const v = Math.round((actual - previo) / previo * 100);
    if (!v) return 'igual que la semana anterior';
    return (v > 0 ? '▲ ' : '▼ ') + Math.abs(v) + '% vs. semana anterior (' + P(previo) + ')';
  }

  // Barras verticales por día. Hover: valor exacto (title + foco).
  function barrasDias(dias) {
    const W = 560, H = 170, pad = { t: 14, r: 4, b: 26, l: 4 };
    const max = Math.max(1, ...dias.map((d) => Number(d.facturado)));
    const bw = (W - pad.l - pad.r) / dias.length;
    const hoy = M.hoy();
    const barras = dias.map((d, i) => {
      const v = Number(d.facturado);
      const h = v ? Math.max(3, (H - pad.t - pad.b) * v / max) : 0;
      const x = pad.l + i * bw + 3, w = bw - 6, y = H - pad.b - h;
      const f = fecha(d.fecha);
      const etiqueta = DIAS[f.getDay()] + ' ' + f.getDate();
      const tip = etiqueta + ': ' + P(v) + ' · ' + d.ventas + ' venta(s)';
      return '<g class="dia" tabindex="0"><title>' + M.esc(tip) + '</title>' +
        '<rect x="' + x + '" y="' + pad.t + '" width="' + w + '" height="' + (H - pad.t - pad.b) + '" fill="transparent"></rect>' +
        (h ? '<path d="M' + x + ',' + (H - pad.b) + 'V' + (y + 4) + 'q0,-4 4,-4h' + (w - 8) + 'q4,0 4,4V' + (H - pad.b) + 'Z" class="barra' + (d.fecha > hoy ? ' futura' : '') + '"></path>' : '') +
        (v ? '<text x="' + (x + w / 2) + '" y="' + (y - 4) + '" class="valor">' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v) + '</text>' : '') +
        '<text x="' + (x + w / 2) + '" y="' + (H - 8) + '" class="eje' + (d.fecha === hoy ? ' hoy' : '') + '">' + etiqueta + '</text></g>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="grafico" role="img" aria-label="Facturado por día">' +
      '<line x1="0" x2="' + W + '" y1="' + (H - pad.b) + '" y2="' + (H - pad.b) + '" class="base"></line>' + barras + '</svg>';
  }

  // Barras horizontales (profesionales, tratamientos).
  function barrasH(filas, valor, etiqueta, detalle) {
    const max = Math.max(1, ...filas.map(valor));
    return '<div class="hbarras">' + filas.map((f) => '<div class="hfila"><div class="hnombre">' + M.esc(etiqueta(f)) + '</div>' +
      '<div class="hpista"><div class="hbarra" style="width:' + Math.max(1, valor(f) / max * 100) + '%"></div></div>' +
      '<div class="hvalor">' + P(valor(f)) + (detalle ? '<small>' + detalle(f) + '</small>' : '') + '</div></div>').join('') + '</div>';
  }

  async function cargar() {
    const desde = iso(lunes), hasta = iso(mas(lunes, 6));
    $('#semanaTitulo').textContent = 'Semana del ' + M.fechaCorta(desde).slice(0, 5) + ' al ' + M.fechaCorta(hasta);
    $('#semanaSig').disabled = iso(lunesDe(new Date())) <= desde;
    const { data, error } = await sb.rpc('resumen_periodo', { p_desde: desde, p_hasta: hasta });
    const el = $('#semanaDatos');
    if (error) {
      el.innerHTML = '<p class="tenue">' + (/resumen_periodo/.test(error.message || '') ? 'Falta correr 07_mejoras.sql en Supabase.' : M.esc(M.mensaje(error))) + '</p>';
      return;
    }
    const d = data;
    const kpi = (t, v, det, cl) => '<div class="kpi ' + (cl || '') + '"><small>' + t + '</small><b>' + v + '</b>' + (det ? '<div class="det">' + det + '</div>' : '') + '</div>';
    el.innerHTML =
      '<div class="kpis">' +
        kpi('Facturado', P(d.facturado), variacion(Number(d.facturado), Number(d.previo.facturado)), 'destacado') +
        kpi('Ticket promedio', d.ticket_promedio == null ? '—' : P(d.ticket_promedio), d.ventas + ' venta(s) con importe') +
        kpi('Atenciones', d.atenciones, d.pacientes + ' paciente(s) · ' + d.pacientes_nuevas + ' nueva(s)') +
        kpi('Cobrado', P(d.cobrado), Number(d.sin_cobrar) ? '<span class="error">' + P(d.sin_cobrar) + ' sin cobrar</span>' : 'nada sin cobrar') +
        kpi('Comisiones', P(d.comisiones), Number(d.terceros) ? P(d.terceros) + ' para terceros' : '') +
        kpi('Descuentos', P(d.descuentos), 'lista − cobrado') +
      '</div>' +
      '<div class="dos" style="margin-top:14px">' +
        '<div><h3>Facturado por día</h3>' + barrasDias(d.por_dia) + '</div>' +
        '<div><h3>Por profesional</h3>' + (d.por_profesional.length ? barrasH(d.por_profesional, (f) => Number(f.facturado), (f) => f.profesional,
          (f) => f.atenciones + (Number(f.atenciones) === 1 ? ' atención · ' : ' atenciones · ') + (f.modelo === 'interno' ? 'comisión ' + P(f.comision) : 'su parte ' + P(f.tercero))) : '<p class="tenue">Sin atenciones.</p>') +
        '<h3>Lo más vendido</h3>' + (d.top.length ? barrasH(d.top, (f) => Number(f.facturado), (f) => f.nombre, (f) => f.cantidad + (Number(f.cantidad) === 1 ? ' vez' : ' veces')) : '<p class="tenue">Sin ventas.</p>') +
        '</div>' +
      '</div>' +
      '<details style="margin-top:10px"><summary>Ver como tabla</summary><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Día</th><th class="num">Ventas</th><th class="num">Facturado</th></tr></thead><tbody>' +
        d.por_dia.map((x) => '<tr><td>' + DIAS[fecha(x.fecha).getDay()] + ' ' + M.fechaCorta(x.fecha) + '</td><td class="num">' + x.ventas + '</td><td class="num">' + P(x.facturado) + '</td></tr>').join('') +
        '</tbody></table></div></details>';
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.id === 'semanaAnt') { lunes = mas(lunes, -7); cargar(); }
    if (t.id === 'semanaSig') { lunes = mas(lunes, 7); cargar(); }
    if (t.id === 'semanaHoy') { lunes = lunesDe(new Date()); cargar(); }
  });

  window.MEKSemana = { iniciar() { lunes = lunesDe(new Date()); cargar(); }, recargar: cargar };
})();
