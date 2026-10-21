// Liquidaciones (solo Franco). Todo el cálculo lo hace la base:
// preview_liquidacion, cerrar_liquidacion, pagar_liquidacion.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  let profs = [], preview = null, ajustesManuales = [], liquidaciones = [];
  let desdeTocado = false;          // si Franco cambió "Desde", no se pisa
  let hoyDatos = [];                // vista previa al día de hoy, por profesional
  let adelanto = null;              // {prof, monto, medio, fecha, cid}
  let ajusteHoy = null;             // {prof, signo, monto, motivo}: ajuste sin cerrar
  let corrigiendo = null;           // venta_item_id al que se le cambia quién lo hizo

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
    if (!desdeTocado || !$('#desde').value) $('#desde').value = data.desde_sugerido || $('#hasta').value;
    renderPreview();
  }

  // ------------------------------------------------------------ al día de hoy
  async function cargarHoy() {
    const res = await Promise.all(profs.map((p) => sb.rpc('preview_liquidacion', { p_prof: p.id, p_hasta: M.hoy() })));
    hoyDatos = res.map((r, i) => (r.error ? null : Object.assign(r.data, { id: profs[i].id }))).filter(Boolean);
    renderHoy();
  }

  function renderHoy() {
    const con = hoyDatos.filter((d) => d.items.length || d.ajustes.length);
    $('#hoy').innerHTML = con.length ? con.map((d) => {
      const neto = M.r2(Number(d.total) + Number(d.total_ajustes));
      const adel = d.ajustes.filter((a) => a.origen === 'adelanto');
      const sumAdel = M.r2(adel.reduce((a, x) => a + Number(x.monto), 0));
      const otros = M.r2(Number(d.total_ajustes) - sumAdel);
      return '<div class="kpi destacado"><small>' + M.esc(d.profesional) + (d.modelo === 'interno' ? '' : ' (tercero)') + ' · se le debe hoy</small>' +
        '<b>' + M.plata(neto) + '</b><div class="det">' + M.plata(d.total) + ' de ' + d.items.length + ' atención(es)' +
        (d.ultima_hasta ? ' desde el ' + M.fechaCorta(d.desde_sugerido) : '') +
        (adel.length ? '<br>− ' + M.plata(-sumAdel) + ' adelantado (' + adel.length + ')' : '') +
        (otros ? '<br>' + (otros < 0 ? '− ' : '+ ') + M.plata(Math.abs(otros)) + ' de ajustes' : '') +
        (d.sin_regla.length ? '<br><span class="error">' + d.sin_regla.length + ' sin regla de comisión</span>' : '') +
        (d.pendientes_cobro.length ? '<br>' + d.pendientes_cobro.length + ' atención(es) sin cobrar, todavía no suman' : '') + '</div>' +
        '<div class="fila" style="margin-top:8px"><button type="button" class="primario" data-adelantar="' + d.id + '">Registrar adelanto</button>' +
        '<button type="button" class="secundario" style="width:auto" data-ajustar="' + d.id + '">Ajuste (+ o −)</button>' +
        '<button type="button" class="link" data-verprof="' + d.id + '">ver detalle</button></div></div>';
    }).join('') : '<p class="tenue">Nadie tiene nada pendiente de liquidar.</p>';
    // Para ajustar a alguien que hoy no tiene nada pendiente.
    const sin = profs.filter((p) => !con.some((d) => d.id === p.id));
    if (sin.length) $('#hoy').insertAdjacentHTML('beforeend', '<div class="fila tenue" style="margin-top:8px;grid-column:1/-1">Ajuste a ' +
      sin.map((p) => '<button type="button" class="link" data-ajustar="' + p.id + '">' + M.esc(p.nombre) + '</button>').join(' ') + '</div>');
    renderAdelanto();
    renderAjusteHoy();
  }

  // Ajuste a mano sin cerrar: queda pendiente y entra en el próximo cierre.
  function renderAjusteHoy() {
    const el = $('#ajusteHoy');
    if (!el) return;
    if (!ajusteHoy) { el.innerHTML = ''; return; }
    const p = profs.find((x) => x.id === ajusteHoy.prof) || {};
    el.innerHTML = '<div class="pend" style="margin-top:12px"><b>Ajuste a ' + M.esc(p.nombre || '') + '</b>' +
      '<div class="tenue">Queda anotado y se aplica solo en su próxima liquidación. Para deshacerlo, cargá el contrario.</div>' +
      '<div class="medios" style="margin-top:8px">' +
        '<button type="button" class="medio' + (ajusteHoy.signo === -1 ? ' activo' : '') + '" data-ajsigno="-1">− Descontarle</button>' +
        '<button type="button" class="medio' + (ajusteHoy.signo === 1 ? ' activo' : '') + '" data-ajsigno="1">+ Sumarle</button></div>' +
      '<div class="form" style="margin-top:8px"><label>Monto $ <input type="number" id="ajhMonto" min="0" step="0.01" inputmode="decimal" value="' + M.esc(ajusteHoy.monto) + '"></label>' +
      '<label class="ancho">Motivo <input id="ajhMotivo" value="' + M.esc(ajusteHoy.motivo) + '" placeholder="Ej: depilación del 18/10 la hizo Silvia"></label></div>' +
      '<div class="acciones fila"><button type="button" class="primario" id="ajhGuardar">Guardar ajuste</button>' +
      '<button type="button" class="link" id="ajhCancelar">cancelar</button></div></div>';
  }

  async function guardarAjusteHoy() {
    // Se lee del formulario al tocar el botón (no se espera al "change").
    const monto = M.numero($('#ajhMonto').value);
    const motivo = $('#ajhMotivo').value.trim();
    if (!ajusteHoy.signo) { M.toast('Elegí si se le descuenta o se le suma', 'error'); return; }
    if (!(monto > 0)) { M.toast('Falta el monto', 'error'); return; }
    if (!motivo) { M.toast('Falta el motivo', 'error'); return; }
    const { error } = await sb.rpc('registrar_ajuste', { p_prof: ajusteHoy.prof, p_monto: ajusteHoy.signo * monto, p_motivo: motivo });
    if (error) { M.toast(/registrar_ajuste/.test(error.message || '') ? 'Falta correr 09_correcciones.sql en Supabase' : M.mensaje(error), 'error'); return; }
    M.toast('Ajuste de ' + (ajusteHoy.signo < 0 ? '−' : '+') + M.plata(monto) + ' anotado', 'ok');
    ajusteHoy = null;
    await cargarHoy();
    if (preview) ver();
  }

  async function corregir(itemId) {
    const prof = Number($('#corrProf').value);
    const motivo = $('#corrMotivo').value.trim();
    if (!prof) { M.toast('Elegí quién lo hizo', 'error'); return; }
    if (!motivo) { M.toast('Falta el motivo', 'error'); return; }
    const { data, error } = await sb.rpc('corregir_profesional', { p_item: itemId, p_prof: prof, p_motivo: motivo });
    if (error) { M.toast(/corregir_profesional/.test(error.message || '') ? 'Falta correr 09_correcciones.sql en Supabase' : M.mensaje(error), 'error'); return; }
    M.toast(data.sin_cambios ? 'Ya figuraba así' : 'Listo: ahora figura ' + data.ahora +
      (data.comision_ahora == null ? ' (sin regla de comisión: cargala en Precios)' : ''), data.comision_ahora == null ? 'error' : 'ok');
    corrigiendo = null;
    await ver();
    cargarHoy();
  }

  function renderAdelanto() {
    const el = $('#adelanto');
    if (!adelanto) { el.innerHTML = ''; return; }
    const d = hoyDatos.find((x) => x.id === adelanto.prof);
    const neto = d ? M.r2(Number(d.total) + Number(d.total_ajustes)) : 0;
    el.innerHTML = '<div class="pend" style="margin-top:12px"><b>Adelanto a ' + M.esc(d ? d.profesional : '') + '</b>' +
      '<div class="tenue">Hoy se le debe ' + M.plata(neto) + '. Lo que le adelantes se descuenta solo al cerrar la semana.</div>' +
      '<div class="form" style="margin-top:8px"><label>Monto $ <input type="number" id="adMonto" min="0" step="0.01" inputmode="decimal" value="' + M.esc(adelanto.monto) + '"></label>' +
      '<label>Fecha <input type="date" id="adFecha" value="' + M.esc(adelanto.fecha) + '"></label></div>' +
      '<div class="medios" style="margin-top:8px">' + M.MEDIOS.map(([k, n]) => '<button type="button" class="medio' + (adelanto.medio === k ? ' activo' : '') +
        '" data-admedio="' + k + '">' + n + '</button>').join('') + '</div>' +
      (Number(adelanto.monto) > neto && neto >= 0 ? '<div class="aviso">Es más de lo que se le debe hoy: la diferencia se le descuenta de lo que gane después.</div>' : '') +
      '<div class="acciones fila"><button type="button" class="primario" id="adGuardar">Registrar adelanto</button>' +
      (neto > 0 ? '<button type="button" class="link" id="adTodo">todo lo de hoy (' + M.plata(neto) + ')</button>' : '') +
      '<button type="button" class="link" id="adCancelar">cancelar</button></div></div>';
  }

  async function guardarAdelanto() {
    const monto = M.numero(adelanto.monto);
    if (!(monto > 0)) { M.toast('Falta el monto', 'error'); return; }
    if (!adelanto.medio) { M.toast('Elegí el medio de pago', 'error'); return; }
    adelanto.cid = adelanto.cid || window.Cola.uuid();   // mismo id si se reintenta: no duplica
    const { error } = await sb.rpc('registrar_adelanto', { p_prof: adelanto.prof, p_monto: monto, p_fecha: adelanto.fecha,
      p_medio: adelanto.medio, p_client_id: adelanto.cid });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Adelanto de ' + M.plata(monto) + ' registrado', 'ok');
    adelanto = null;
    await cargarHoy();
    if (preview) ver();
  }

  function renderPreview() {
    const p = preview;
    const el = $('#preview');
    if (!p) { el.innerHTML = ''; return; }
    const queCobra = p.modelo === 'interno' ? 'Comisión' : 'Le corresponde';
    const manual = ajustesManuales.reduce((a, x) => a + (M.numero(x.monto) || 0), 0);
    const neto = M.r2(Number(p.total) + Number(p.total_ajustes) + manual);
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
        M.esc(i.descripcion) + ' <button type="button" class="link" data-corregir="' + i.venta_item_id + '" title="Si lo cargaron a nombre de otra">no lo hizo ' +
        M.esc(p.profesional.split(' ')[0]) + '</button></td><td class="num">' + M.plata(i.cobrado) + '</td><td class="num">' + M.plata(i.monto) + '</td></tr>' +
        (corrigiendo === i.venta_item_id ? '<tr><td colspan="5"><div class="fila">Lo hizo <select id="corrProf"><option value="">— elegir —</option>' +
          profs.filter((x) => x.nombre !== p.profesional).map((x) => '<option value="' + x.id + '">' + M.esc(x.nombre) + '</option>').join('') +
          '</select> <input id="corrMotivo" placeholder="Motivo (ej. se cargó mal)" style="max-width:260px">' +
          '<button type="button" class="primario" data-corrguardar="' + i.venta_item_id + '">Corregir</button>' +
          '<button type="button" class="link" data-corrcancelar>cancelar</button></div>' +
          '<div class="tenue">Se le saca a ' + M.esc(p.profesional) + ' y se recalcula la comisión con la regla de la que lo hizo (Silvia no cobra comisión).</div></td></tr>' : '')).join('')
        : '<tr><td colspan="5" class="tenue">No hay cobros nuevos para liquidar.</td></tr>') +
      '<tr class="total"><td colspan="4">Subtotal (' + p.items.length + ')</td><td class="num">' + M.plata(p.total) + '</td></tr>' +
      p.ajustes.map((a) => '<tr><td colspan="4">Ajuste: ' + M.esc(a.motivo) + '</td><td class="num">' + M.plata(a.monto) + '</td></tr>').join('') +
      ajustesManuales.map((a, i) => '<tr><td colspan="3"><input data-ajmotivo="' + i + '" placeholder="Motivo del ajuste" value="' + M.esc(a.motivo) +
        '"></td><td><button type="button" class="link" data-ajsacar="' + i + '">sacar</button></td><td class="num"><input type="number" step="0.01" data-ajmonto="' + i +
        '" value="' + M.esc(a.monto) + '" placeholder="± monto" style="width:120px"></td></tr>').join('') +
      '<tr><td colspan="5"><button type="button" class="link" id="agregarAjuste">+ ajuste a mano (premio, descuento, corrección)</button></td></tr>' +
      '<tr class="total"><td colspan="4">A pagar</td><td class="num" id="aPagar">' + M.plata(neto) + '</td></tr>' +
      '</tbody></table></div>' +
      (neto < 0 ? '<p class="aviso">El saldo da negativo: no se paga nada y la diferencia se descuenta en la próxima.</p>' : '') +
      '<div class="form" style="margin-top:12px">' +
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
    desdeTocado = false;
    renderPreview();
    cargarHoy();
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
    cargarHoy();
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
    if (d.adelantar) { adelanto = { prof: Number(d.adelantar), monto: '', medio: null, fecha: M.hoy(), cid: null }; renderAdelanto(); $('#adMonto').focus(); }
    if (d.admedio) { adelanto.medio = d.admedio; renderAdelanto(); }
    if (t.id === 'adGuardar') guardarAdelanto();
    if (t.id === 'adCancelar') { adelanto = null; renderAdelanto(); }
    if (t.id === 'adTodo') {
      const x = hoyDatos.find((y) => y.id === adelanto.prof);
      adelanto.monto = M.r2(Number(x.total) + Number(x.total_ajustes)); adelanto.cid = null; renderAdelanto();
    }
    if (t.id === 'refrescarHoy') cargarHoy();
    if (d.ajustar) { ajusteHoy = { prof: Number(d.ajustar), signo: -1, monto: '', motivo: '' }; renderAjusteHoy(); $('#ajhMonto').focus(); }
    if (d.ajsigno) { ajusteHoy.monto = $('#ajhMonto').value; ajusteHoy.motivo = $('#ajhMotivo').value; ajusteHoy.signo = Number(d.ajsigno); renderAjusteHoy(); }
    if (t.id === 'ajhGuardar') guardarAjusteHoy();
    if (t.id === 'ajhCancelar') { ajusteHoy = null; renderAjusteHoy(); }
    if (d.corregir) { corrigiendo = Number(d.corregir); renderPreview(); }
    if (d.corrcancelar !== undefined) { corrigiendo = null; renderPreview(); }
    if (d.corrguardar) corregir(Number(d.corrguardar));
    if (d.verprof) {
      $('#prof').value = d.verprof; desdeTocado = false; $('#hasta').value = M.hoy();
      ver().then(() => $('#preview').scrollIntoView({ behavior: 'smooth' }));
    }
    if (d.pagar) pagar(Number(d.pagar));
  });
  // Ajustes a mano del cierre: se guardan mientras se escribe y solo se
  // actualiza el total. Antes se redibujaba la tabla al salir del campo y
  // el clic en "Cerrar liquidación" que venía justo después se perdía.
  document.addEventListener('input', (ev) => {
    const d = ev.target.dataset;
    if (d.ajmotivo !== undefined) ajustesManuales[Number(d.ajmotivo)].motivo = ev.target.value;
    if (d.ajmonto !== undefined) {
      ajustesManuales[Number(d.ajmonto)].monto = ev.target.value;
      const manual = ajustesManuales.reduce((a, x) => a + (M.numero(x.monto) || 0), 0);
      const el = $('#aPagar');
      if (el && preview) el.textContent = M.plata(M.r2(Number(preview.total) + Number(preview.total_ajustes) + manual));
    }
  });
  document.addEventListener('change', (ev) => {
    const d = ev.target.dataset;
    if (ev.target.id === 'prof') { desdeTocado = false; preview = null; renderPreview(); }
    if (ev.target.id === 'hasta') { preview = null; renderPreview(); }
    if (ev.target.id === 'desde') desdeTocado = true;
    if (ev.target.id === 'adMonto') { adelanto.monto = ev.target.value; adelanto.cid = null; renderAdelanto(); }
    if (ev.target.id === 'adFecha') adelanto.fecha = ev.target.value;
  });

  async function iniciar() {
    const u = await M.requerirSesion('liquidaciones', { admin: true });
    if (!u) return;
    M.salirBoton();
    $('#hasta').value = ultimoSabado();
    try { await cargarProfs(); } catch (e) { M.toast(M.mensaje(e), 'error'); return; }
    cargarHoy();
    cargarHistorial();
    if (window.MEKSemana) window.MEKSemana.iniciar();
  }
  iniciar();
})();
