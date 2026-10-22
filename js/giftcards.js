// Gift cards (sql/12_giftcards_y_controles.sql). Se venden acá; se usan
// desde Cobro como medio de pago ("Gift card"). El saldo lo calcula la
// base (v_gift_cards): monto menos lo usado en ventas no anuladas.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  let cards = M.LS.get('giftcards_todas', []);
  let usos = {};             // gift_card_id -> [{fecha, monto, descripcion, estado}]
  let pacientes = M.LS.get('pacientes', []);
  let form = null;           // la gift card que se está cargando

  const vacia = () => ({ cid: window.Cola.uuid(), paciente: null, beneficiaria: '', buscar: '', regala: '', descripcion: '',
    monto: '', fecha: M.hoy(), vence: '', caja: true, medio: null, cuenta: '', nota: '' });

  async function cargar() {
    const { data, error } = await sb.from('v_gift_cards').select('*').order('fecha', { ascending: false });
    if (error) {
      $('#lista').innerHTML = '<section class="card"><p class="error">' + M.esc(/gift_cards/.test(error.message || '') ? 'Falta correr 12_giftcards_y_controles.sql en Supabase.' : M.mensaje(error)) + '</p></section>';
      return;
    }
    cards = data;
    M.LS.set('giftcards_todas', cards);
    // Los usos: pagos con gift card y lo que se hizo en esa venta.
    const ids = cards.map((c) => c.id);
    usos = {};
    if (ids.length) {
      const pg = await sb.from('venta_pagos').select('gift_card_id,monto,fecha,venta_id').in('gift_card_id', ids);
      if (!pg.error && pg.data.length) {
        const vs = await sb.from('ventas').select('id,estado,venta_items(descripcion)').in('id', [...new Set(pg.data.map((x) => x.venta_id))]);
        const porVenta = {};
        (vs.data || []).forEach((v) => { porVenta[v.id] = v; });
        pg.data.forEach((x) => {
          const v = porVenta[x.venta_id] || {};
          (usos[x.gift_card_id] = usos[x.gift_card_id] || []).push({ fecha: x.fecha, monto: x.monto, estado: v.estado,
            descripcion: (v.venta_items || []).map((i) => i.descripcion).join(' + ') });
        });
        Object.values(usos).forEach((l) => l.sort((a, b) => (a.fecha < b.fecha ? -1 : 1)));
      }
    }
    render();
  }

  async function cargarPacientes() {
    try { pacientes = await M.leerTodo('pacientes', 'ref,nombre,telefono', null, 'ref'); M.LS.set('pacientes', pacientes); } catch (e) { /* lista guardada */ }
  }
  function buscarPac(q) {
    const w = M.norm(q).split(/\s+/).filter(Boolean);
    if (!w.length) return [];
    return pacientes.filter((p) => p.ref !== 'x_ocasional' && w.every((x) => M.norm(p.nombre).includes(x)))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, 8);
  }

  function render() {
    const f = M.norm($('#buscar').value);
    const verUsadas = $('#usadas').checked;
    const activas = cards.filter((c) => !c.anulada_en && Number(c.saldo) > 0);
    $('#resumen').innerHTML =
      '<div class="kpi destacado"><small>Gift cards con saldo</small><b>' + activas.length + '</b></div>' +
      '<div class="kpi"><small>Saldo a favor de las clientas</small><b>' + M.plata(activas.reduce((a, c) => a + Number(c.saldo), 0)) +
        '</b><div class="det">tratamientos ya pagados, por hacer</div></div>';
    const lista = cards.filter((c) => (verUsadas || (!c.anulada_en && Number(c.saldo) > 0)) &&
      (!f || M.norm(c.beneficiaria + ' ' + (c.regala || '') + ' ' + (c.descripcion || '')).includes(f)));
    $('#lista').innerHTML = lista.length ? '<div class="packs-grilla">' + lista.map((c) => {
      const u = usos[c.id] || [];
      const pct = Math.max(0, Math.min(100, Number(c.usado) / Number(c.monto) * 100));
      const vencida = c.vence && c.vence < M.hoy();
      return '<section class="card pack-card' + (c.anulada_en || Number(c.saldo) <= 0 ? ' terminado' : '') + '">' +
        '<div class="titulo-fila"><div><b>🎁 ' + M.esc(c.beneficiaria) + '</b>' +
          '<div class="tenue">' + (c.regala ? 'Se la regaló ' + M.esc(c.regala) + ' · ' : '') + M.fechaCorta(c.fecha) + (c.descripcion ? ' · ' + M.esc(c.descripcion) : '') + '</div></div>' +
          '<div style="text-align:right"><b style="font-size:1.3rem">' + M.plata(c.saldo) + '</b><div class="tenue">de ' + M.plata(c.monto) + '</div></div></div>' +
        '<div class="hpista" style="margin:8px 0"><div class="hbarra" style="width:' + pct + '%"></div></div>' +
        (c.anulada_en ? '<div class="error">Anulada: ' + M.esc(c.anulada_motivo || '') + '</div>' : '') +
        (vencida && !c.anulada_en ? '<div class="aviso">Venció el ' + M.fechaCorta(c.vence) + '</div>' : c.vence ? '<div class="tenue">Vence el ' + M.fechaCorta(c.vence) + '</div>' : '') +
        (u.length ? '<div class="historial"><b>Usos</b>' + u.map((x) => '<div class="linea' + (x.estado === 'anulada' ? ' tenue' : '') + '"><span>' +
            M.fechaCorta(x.fecha) + ' · ' + M.esc(x.descripcion || '') + (x.estado === 'anulada' ? ' (anulada: se devolvió)' : '') +
            '</span><span>−' + M.plata(x.monto) + '</span></div>').join('') + '</div>'
          : '<div class="tenue">Todavía no la usó.</div>') +
        (!c.entro_a_caja ? '<div class="tenue" style="font-size:.8rem">Vendida antes del sistema (no sumó a la caja acá).</div>' : '') +
        (!c.anulada_en && !Number(c.usado) ? '<div class="acciones fila"><button type="button" class="link" data-anular="' + c.id + '">anular</button></div>' : '') +
        '</section>';
    }).join('') + '</div>'
      : '<section class="card"><p class="tenue">' + (f ? 'No hay gift cards con ese nombre.' : 'No hay gift cards con saldo.') + '</p></section>';
  }

  function renderForm() {
    const el = $('#form');
    if (!form) { el.innerHTML = ''; return; }
    const res = form.paciente ? [] : buscarPac(form.buscar);
    el.innerHTML = '<div class="pend" style="margin:12px 0"><b>Nueva gift card</b>' +
      '<div class="form" style="margin-top:8px">' +
        (form.paciente
          ? '<div class="paciente"><b>' + M.esc(form.paciente.nombre) + '</b> <button type="button" class="link" id="gOtra">cambiar</button></div>'
          : '<label class="ancho">Para quién <input type="search" id="gBuscar" value="' + M.esc(form.buscar) + '" placeholder="Buscá la paciente (si tiene ficha) o escribí el nombre" autocomplete="off"></label>' +
            '<ul class="resultados ancho" id="gRes">' + res.map((p) => '<li><button type="button" data-gpac="' + M.esc(p.ref) + '">' + M.esc(p.nombre) + '</button></li>').join('') + '</ul>') +
        '<label>Monto $ <input type="number" id="gMonto" min="0" step="1" inputmode="decimal" value="' + M.esc(form.monto) + '"></label>' +
        '<label>Se la regaló <input id="gRegala" value="' + M.esc(form.regala) + '" placeholder="Opcional"></label>' +
        '<label>Qué incluye <input id="gDesc" value="' + M.esc(form.descripcion) + '" placeholder="Opcional (ej. Facial + masaje)"></label>' +
        '<label>Fecha <input type="date" id="gFecha" value="' + M.esc(form.fecha) + '"></label>' +
        '<label>Vence <input type="date" id="gVence" value="' + M.esc(form.vence) + '"></label>' +
      '</div>' +
      '<label class="fila" style="margin-top:8px"><input type="checkbox" id="gAntes"' + (form.caja ? '' : ' checked') + '> Se vendió antes de usar el sistema (esa plata ya se contó)</label>' +
      (form.caja ? '<div class="medios" style="margin-top:8px">' + M.MEDIOS.map(([k, n]) => '<button type="button" class="medio' + (form.medio === k ? ' activo' : '') +
          '" data-gmedio="' + k + '">' + n + '</button>').join('') + '</div>' +
        (form.medio === 'transferencia' ? '<label class="destino' + (form.cuenta ? '' : ' falta') + '">Fue a <select id="gCuenta"><option value="">— ¿a qué cuenta? —</option>' +
          M.CUENTAS.map(([k, t]) => '<option value="' + k + '"' + (form.cuenta === k ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></label>' : '') : '') +
      '<div class="acciones fila"><button type="button" class="primario" id="gGuardar">Guardar gift card</button>' +
      '<button type="button" class="link" id="gCancelar">cancelar</button></div></div>';
  }

  function leerForm() {
    if (!form) return;
    const v = (id) => ($(id) ? $(id).value : null);
    if ($('#gBuscar')) form.buscar = v('#gBuscar');
    form.monto = v('#gMonto') ?? form.monto;
    form.regala = v('#gRegala') ?? form.regala;
    form.descripcion = v('#gDesc') ?? form.descripcion;
    form.fecha = v('#gFecha') ?? form.fecha;
    form.vence = v('#gVence') ?? form.vence;
    if ($('#gCuenta')) form.cuenta = v('#gCuenta');
  }

  async function guardar() {
    leerForm();
    const beneficiaria = form.paciente ? form.paciente.nombre : (form.buscar || '').trim();
    const monto = M.numero(form.monto);
    if (!beneficiaria) { M.toast('Falta para quién es', 'error'); return; }
    if (!(monto > 0)) { M.toast('Falta el monto', 'error'); return; }
    if (form.caja && !form.medio) { M.toast('Elegí con qué la pagaron', 'error'); return; }
    if (form.caja && form.medio === 'transferencia' && !form.cuenta) { M.toast('Elegí a qué cuenta fue la transferencia', 'error'); return; }
    if (!navigator.onLine) { M.toast('Para cargar una gift card hace falta conexión', 'error'); return; }
    const { error } = await sb.rpc('registrar_gift_card', { p: {
      client_id: form.cid, paciente_ref: form.paciente ? form.paciente.ref : null, beneficiaria, regala: form.regala,
      descripcion: form.descripcion, monto, fecha: form.fecha, vence: form.vence || null,
      entro_a_caja: form.caja, medio: form.caja ? form.medio : null, cuenta: form.caja ? form.cuenta || null : null } });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Gift card de ' + M.plata(monto) + ' para ' + beneficiaria + ' guardada', 'ok');
    form = null;
    renderForm();
    cargar();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (t.id === 'nueva') { form = vacia(); renderForm(); $('#gBuscar').focus(); return; }
    if (t.id === 'gCancelar') { form = null; renderForm(); return; }
    if (t.id === 'gGuardar') { guardar(); return; }
    if (d.gpac) { leerForm(); form.paciente = pacientes.find((p) => p.ref === d.gpac); renderForm(); return; }
    if (t.id === 'gOtra') { leerForm(); form.paciente = null; renderForm(); return; }
    if (d.gmedio) { leerForm(); form.medio = d.gmedio; if (d.gmedio !== 'transferencia') form.cuenta = ''; renderForm(); return; }
    if (d.anular) {
      const motivo = prompt('¿Por qué se anula esta gift card? (queda registrado)');
      if (!motivo || !motivo.trim()) return;
      const { error } = await sb.rpc('anular_gift_card', { p_id: Number(d.anular), p_motivo: motivo.trim() });
      if (error) { M.toast(M.mensaje(error), 'error'); return; }
      M.toast('Gift card anulada', 'ok');
      cargar();
    }
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'buscar') render();
    if (ev.target.id === 'gBuscar') {
      form.buscar = ev.target.value;
      $('#gRes').innerHTML = buscarPac(form.buscar).map((p) => '<li><button type="button" data-gpac="' + M.esc(p.ref) + '">' + M.esc(p.nombre) + '</button></li>').join('');
    }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'usadas') render();
    if (ev.target.id === 'gAntes') { leerForm(); form.caja = !ev.target.checked; renderForm(); }
  });

  async function iniciar() {
    const u = await M.requerirSesion('giftcards');
    if (!u) return;
    M.salirBoton();
    render();
    cargarPacientes();
    await cargar();
  }
  iniciar();
})();
