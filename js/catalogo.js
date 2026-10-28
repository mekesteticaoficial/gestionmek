// Precios, comisiones, productos y packs (solo Franco).
// Escribe directo en las tablas de catálogo: RLS solo se lo permite al
// admin, y cada cambio queda en la auditoría.
(function () {
  'use strict';
  const M = window.MEK;
  const C = window.Calculo;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const P = M.plata;
  let cat = null, tab = 'tratamientos', sinComision = [], sinRegla = [];

  async function cargar() {
    const q = (t, sel) => sb.from(t).select(sel || '*');
    const res = await Promise.all([
      q('tratamientos').order('nombre'), q('precios_tratamiento'), q('reglas_comision').order('id'),
      q('profesionales').order('id'), q('zonas_depilacion').order('nombre'), q('promos_depilacion').order('id'),
      q('promo_zonas'), q('escala_depilacion').order('posicion'), q('productos').order('nombre'),
      q('v_sin_comision'), q('v_items_sin_regla'),
    ]);
    const err = res.find((r) => r.error);
    if (err) { M.toast(M.mensaje(err.error), 'error'); return; }
    const [t, pr, rg, pf, z, po, pz, es, prod, sc, sr] = res.map((r) => r.data);
    cat = { tratamientos: t, precios: pr, reglas: rg, profesionales: pf, zonas: z, promos: po, promoZonas: pz,
            escala: es, productos: prod, packs: [] };
    sinComision = sc; sinRegla = sr;
    render();
  }

  // ------------------------------------------------------------ diálogo
  // campos: [{id, label, type, value, options:[[v, texto]], ayuda, req}]
  function dialogo(titulo, campos, texto) {
    return new Promise((ok) => {
      let d = document.getElementById('dlg');
      if (!d) { d = document.createElement('dialog'); d.id = 'dlg'; document.body.appendChild(d); }
      d.innerHTML = '<form method="dialog" class="form" style="grid-template-columns:1fr">' +
        '<h2 style="margin:0">' + M.esc(titulo) + '</h2>' + (texto ? '<p class="explica">' + texto + '</p>' : '') +
        campos.map((c) => '<label>' + M.esc(c.label) + (c.type === 'select'
          ? ' <select name="' + c.id + '">' + c.options.map(([v, n]) => '<option value="' + M.esc(v) + '"' + (String(v) === String(c.value) ? ' selected' : '') + '>' + M.esc(n) + '</option>').join('') + '</select>'
          : ' <input name="' + c.id + '" type="' + (c.type || 'text') + '"' + (c.type === 'number' ? ' step="0.01" inputmode="decimal"' : '') +
            ' value="' + M.esc(c.value == null ? '' : c.value) + '"' + (c.req ? ' required' : '') + (c.list ? ' list="' + c.list + '"' : '') + '>') +
          (c.ayuda ? '<span class="tenue">' + c.ayuda + '</span>' : '') + '</label>').join('') +
        '<div class="fila"><button value="ok" class="primario">Guardar</button><button value="no" formnovalidate type="submit">Cancelar</button></div></form>';
      d.onclose = () => {
        if (d.returnValue !== 'ok') { ok(null); return; }
        const f = new FormData(d.querySelector('form'));
        const out = {};
        campos.forEach((c) => { const v = f.get(c.id); out[c.id] = c.type === 'number' ? M.numero(v) : (v === '' ? null : v); });
        ok(out);
      };
      d.showModal();
    });
  }

  async function escribir(promesa, okTexto) {
    const { error } = await promesa;
    if (error) {
      const m = /duplicate|unique/i.test(error.message) ? 'Ya hay uno igual con esa fecha. Elegí otra fecha.' : M.mensaje(error);
      M.toast(m, 'error');
      return false;
    }
    M.toast(okTexto, 'ok');
    await cargar();
    return true;
  }

  // ------------------------------------------------------------ vistas
  function precioInfo(tid) {
    const hoy = M.hoy();
    const vig = C.precioVigente(cat, tid, hoy);
    const futuros = cat.precios.filter((p) => p.tratamiento_id === tid && p.vigente_desde > hoy).sort((a, b) => a.vigente_desde.localeCompare(b.vigente_desde));
    return { vig, futuro: futuros[0] };
  }
  const htmlFuturo = (f) => (f ? P(f.precio) + ' desde ' + M.fechaCorta(f.vigente_desde) +
    ' <button type="button" class="link" data-borrarprecio="' + f.id + '" title="Borrar este precio (todavía no rige)">✕</button>' : '');

  function renderTratamientos() {
    const lista = cat.tratamientos.filter((t) => !t.pack_sesiones);
    const cats = [...new Set(lista.map((t) => t.categoria))].sort();
    return '<div class="titulo-fila"><h2>Tratamientos</h2><button type="button" class="primario" id="nuevoTrat">+ Tratamiento nuevo</button></div>' +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Tratamiento</th><th class="num">Precio hoy</th><th>Próximo</th><th></th></tr></thead><tbody>' +
      cats.map((c) => '<tr><td colspan="4"><h3 style="margin:6px 0 0">' + M.esc(c.replace('_', ' ')) + '</h3></td></tr>' +
        lista.filter((t) => t.categoria === c).map((t) => {
          const { vig, futuro } = precioInfo(t.id);
          const precio = t.precio_variable ? (t.precio_min != null ? P(t.precio_min) + '–' + P(t.precio_max) : 'a presupuestar') : (vig == null ? '<i>sin precio</i>' : P(vig));
          return '<tr class="' + (t.activo ? '' : 'anulado') + '"><td>' + M.esc(t.nombre) + (t.precio_variable ? ' <span class="pill">precio variable</span>' : '') +
            '</td><td class="num">' + precio + '</td><td>' + htmlFuturo(futuro) + '</td><td>' +
            (t.precio_variable ? '<button type="button" class="link" data-rango="' + t.id + '">rango</button>'
              : '<button type="button" class="link" data-precio="' + t.id + '">nuevo precio</button>') +
            ' <button type="button" class="link" data-editar="' + t.id + '">editar</button>' +
            ' <button type="button" class="link" data-activo="' + t.id + '">' + (t.activo ? 'dar de baja' : 'reactivar') + '</button>' +
            ' <button type="button" class="link" data-eliminar="' + t.id + '">eliminar</button></td></tr>';
        }).join('')).join('') + '</tbody></table></div>';
  }

  function renderDepilacion() {
    const hoy = M.hoy();
    const zonas = ['mujer', 'hombre'].flatMap((s) => C.zonasVigentes(cat, s, hoy).filter((z) => z.sexo === s || s === 'mujer'));
    const unicas = [...new Map(zonas.map((z) => [z.id, z])).values()].sort((a, b) => (a.sexo + a.nombre).localeCompare(b.sexo + b.nombre));
    const sinPromos = Object.assign({}, cat, { promos: [] });
    return '<div class="dos"><div><h2>Zonas</h2><p class="explica">Al cambiar el precio de una zona, las promos con precio fijado que la incluyen quedan marcadas para revisar.</p>' +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Zona</th><th>Para</th><th class="num">Precio hoy</th><th>Próximo</th><th></th></tr></thead><tbody>' +
      unicas.map((z) => {
        const fut = cat.zonas.filter((x) => x.nombre === z.nombre && x.sexo === z.sexo && x.vigente_desde > hoy).sort((a, b) => a.vigente_desde.localeCompare(b.vigente_desde))[0];
        return '<tr><td>' + M.esc(z.nombre) + '</td><td>' + z.sexo + '</td><td class="num">' + P(z.precio) + '</td><td>' +
          (fut ? P(fut.precio) + ' desde ' + M.fechaCorta(fut.vigente_desde) : '') + '</td><td><button type="button" class="link" data-zona="' + z.id + '">nuevo precio</button></td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div><h2>Promos</h2><p class="explica">Cualquier combinación que no sea una promo se cotiza con la escala (1ª zona 100%, 2ª 40%, 3ª 30%, después 25%), sin piso, redondeada hacia arriba al millar.</p>' +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Promo</th><th class="num">Precio</th><th class="num">Por escala</th><th></th></tr></thead><tbody>' +
      cat.promos.map((p) => {
        const ids = cat.promoZonas.filter((x) => x.promo_id === p.id).map((x) => (C.zonaVigente(cat, x.zona_id, hoy) || {}).id).filter(Boolean);
        const zs = ids.map((id) => cat.zonas.find((z) => z.id === id));
        const escala = C.cotizarDepilacion(sinPromos, ids, p.sexo, hoy).precio;
        const suelto = zs.reduce((a, z) => a + Number(z.precio), 0);
        return '<tr class="' + (p.activo ? '' : 'anulado') + '"><td><b>' + M.esc(p.nombre) + '</b> ' + p.sexo +
          (p.revisar ? ' <span class="pill mal">revisar</span>' : '') + '<div class="tenue">' + M.esc(zs.map((z) => z.nombre).join(' + ')) + ' · sueltas ' + P(suelto) + '</div>' +
          (p.revisar && p.motivo_fijado ? '<div class="aviso">' + M.esc(p.motivo_fijado) + '</div>' : '') + '</td><td class="num">' + P(p.precio_fijado) +
          '</td><td class="num">' + P(escala) + '</td><td><button type="button" class="link" data-promo="' + p.id + '">cambiar precio</button>' +
          (p.revisar ? ' <button type="button" class="link" data-revisada="' + p.id + '">dejar como está</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div>';
  }

  function renderComisiones() {
    const nombreTrat = (id) => (cat.tratamientos.find((t) => t.id === id) || {}).nombre || id;
    const porProf = cat.profesionales.map((p) => {
      const rs = cat.reglas.filter((r) => r.profesional_id === p.id);
      return '<h3>' + M.esc(p.nombre) + ' <span class="tenue">(' + ({ interno: 'interna: cobra MEK y paga comisión', invitado_cobra_mek: 'tercero: cobra MEK y le debe su parte',
        invitado_cobra_el: 'cobra ella/él: se registra solo lo de MEK' }[p.modelo]) + ')</span></h3>' +
        (rs.length ? '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Aplica a</th><th class="num">Se lleva</th><th>Desde</th></tr></thead><tbody>' +
          rs.map((r) => '<tr><td>' + (r.tratamiento_id ? M.esc(nombreTrat(r.tratamiento_id)) : 'toda la categoría <b>' + M.esc(r.categoria) + '</b>') +
            '</td><td class="num">' + (r.tipo === 'porcentaje' ? r.valor + '%' : P(r.valor) + ' fijo') + '</td><td>' + M.fechaCorta(r.vigente_desde) + '</td></tr>').join('') +
          '</tbody></table></div>' : '<p class="tenue">Sin reglas.</p>');
    }).join('');
    return '<div class="titulo-fila"><h2>Comisiones</h2><button type="button" class="primario" id="nuevaRegla">+ Regla nueva</button></div>' +
      '<p class="explica">Primero vale la regla del tratamiento; si no hay, la de su categoría. Una regla nueva rige desde su fecha: las ventas anteriores quedan con la comisión que tenían.</p>' +
      (sinRegla.length ? '<div class="alerta">⚠ ' + sinRegla.length + ' cobro(s) se guardaron sin regla: ' +
        sinRegla.map((s) => M.esc(s.descripcion) + ' (' + M.esc(s.profesional) + ', ' + M.fechaCorta(s.fecha) + ')').join('; ') +
        '. Cargá la regla y después <button type="button" class="link" id="resolver">recalcular esos cobros</button>.</div>' : '') +
      porProf +
      '<details style="margin-top:14px"><summary>Combinaciones sin regla (' + sinComision.length + ')</summary><p class="explica">Si alguna de estas personas hace alguno de estos tratamientos, ' +
      'el cobro avisa y se guarda sin comisión hasta que cargues la regla. Muchas no pasan nunca (Estefanía no hace faciales): no hace falta cargarlas todas.</p>' +
      '<div class="tabla-wrap"><table class="tabla"><tbody>' + sinComision.map((s) => '<tr><td>' + M.esc(s.profesional) + '</td><td>' + M.esc(s.tratamiento) +
        '</td><td class="tenue">' + M.esc(s.categoria) + '</td></tr>').join('') + '</tbody></table></div></details>';
  }

  function renderProductos() {
    return '<div class="titulo-fila"><h2>Productos</h2><button type="button" class="primario" id="nuevoProd">+ Producto nuevo</button></div>' +
      '<p class="explica">El stock y el costo se actualizan con las <a href="compras.html">compras</a>. Si no sabés cuántos frascos salen de un pote, dejá ese dato vacío: el margen se muestra "sin dato", nunca un número inventado.</p>' +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Producto</th><th>Tipo</th><th class="num">Precio venta</th><th class="num">Unid. por compra</th>' +
      '<th class="num">Rinde sesiones</th><th class="num">Costo prom.</th><th></th></tr></thead><tbody>' +
      cat.productos.map((p) => '<tr class="' + (p.activo ? '' : 'anulado') + '"><td>' + M.esc(p.nombre) + '<div class="tenue">' + M.esc(p.laboratorio || '') +
        (p.unidad_compra ? ' · ' + M.esc(p.unidad_compra) : '') + (p.modalidad === 'consignacion' ? ' · consignación de ' + M.esc(p.consignante || '¿quién?') + ', ' + (p.margen_consignacion != null ? p.margen_consignacion + '% para MEK' : 'margen sin dato') : '') +
        '</div></td><td>' + M.esc(p.tipo) + '</td><td class="num">' + P(p.precio_venta) + '</td><td class="num">' + (p.fracciones_por_unidad ?? '<i>sin dato</i>') +
        '</td><td class="num">' + (p.rinde_sesiones ?? '—') + '</td><td class="num">' + P(p.costo_promedio) + '</td><td><button type="button" class="link" data-prod="' + p.id + '">editar</button></td></tr>').join('') +
      '</tbody></table></div>';
  }

  function renderPacks() {
    const packs = cat.tratamientos.filter((t) => t.pack_sesiones);
    return '<div class="titulo-fila"><h2>Packs y planes</h2><button type="button" class="primario" id="nuevoPack">+ Pack nuevo</button></div>' +
      '<p class="explica">El pack se cobra entero al venderlo (sin comisión) y cada sesión que se usa genera la comisión de esa semana, sobre el valor de una sesión.</p>' +
      '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Pack</th><th class="num">Sesiones</th><th>Cada sesión es</th><th class="num">Precio hoy</th><th class="num">Por sesión</th><th></th></tr></thead><tbody>' +
      (packs.length ? packs.map((t) => {
        const { vig } = precioInfo(t.id);
        const ses = cat.tratamientos.find((x) => x.id === t.pack_tratamiento_id);
        return '<tr class="' + (t.activo ? '' : 'anulado') + '"><td>' + M.esc(t.nombre) + '</td><td class="num">' + t.pack_sesiones + '</td><td>' + M.esc(ses ? ses.nombre : '—') +
          '</td><td class="num">' + P(vig) + '</td><td class="num">' + (vig != null ? P(M.r2(vig / t.pack_sesiones)) : '—') + '</td><td><button type="button" class="link" data-precio="' + t.id +
          '">nuevo precio</button> <button type="button" class="link" data-editar="' + t.id + '">editar</button>' +
          ' <button type="button" class="link" data-activo="' + t.id + '">' + (t.activo ? 'dar de baja' : 'reactivar') + '</button>' +
          ' <button type="button" class="link" data-eliminar="' + t.id + '">eliminar</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="tenue">No hay packs.</td></tr>') + '</tbody></table></div>';
  }

  function render() {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab));
    if (!cat) return;
    $('#contenido').innerHTML = { tratamientos: renderTratamientos, depilacion: renderDepilacion, comisiones: renderComisiones,
      productos: renderProductos, packs: renderPacks }[tab]();
  }

  // ------------------------------------------------------------ acciones
  const opcionesTrat = (filtro) => cat.tratamientos.filter((t) => t.activo && !t.pack_sesiones && (!filtro || filtro(t)))
    .map((t) => [t.id, t.nombre + ' (' + t.categoria + ')']);
  const categorias = () => [...new Set(cat.tratamientos.map((t) => t.categoria).concat(['depilacion']))].sort();

  async function nuevoPrecio(id) {
    const t = cat.tratamientos.find((x) => x.id === id);
    const { vig } = precioInfo(id);
    const v = await dialogo('Nuevo precio · ' + t.nombre, [
      { id: 'precio', label: 'Precio $', type: 'number', value: vig, req: true },
      { id: 'desde', label: 'Rige desde', type: 'date', value: M.hoy(), req: true },
    ], 'Hoy: ' + P(vig) + '. El precio anterior queda guardado para las ventas viejas.');
    if (!v || v.precio == null) return;
    await escribir(sb.from('precios_tratamiento').insert({ tratamiento_id: id, precio: v.precio, vigente_desde: v.desde }), 'Precio guardado');
  }

  async function rango(id) {
    const t = cat.tratamientos.find((x) => x.id === id);
    const v = await dialogo('Rango de referencia · ' + t.nombre, [
      { id: 'min', label: 'Desde $', type: 'number', value: t.precio_min },
      { id: 'max', label: 'Hasta $', type: 'number', value: t.precio_max },
    ], 'Es solo una referencia: al cobrar se escribe el monto y, si queda afuera, avisa pero deja pasar. Vacío = sin rango (se presupuesta).');
    if (!v) return;
    if (v.min != null && v.max != null && v.max < v.min) { M.toast('"Hasta" tiene que ser mayor que "desde"', 'error'); return; }
    await escribir(sb.from('tratamientos').update({ precio_min: v.min, precio_max: v.max }).eq('id', id), 'Rango guardado');
  }

  async function activo(id) {
    const t = cat.tratamientos.find((x) => x.id === id);
    if (t.activo && !confirm('¿Dar de baja "' + t.nombre + '"? Deja de aparecer para cobrar. Las ventas viejas no cambian.')) return;
    await escribir(sb.from('tratamientos').update({ activo: !t.activo }).eq('id', id), t.activo ? 'Dado de baja' : 'Reactivado');
  }

  async function editar(id) {
    const t = cat.tratamientos.find((x) => x.id === id);
    const campos = [{ id: 'nombre', label: 'Nombre', value: t.nombre, req: true }];
    if (!t.pack_sesiones) {
      campos.push({ id: 'categoria', label: 'Categoría', value: t.categoria, list: 'cats', req: true,
                    ayuda: 'facial, corporal, capilar… Define qué regla de comisión se le aplica si no tiene una propia.' });
    }
    const v = await dialogo('Editar · ' + t.nombre, campos,
      'Las comisiones ya cobradas no cambian. Desde ahora, los cobros nuevos usan la regla de la categoría nueva.');
    if (!v || !v.nombre) return;
    const fila = { nombre: v.nombre.trim() };
    if (!t.pack_sesiones) fila.categoria = (v.categoria || '').trim().toLowerCase();
    if (fila.nombre === t.nombre && (t.pack_sesiones || fila.categoria === t.categoria)) return;
    const { error } = await sb.from('tratamientos').update(fila).eq('id', id);
    if (error) { M.toast(/unique|duplicate/i.test(error.message) ? 'Ya existe un tratamiento con ese nombre' : M.mensaje(error), 'error'); return; }
    M.toast('Guardado', 'ok');
    await cargar();
  }

  async function eliminar(id) {
    const t = cat.tratamientos.find((x) => x.id === id);
    const { data: uso, error } = await sb.rpc('uso_tratamiento', { p_id: id });
    if (error) { M.toast(/uso_tratamiento|function/i.test(error.message) ? 'Falta correr sql/17_catalogo_editable.sql en Supabase' : M.mensaje(error), 'error'); return; }
    if (uso.cobros || uso.packs_vendidos) {
      const n = [uso.cobros ? uso.cobros + ' cobro(s)' : '', uso.packs_vendidos ? uso.packs_vendidos + ' pack(s) vendido(s)' : ''].filter(Boolean).join(' y ');
      if (!t.activo) { M.toast('"' + t.nombre + '" tiene ' + n + ': no se puede eliminar. Ya está dado de baja.', 'error', 8000); return; }
      if (confirm('"' + t.nombre + '" tiene ' + n + ', así que no se puede eliminar: las ventas viejas lo necesitan.\n\n¿Darlo de baja? Deja de aparecer para cobrar.')) {
        await escribir(sb.from('tratamientos').update({ activo: false }).eq('id', id), 'Dado de baja');
      }
      return;
    }
    if (uso.es_sesion_de) { M.toast('"' + t.nombre + '" es la sesión de: ' + uso.es_sesion_de + '. Eliminá primero esos packs.', 'error', 8000); return; }
    if (!confirm('¿Eliminar "' + t.nombre + '"? Nunca se cobró. Se borran también sus precios y reglas de comisión.')) return;
    await escribir(sb.rpc('eliminar_tratamiento', { p_id: id }), 'Eliminado');
  }

  async function borrarPrecio(id) {
    const p = cat.precios.find((x) => x.id === id);
    const t = cat.tratamientos.find((x) => x.id === p.tratamiento_id);
    if (!confirm('¿Borrar el precio de ' + P(p.precio) + ' para "' + t.nombre + '" desde el ' + M.fechaCorta(p.vigente_desde) + '? Todavía no rige.')) return;
    await escribir(sb.rpc('eliminar_precio_futuro', { p_id: id }), 'Precio borrado');
  }

  async function nuevoTratamiento() {
    const v = await dialogo('Tratamiento nuevo', [
      { id: 'nombre', label: 'Nombre', req: true },
      { id: 'categoria', label: 'Categoría', list: 'cats', req: true, ayuda: 'Define qué regla de comisión se le aplica si no tiene una propia.' },
      { id: 'variable', label: 'Precio', type: 'select', value: 'no', options: [['no', 'Precio fijo de lista'], ['si', 'Precio variable (se escribe al cobrar)']] },
      { id: 'precio', label: 'Precio $ (si es fijo)', type: 'number' },
      { id: 'desde', label: 'Rige desde', type: 'date', value: M.hoy() },
    ]);
    if (!v || !v.nombre || !v.categoria) return;
    if (v.variable === 'no' && v.precio == null) { M.toast('Falta el precio', 'error'); return; }
    const { data, error } = await sb.from('tratamientos').insert({ nombre: v.nombre.trim(), categoria: v.categoria.trim(), precio_variable: v.variable === 'si' }).select().single();
    if (error) { M.toast(/unique|duplicate/i.test(error.message) ? 'Ya existe un tratamiento con ese nombre' : M.mensaje(error), 'error'); return; }
    if (v.variable === 'no') await sb.from('precios_tratamiento').insert({ tratamiento_id: data.id, precio: v.precio, vigente_desde: v.desde });
    M.toast('Tratamiento creado. Revisá que tenga regla de comisión para quien lo hace.', 'ok', 7000);
    await cargar();
  }

  async function nuevoPrecioZona(id) {
    const z = cat.zonas.find((x) => x.id === id);
    const v = await dialogo('Nuevo precio · ' + z.nombre + ' (' + z.sexo + ')', [
      { id: 'precio', label: 'Precio $', type: 'number', value: z.precio, req: true },
      { id: 'desde', label: 'Rige desde', type: 'date', value: M.hoy(), req: true },
    ], 'Las promos con precio fijado que incluyen esta zona van a quedar marcadas para revisar.');
    if (!v || v.precio == null) return;
    await escribir(sb.from('zonas_depilacion').insert({ nombre: z.nombre, sexo: z.sexo, precio: v.precio, vigente_desde: v.desde }),
      'Precio guardado. Revisá las promos marcadas.');
  }

  async function precioPromo(id) {
    const p = cat.promos.find((x) => x.id === id);
    const v = await dialogo('Precio · ' + p.nombre + ' ' + p.sexo, [
      { id: 'precio', label: 'Precio fijado $', type: 'number', value: p.precio_fijado, req: true },
      { id: 'motivo', label: 'Motivo', value: 'Fijado por Franco el ' + M.fechaCorta(M.hoy()) },
    ]);
    if (!v || v.precio == null) return;
    await escribir(sb.from('promos_depilacion').update({ precio_fijado: v.precio, revisar: false, motivo_fijado: v.motivo }).eq('id', id), 'Promo actualizada');
  }

  async function revisada(id) {
    const p = cat.promos.find((x) => x.id === id);
    if (!confirm('¿Dejar ' + p.nombre + ' ' + p.sexo + ' en ' + P(p.precio_fijado) + '?')) return;
    await escribir(sb.from('promos_depilacion').update({ revisar: false, motivo_fijado: 'Revisada por Franco el ' + M.fechaCorta(M.hoy()) + ': se mantiene' }).eq('id', id), 'Listo');
  }

  async function nuevaRegla() {
    const v = await dialogo('Regla de comisión nueva', [
      { id: 'prof', label: 'Profesional', type: 'select', options: cat.profesionales.filter((p) => p.activo).map((p) => [p.id, p.nombre]) },
      { id: 'alcance', label: 'Aplica a', type: 'select', value: 't', options: [['t', 'Un tratamiento'], ['c', 'Toda una categoría']] },
      { id: 'trat', label: 'Tratamiento (si es uno)', type: 'select', options: [['', '—']].concat(opcionesTrat()) },
      { id: 'cat', label: 'Categoría (si es toda)', type: 'select', options: [['', '—']].concat(categorias().map((c) => [c, c])) },
      { id: 'tipo', label: 'Tipo', type: 'select', options: [['porcentaje', 'Porcentaje'], ['monto_fijo', 'Monto fijo por atención']] },
      { id: 'valor', label: 'Valor (% o $)', type: 'number', req: true },
      { id: 'desde', label: 'Rige desde', type: 'date', value: M.hoy(), req: true },
    ], 'Para terceros (Estefanía, externa) es el porcentaje que se lleva el profesional, no lo que queda para MEK.');
    if (!v) return;
    const fila = { profesional_id: Number(v.prof), tipo: v.tipo, valor: v.valor, vigente_desde: v.desde,
                   tratamiento_id: v.alcance === 't' ? Number(v.trat) || null : null, categoria: v.alcance === 'c' ? v.cat : null };
    if (fila.valor == null || fila.valor < 0) { M.toast('Falta el valor', 'error'); return; }
    if (!fila.tratamiento_id && !fila.categoria) { M.toast('Elegí el tratamiento o la categoría', 'error'); return; }
    if (fila.tipo === 'porcentaje' && fila.valor > 100) { M.toast('Un porcentaje no puede pasar de 100', 'error'); return; }
    await escribir(sb.from('reglas_comision').insert(fila), 'Regla guardada');
  }

  async function resolver() {
    const { data, error } = await sb.rpc('resolver_items_sin_regla');
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast(data.resueltos + ' recalculado(s); quedan ' + data.quedan + ' sin regla', data.quedan ? 'error' : 'ok');
    cargar();
  }

  async function editarProducto(id) {
    const p = id ? cat.productos.find((x) => x.id === id) : { tipo: 'reventa', modalidad: 'propio', activo: true };
    const v = await dialogo(id ? 'Editar · ' + p.nombre : 'Producto nuevo', [
      { id: 'nombre', label: 'Nombre', value: p.nombre, req: true },
      { id: 'laboratorio', label: 'Laboratorio', value: p.laboratorio },
      { id: 'tipo', label: 'Tipo', type: 'select', value: p.tipo, options: [['reventa', 'Reventa (se vende)'], ['insumo_cabina', 'Insumo de cabina'], ['descartable', 'Descartable']] },
      { id: 'modalidad', label: 'Modalidad', type: 'select', value: p.modalidad, options: [['propio', 'Propio (lo compra MEK)'], ['consignacion', 'En consignación']] },
      { id: 'margen', label: 'Margen para MEK % (consignación)', type: 'number', value: p.margen_consignacion },
      { id: 'consignante', label: 'Quién lo trajo (consignación)', value: p.consignante, ayuda: 'Para saber a quién se le debe lo vendido (Acreedores).' },
      { id: 'unidad', label: 'Unidad de compra', value: p.unidad_compra, ayuda: 'pote 320g, bidón 1kg, unidad…' },
      { id: 'fracciones', label: 'Unidades de venta por unidad de compra', type: 'number', value: p.fracciones_por_unidad, ayuda: 'Vacío = no se sabe (nunca se asume 1).' },
      { id: 'rinde', label: 'Rinde sesiones (insumos)', type: 'number', value: p.rinde_sesiones },
      { id: 'precio', label: 'Precio de venta $', type: 'number', value: p.precio_venta },
      { id: 'barras', label: 'Código de barras', value: p.codigo_barras },
      { id: 'activo', label: 'Estado', type: 'select', value: p.activo ? 'si' : 'no', options: [['si', 'Activo'], ['no', 'Dado de baja']] },
    ]);
    if (!v || !v.nombre) return;
    if (v.fracciones != null && v.fracciones <= 0) { M.toast('Las unidades por compra tienen que ser más que cero', 'error'); return; }
    const fila = { nombre: v.nombre.trim(), laboratorio: v.laboratorio, tipo: v.tipo, modalidad: v.modalidad,
                   margen_consignacion: v.modalidad === 'consignacion' ? v.margen : null,
                   consignante: v.modalidad === 'consignacion' ? (v.consignante || '').trim() || null : null, unidad_compra: v.unidad,
                   fracciones_por_unidad: v.fracciones, rinde_sesiones: v.rinde, precio_venta: v.precio, codigo_barras: v.barras,
                   activo: v.activo === 'si' };
    await escribir(id ? sb.from('productos').update(fila).eq('id', id) : sb.from('productos').insert(fila), 'Producto guardado');
  }

  async function nuevoPack() {
    const v = await dialogo('Pack nuevo', [
      { id: 'nombre', label: 'Nombre', req: true, ayuda: 'Por ejemplo: Plan Contorno 6 sesiones' },
      { id: 'sesiones', label: 'Cantidad de sesiones', type: 'number', req: true },
      { id: 'trat', label: 'Cada sesión es', type: 'select', options: opcionesTrat() },
      { id: 'precio', label: 'Precio del pack $', type: 'number', req: true },
      { id: 'desde', label: 'Rige desde', type: 'date', value: M.hoy(), req: true },
    ], 'La comisión de cada sesión sale de la regla del tratamiento de la sesión, sobre precio ÷ sesiones.');
    if (!v || !v.nombre || !(v.sesiones > 0) || v.precio == null) return;
    if (!Number.isInteger(v.sesiones)) { M.toast('Las sesiones tienen que ser un número entero', 'error'); return; }
    const ses = cat.tratamientos.find((t) => t.id === Number(v.trat));
    const { data, error } = await sb.from('tratamientos').insert({ nombre: v.nombre.trim(), categoria: ses.categoria,
      pack_sesiones: v.sesiones, pack_tratamiento_id: ses.id }).select().single();
    if (error) { M.toast(/unique|duplicate/i.test(error.message) ? 'Ya existe uno con ese nombre' : M.mensaje(error), 'error'); return; }
    await escribir(sb.from('precios_tratamiento').insert({ tratamiento_id: data.id, precio: v.precio, vigente_desde: v.desde }), 'Pack creado');
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) { tab = d.tab; history.replaceState(null, '', '#' + tab); render(); }
    if (d.precio) nuevoPrecio(Number(d.precio));
    if (d.rango) rango(Number(d.rango));
    if (d.activo) activo(Number(d.activo));
    if (d.editar) editar(Number(d.editar));
    if (d.eliminar) eliminar(Number(d.eliminar));
    if (d.borrarprecio) borrarPrecio(Number(d.borrarprecio));
    if (d.zona) nuevoPrecioZona(Number(d.zona));
    if (d.promo) precioPromo(Number(d.promo));
    if (d.revisada) revisada(Number(d.revisada));
    if (d.prod) editarProducto(Number(d.prod));
    if (t.id === 'nuevoTrat') nuevoTratamiento();
    if (t.id === 'nuevaRegla') nuevaRegla();
    if (t.id === 'resolver') resolver();
    if (t.id === 'nuevoProd') editarProducto(null);
    if (t.id === 'nuevoPack') nuevoPack();
  });

  async function iniciar() {
    const u = await M.requerirSesion('catalogo', { admin: true });
    if (!u) return;
    M.salirBoton();
    const h = location.hash.slice(1);
    if (['tratamientos', 'depilacion', 'comisiones', 'productos', 'packs'].includes(h)) tab = h;
    document.body.insertAdjacentHTML('beforeend', '<datalist id="cats"></datalist>');
    render();
    await cargar();
    $('#cats').innerHTML = categorias().map((c) => '<option value="' + M.esc(c) + '">').join('');
  }
  iniciar();
})();
