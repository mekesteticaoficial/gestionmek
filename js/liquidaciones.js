// Liquidaciones (solo Franco). Todo el cálculo lo hace la base:
// preview_liquidacion, cerrar_liquidacion, pagar_liquidacion.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  let profs = [], preview = null, ajustesManuales = [], liquidaciones = [];

  // Sábado más reciente (la semana de Yael cierra el sábado).
  function ultimoSabado() {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
    return d.toLocaleDateString('en-CA');
  }

  async function cargarProfs() {
    const { data, error } = await sb.from('profesionales').select('*').eq('activo', true).order('id');
    if (error) throw error;
    profs = data.filter((p) => p.modelo !== 'invitado_cobra_el');
    $('#prof').innerHTML = profs.map((p) => '<option value="' + p.id + '">' + M.esc(p.nombre) +
      (p.modelo === 'interno' ? ' (comisión)' : ' (tercero)') + '</option>').join('');
    const yael = profs.find((p) => /yael/i.test(p.nombre));
    if (yael) $('#prof').value = yael.id;
  }

  async function ver() {
    const { data, error } = await sb.rpc('preview_liquidacion', { p_prof: Number($('#prof').value), p_hasta: $('#hasta').value });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    preview = data;
    ajustesManuales = [];
    renderPreview();
  }

  function renderPreview() {
    const p = preview;
    const el = $('#preview');
    if (!p) { el.innerHTML = ''; return; }
    const queCobra = p.modelo === 'interno' ? 'Comisión' : 'Le corresponde';
    const manual = ajustesManuales.reduce((a, x) => a + (M.numero(x.monto) || 0), 0);
    const neto = M.r2(Number(p.total) + Number(p.total_ajustes) + manual);
    const desde = p.desde_sugerido || $('#hasta').value;
    const bloqueado = p.sin_regla.length > 0;

    el.innerHTML =
      '<h3>' + M.esc(p.profesional) + ' · hasta el ' + M.fechaCorta($('#hasta').value) +
        (p.ultima_hasta ? ' <span class="tenue">(la anterior cerró el ' + M.fechaCorta(p.ultima_hasta) + ')</span>' : '') + '</h3>' +
      (bloqueado ? '<div class="alerta">⚠ Hay ' + p.sin_regla.length + ' cobro(s) sin regla de comisión: ' +
         p.sin_regla.map((s) => M.esc(s.descripcion) + ' (' + M.fechaCorta(s.fecha) + ')').join(', ') +
         '. No se puede cerrar hasta resolverlos, porque se pagaría de menos. Cargá la regla en <a href="catalogo.html#comisiones">Precios → Comisiones</a> y después ' +
         '<button type="button" class="link" id="resolver">recalcular los que no tenían regla</button>.</div>' : '') +
      (p.pendientes_cobro.length ? '<div class="aviso">' + p.pendientes_cobro.length + ' atención(es) todavía sin cobrar: ' +
         p.pendientes_cobro.map((s) => M.esc(s.paciente || '') + ' · ' + M.esc(s.descripcion)).join('; ') +
         '. Entran cuando se cobren, en la liquidación que siga.</div>' : '') +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Fecha</th><th>Paciente</th><th>Qué</th><th class="num">Cobrado</th><th class="num">' +
        queCobra + '</th></tr></thead><tbody>' +
      (p.items.length ? p.items.map((i) => '<tr><td>' + M.fechaCorta(i.fecha) + '</td><td>' + M.esc(i.paciente || '') + '</td><td>' +
        M.esc(i.descripcion) + '</td><td class="num">' + M.plata(i.cobrado) + '</td><td class="num">' + M.plata(i.monto) + '</td></tr>').join('')
        : '<tr><td colspan="5" class="tenue">No hay cobros nuevos para liquidar.</td></tr>') +
      '<tr class="total"><td colspan="4">Subtotal (' + p.items.length + ')</td><td class="num">' + M.plata(p.total) + '</td></tr>' +
      p.ajustes.map((a) => '<tr><td colspan="4">Ajuste: ' + M.esc(a.motivo) + '</td><td class="num">' + M.plata(a.monto) + '</td></tr>').join('') +
      ajustesManuales.map((a, i) => '<tr><td colspan="3"><input data-ajmotivo="' + i + '" placeholder="Motivo del ajuste" value="' + M.esc(a.motivo) +
        '"></td><td><button type="button" class="link" data-ajsacar="' + i + '">sacar</button></td><td class="num"><input type="number" step="0.01" data-ajmonto="' + i +
        '" value="' + M.esc(a.monto) + '" placeholder="± monto" style="width:120px"></td></tr>').join('') +
      '<tr><td colspan="5"><button type="button" class="link" id="agregarAjuste">+ ajuste a mano (premio, descuento, corrección)</button></td></tr>' +
      '<tr class="total"><td colspan="4">A pagar</td><td class="num">' + M.plata(neto) + '</td></tr>' +
      '</tbody></table></div>' +
      (neto < 0 ? '<p class="aviso">El saldo da negativo: no se paga nada y la diferencia se descuenta en la próxima.</p>' : '') +
      '<div class="form" style="margin-top:12px">' +
        '<label>Desde <input type="date" id="desde" value="' + M.esc(desde) + '"></label>' +
        '<label class="ancho">Nota <input id="nota" placeholder="Opcional"></label>' +
        '<div><button type="button" class="primario" id="cerrar"' + (bloqueado ? ' disabled' : '') + '>Cerrar liquidación</button></div>' +
      '</div>';
  }

  async function cerrar() {
    const p = preview;
    const aj = ajustesManuales.map((a) => ({ monto: M.numero(a.monto), motivo: (a.motivo || '').trim() })).filter((a) => a.monto);
    if (aj.some((a) => !a.motivo)) { M.toast('Cada ajuste a mano necesita un motivo', 'error'); return; }
    const neto = M.r2(Number(p.total) + Number(p.total_ajustes) + aj.reduce((s, a) => s + a.monto, 0));
    if (!confirm('Cerrar la liquidación de ' + p.profesional + ' del ' + M.fechaCorta($('#desde').value) + ' al ' +
                 M.fechaCorta($('#hasta').value) + ' por ' + M.plata(neto) + '?\n\nUna vez cerrada no se modifica.')) return;
    const { data, error } = await sb.rpc('cerrar_liquidacion', {
      p_prof: Number($('#prof').value), p_desde: $('#desde').value, p_hasta: $('#hasta').value,
      p_ajustes: aj, p_nota: $('#nota').value || null,
    });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Liquidación ' + data + ' cerrada', 'ok');
    preview = null;
    renderPreview();
    await cargarHistorial();
    verDetalle(data);
  }

  async function cargarHistorial() {
    const { data, error } = await sb.from('liquidaciones').select('*').order('id', { ascending: false }).range(0, 59);
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    liquidaciones = data;
    const nombre = (id) => (profs.find((p) => p.id === id) || {}).nombre || id;
    $('#historial').innerHTML = '<thead><tr><th>#</th><th>Profesional</th><th>Período</th><th class="num">Devengado</th><th class="num">Ajustes</th>' +
      '<th class="num">A pagar</th><th>Estado</th><th></th></tr></thead><tbody>' +
      (data.length ? data.map((l) => {
        const neto = M.r2(Number(l.total) + Number(l.ajustes));
        return '<tr><td>' + l.id + '</td><td>' + M.esc(nombre(l.profesional_id)) + '</td><td>' + M.fechaCorta(l.desde) + ' al ' + M.fechaCorta(l.hasta) +
          '</td><td class="num">' + M.plata(l.total) + '</td><td class="num">' + (Number(l.ajustes) ? M.plata(l.ajustes) : '—') +
          '</td><td class="num"><b>' + M.plata(neto) + '</b></td><td>' +
          (l.estado === 'pagada' ? '<span class="pill ok">pagada ' + M.fechaCorta(l.pagada_en) + '</span>' : '<span class="pill espera">a pagar</span>') +
          '</td><td><button type="button" class="link" data-detalle="' + l.id + '">ver</button>' +
          (l.estado === 'cerrada' ? ' <button type="button" class="link" data-pagar="' + l.id + '">pagar</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="tenue">Todavía no se cerró ninguna.</td></tr>') + '</tbody>';
  }

  async function verDetalle(id) {
    const l = liquidaciones.find((x) => x.id === id);
    if (!l) return;
    const [li, aj] = await Promise.all([
      sb.from('liquidacion_items').select('*').eq('liquidacion_id', id),
      sb.from('liquidacion_ajustes').select('*').eq('liquidacion_id', id),
    ]);
    if (li.error || aj.error) { M.toast(M.mensaje(li.error || aj.error), 'error'); return; }
    const ids = li.data.map((x) => x.venta_item_id);
    let items = [];
    if (ids.length) {
      const r = await sb.from('venta_items').select('id,descripcion,precio_cobrado,venta_id').in('id', ids);
      if (r.error) { M.toast(M.mensaje(r.error), 'error'); return; }
      items = r.data;
    }
    const ventas = items.length ? (await sb.from('ventas').select('id,fecha,paciente_ref').in('id', [...new Set(items.map((i) => i.venta_id))])).data || [] : [];
    const prof = (profs.find((p) => p.id === l.profesional_id) || {}).nombre || '';
    const neto = M.r2(Number(l.total) + Number(l.ajustes));
    const filas = li.data.map((x) => {
      const i = items.find((y) => y.id === x.venta_item_id) || {};
      const v = ventas.find((y) => y.id === i.venta_id) || {};
      return { fecha: v.fecha, desc: i.descripcion, cobrado: i.precio_cobrado, monto: x.monto };
    }).sort((a, b) => (a.fecha > b.fecha ? 1 : -1));
    const resumen = 'Liquidación ' + prof + ' del ' + M.fechaCorta(l.desde) + ' al ' + M.fechaCorta(l.hasta) + '\n' +
      filas.map((f) => M.fechaCorta(f.fecha) + ' · ' + f.desc + ' · ' + M.plata(f.monto)).join('\n') + '\n' +
      'Subtotal: ' + M.plata(l.total) + '\n' +
      aj.data.map((a) => 'Ajuste: ' + a.motivo + ' ' + M.plata(a.monto)).join('\n') + (aj.data.length ? '\n' : '') +
      'A pagar: ' + M.plata(neto);
    $('#detalle').innerHTML = '<h3>Liquidación ' + l.id + ' · ' + M.esc(prof) + '</h3>' +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Fecha</th><th>Qué</th><th class="num">Cobrado</th><th class="num">Monto</th></tr></thead><tbody>' +
      filas.map((f) => '<tr><td>' + M.fechaCorta(f.fecha) + '</td><td>' + M.esc(f.desc) + '</td><td class="num">' + M.plata(f.cobrado) +
        '</td><td class="num">' + M.plata(f.monto) + '</td></tr>').join('') +
      aj.data.map((a) => '<tr><td></td><td>Ajuste: ' + M.esc(a.motivo) + '</td><td></td><td class="num">' + M.plata(a.monto) + '</td></tr>').join('') +
      '<tr class="total"><td colspan="3">A pagar</td><td class="num">' + M.plata(neto) + '</td></tr></tbody></table></div>' +
      '<button type="button" class="secundario" style="width:auto;border-color:var(--marca);color:var(--marca)" id="copiar">Copiar resumen para mandar</button>';
    $('#copiar').onclick = async () => {
      try { await navigator.clipboard.writeText(resumen); M.toast('Copiado: pegalo en WhatsApp', 'ok'); }
      catch (e) { prompt('Copiá el resumen:', resumen); }
    };
    $('#detalle').scrollIntoView({ behavior: 'smooth' });
  }

  async function pagar(id) {
    const l = liquidaciones.find((x) => x.id === id);
    const neto = M.r2(Number(l.total) + Number(l.ajustes));
    let medio = null;
    if (neto > 0) {
      medio = prompt('Pagar ' + M.plata(neto) + '. ¿Con qué medio?\n(efectivo, transferencia, debito, credito, mercadopago)', 'efectivo');
      if (!medio) return;
      medio = M.norm(medio).replace(/\s/g, '');
      if (!M.MEDIOS.some(([k]) => k === medio)) { M.toast('Medio no reconocido', 'error'); return; }
    } else if (!confirm('El saldo es ' + M.plata(neto) + ': no se paga nada y la diferencia pasa a la próxima. ¿Marcar como resuelta?')) return;
    const fecha = prompt('Fecha del pago (AAAA-MM-DD):', M.hoy());
    if (!fecha) return;
    const { error } = await sb.rpc('pagar_liquidacion', { p_liq: id, p_fecha: fecha, p_medio: medio });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Pagada. Queda registrada como gasto.', 'ok');
    cargarHistorial();
  }

  async function resolver() {
    const { data, error } = await sb.rpc('resolver_items_sin_regla');
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast(data.resueltos + ' resuelto(s); quedan ' + data.quedan + ' sin regla', data.quedan ? 'error' : 'ok');
    ver();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (t.id === 'ver') ver();
    if (t.id === 'cerrar') cerrar();
    if (t.id === 'resolver') resolver();
    if (t.id === 'agregarAjuste') { ajustesManuales.push({ monto: '', motivo: '' }); renderPreview(); }
    if (d.ajsacar) { ajustesManuales.splice(Number(d.ajsacar), 1); renderPreview(); }
    if (d.detalle) verDetalle(Number(d.detalle));
    if (d.pagar) pagar(Number(d.pagar));
  });
  document.addEventListener('change', (ev) => {
    const d = ev.target.dataset;
    if (d.ajmonto !== undefined) { ajustesManuales[Number(d.ajmonto)].monto = ev.target.value; renderPreview(); }
    if (d.ajmotivo !== undefined) { ajustesManuales[Number(d.ajmotivo)].motivo = ev.target.value; }
    if (ev.target.id === 'prof' || ev.target.id === 'hasta') { preview = null; renderPreview(); }
  });

  async function iniciar() {
    const u = await M.requerirSesion('liquidaciones', { admin: true });
    if (!u) return;
    M.salirBoton();
    $('#hasta').value = ultimoSabado();
    try { await cargarProfs(); } catch (e) { M.toast(M.mensaje(e), 'error'); return; }
    cargarHistorial();
  }
  iniciar();
})();
