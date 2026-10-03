// Compras y stock (solo Franco). registrar_compra hace el cálculo del
// costo real y del promedio ponderado; acá solo se arma el remito.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const TIPOS = { reventa: 'Reventa', insumo_cabina: 'Insumo de cabina', descartable: 'Descartable' };
  let productos = [], compras = [], lineas = [], clientId = null;

  const nueva = () => ({ producto_id: '', pedida: '', recibida: '', precio: '', descuento: '', unidades: '' });

  async function cargar() {
    const [p, c] = await Promise.all([
      sb.from('productos').select('*').eq('activo', true).order('nombre'),
      sb.from('compras').select('*').order('id', { ascending: false }).range(0, 49),
    ]);
    if (p.error || c.error) { M.toast(M.mensaje(p.error || c.error), 'error'); return; }
    productos = p.data;
    compras = c.data;
    $('#proveedores').innerHTML = [...new Set(compras.map((x) => x.proveedor))].map((x) => '<option value="' + M.esc(x) + '">').join('');
    renderLineas();
    renderStock();
    renderCompras();
  }

  function unidadesAuto(l, prod) {
    const rec = M.numero(l.recibida) ?? M.numero(l.pedida);
    if (rec == null || !prod) return null;
    if (prod.tipo !== 'reventa') return rec;
    if (prod.fracciones_por_unidad != null) return M.r2(rec * Number(prod.fracciones_por_unidad));
    return null;
  }

  function importe(l) {
    const rec = M.numero(l.recibida) ?? M.numero(l.pedida);
    const precio = M.numero(l.precio);
    if (rec == null || precio == null) return null;
    return M.r2(precio * rec - (M.numero(l.descuento) || 0));
  }

  function renderLineas() {
    const opciones = productos.filter((p) => p.modalidad === 'propio').map((p) =>
      '<option value="' + p.id + '">' + M.esc(p.nombre) + (p.unidad_compra ? ' · ' + M.esc(p.unidad_compra) : '') + '</option>').join('');
    $('#lineas').innerHTML = '<thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Recibido</th><th class="num">Precio unit.</th>' +
      '<th class="num">Descuento $</th><th class="num">Unid. de venta</th><th class="num">Importe</th><th></th></tr></thead><tbody>' +
      lineas.map((l, i) => {
        const prod = productos.find((p) => p.id === Number(l.producto_id));
        const auto = unidadesAuto(l, prod);
        const imp = importe(l);
        return '<tr><td><select data-l="' + i + '" data-c="producto_id"><option value="">— elegir —</option>' +
          opciones.replace('value="' + l.producto_id + '"', 'value="' + l.producto_id + '" selected') + '</select></td>' +
          ['pedida', 'recibida', 'precio', 'descuento'].map((c) => '<td class="num"><input type="number" min="0" step="0.01" style="width:100px" data-l="' + i +
            '" data-c="' + c + '" value="' + M.esc(l[c]) + '"' + (c === 'recibida' ? ' placeholder="= pedido"' : '') + '></td>').join('') +
          '<td class="num"><input type="number" min="0" step="0.001" style="width:100px" data-l="' + i + '" data-c="unidades" value="' + M.esc(l.unidades) +
            '" placeholder="' + (auto == null ? 'sin dato' : auto) + '">' +
            (prod && prod.tipo === 'reventa' && prod.fracciones_por_unidad == null && !l.unidades ? '<div class="aviso">sin dato: el stock no se toca</div>' : '') + '</td>' +
          '<td class="num">' + (imp == null ? '—' : M.plata(imp)) + (imp != null && imp < 0 ? '<div class="error">descuento mayor al importe</div>' : '') + '</td>' +
          '<td><button type="button" class="quitar" data-sacar="' + i + '">✕</button></td></tr>';
      }).join('') + '</tbody>';
    const total = lineas.reduce((a, l) => a + (importe(l) || 0), 0);
    $('#totalCompra').textContent = 'Total: ' + M.plata(M.r2(total));
  }

  function renderStock() {
    $('#stock').innerHTML = '<thead><tr><th>Producto</th><th>Tipo</th><th class="num">Stock</th><th class="num">Costo prom.</th>' +
      '<th class="num">Precio venta</th><th class="num">Margen</th></tr></thead><tbody>' +
      productos.map((p) => {
        const sinFrac = p.tipo === 'reventa' && p.fracciones_por_unidad == null;
        const margen = p.precio_venta != null && p.costo_promedio != null ? M.plata(M.r2(p.precio_venta - p.costo_promedio)) +
          ' (' + Math.round((p.precio_venta - p.costo_promedio) / p.precio_venta * 100) + '%)' : '<i>sin dato</i>';
        return '<tr class="' + (Number(p.stock_actual) < 0 ? 'rojo' : '') + '"><td>' + M.esc(p.nombre) +
          (p.modalidad === 'consignacion' ? ' <span class="pill">consignación</span>' : '') +
          (sinFrac ? '<div class="tenue">no se sabe cuántas unidades salen de ' + M.esc(p.unidad_compra || 'cada compra') + '</div>' : '') +
          '</td><td>' + M.esc(TIPOS[p.tipo] || p.tipo) + '</td><td class="num">' + (p.modalidad === 'consignacion' ? '—' : Number(p.stock_actual)) +
          (Number(p.stock_actual) < 0 ? '<div>falta cargar una compra</div>' : '') + '</td><td class="num">' + M.plata(p.costo_promedio) +
          '</td><td class="num">' + M.plata(p.precio_venta) + '</td><td class="num">' + (p.modalidad === 'consignacion'
            ? (p.margen_consignacion != null ? p.margen_consignacion + '% acordado' : '<i>sin dato</i>') : margen) + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function renderCompras() {
    const pend = compras.filter((c) => c.estado === 'pendiente').sort((a, b) => String(a.vencimiento).localeCompare(String(b.vencimiento)));
    $('#aPagar').hidden = !pend.length;
    $('#aPagar').innerHTML = '<h2>A pagar (' + pend.length + ')</h2><div class="tabla-wrap"><table class="tabla"><tbody>' +
      pend.map((c) => {
        const vencida = c.vencimiento && c.vencimiento < M.hoy();
        return '<tr class="' + (vencida ? 'rojo' : '') + '"><td>' + M.esc(c.proveedor) + (c.nro_remito ? ' · remito ' + M.esc(c.nro_remito) : '') +
          '<div class="tenue">compra del ' + M.fechaCorta(c.fecha) + '</div></td><td>' + (c.vencimiento ? (vencida ? 'venció ' : 'vence ') + M.fechaCorta(c.vencimiento) : '') +
          '</td><td class="num">' + M.plata(c.total) + '</td><td><button type="button" class="primario" data-pagar="' + c.id + '">Pagar</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    $('#historial').innerHTML = '<thead><tr><th>Fecha</th><th>Proveedor</th><th>Remito</th><th>Condición</th><th class="num">Total</th><th>Estado</th></tr></thead><tbody>' +
      (compras.length ? compras.map((c) => '<tr><td>' + M.fechaCorta(c.fecha) + '</td><td>' + M.esc(c.proveedor) + '</td><td>' + M.esc(c.nro_remito || '') +
        '</td><td>' + (c.condicion === 'contado' ? 'contado' : 'cta. cte.') + '</td><td class="num">' + M.plata(c.total) + '</td><td>' +
        (c.estado === 'pagado' ? '<span class="pill ok">pagada ' + M.fechaCorta(c.pagada_en) + '</span>' : '<span class="pill espera">a pagar</span>') + '</td></tr>').join('')
        : '<tr><td colspan="6" class="tenue">Todavía no hay compras cargadas.</td></tr>') + '</tbody>';
  }

  async function guardar() {
    const items = lineas.filter((l) => l.producto_id).map((l) => ({
      producto_id: Number(l.producto_id), cantidad_pedida: M.numero(l.pedida),
      cantidad_recibida: M.numero(l.recibida), precio_unitario: M.numero(l.precio),
      descuento: M.numero(l.descuento) || 0, unidades_venta: M.numero(l.unidades),
    }));
    if (!$('#proveedor').value.trim()) { M.toast('Falta el proveedor', 'error'); return; }
    if (!items.length) { M.toast('Agregá al menos un producto', 'error'); return; }
    if (items.some((i) => !(i.cantidad_pedida > 0) || i.precio_unitario == null)) { M.toast('Cada línea necesita cantidad pedida y precio', 'error'); return; }
    const cond = $('#condicion').value;
    if (cond === 'cuenta_corriente' && !$('#vencimiento').value) { M.toast('Falta la fecha de vencimiento', 'error'); return; }
    // El mismo id si se reintenta después de un error de red: no duplica.
    clientId = clientId || window.Cola.uuid();
    const { data, error } = await sb.rpc('registrar_compra', { p: {
      client_id: clientId, fecha: $('#fecha').value, proveedor: $('#proveedor').value.trim(), nro_remito: $('#remito').value.trim(),
      condicion: cond, vencimiento: cond === 'cuenta_corriente' ? $('#vencimiento').value : null,
      pago: cond === 'contado' ? { medio: $('#medio').value } : null, items,
    } });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    clientId = null;
    lineas = [nueva()];
    $('#remito').value = '';
    M.toast('Compra guardada: ' + M.plata(data.total) + (data.lineas_sin_stock ? ' · ' + data.lineas_sin_stock + ' línea(s) sin dato de unidades: su stock no se tocó' : ''),
      data.lineas_sin_stock ? 'error' : 'ok', 8000);
    cargar();
  }

  async function pagar(id) {
    const c = compras.find((x) => x.id === id);
    const medio = prompt('Pagar ' + M.plata(c.total) + ' a ' + c.proveedor + '. ¿Con qué medio?\n(efectivo, transferencia, debito, credito, mercadopago)', 'transferencia');
    if (!medio) return;
    const m = M.norm(medio).replace(/\s/g, '');
    if (!M.MEDIOS.some(([k]) => k === m)) { M.toast('Medio no reconocido', 'error'); return; }
    const fecha = prompt('Fecha del pago (AAAA-MM-DD):', M.hoy());
    if (!fecha) return;
    const { error } = await sb.rpc('pagar_compra', { p_compra: id, p_fecha: fecha, p_medio: m });
    if (error) { M.toast(M.mensaje(error), 'error'); return; }
    M.toast('Pagada. Queda registrada como gasto.', 'ok');
    cargar();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.id === 'agregarLinea') { lineas.push(nueva()); renderLineas(); }
    if (t.dataset.sacar) { lineas.splice(Number(t.dataset.sacar), 1); if (!lineas.length) lineas.push(nueva()); renderLineas(); }
    if (t.id === 'guardar') guardar();
    if (t.dataset.pagar) pagar(Number(t.dataset.pagar));
  });
  document.addEventListener('change', (ev) => {
    const d = ev.target.dataset;
    if (d.l !== undefined) { lineas[Number(d.l)][d.c] = ev.target.value; renderLineas(); }
    if (ev.target.id === 'condicion') {
      const cc = ev.target.value === 'cuenta_corriente';
      $('#lblVence').hidden = !cc; $('#lblMedio').hidden = cc;
    }
  });

  async function iniciar() {
    const u = await M.requerirSesion('compras', { admin: true });
    if (!u) return;
    M.salirBoton();
    $('#fecha').value = M.hoy();
    $('#medio').innerHTML = M.MEDIOS.map(([k, n]) => '<option value="' + k + '">' + n + '</option>').join('');
    lineas = [nueva()];
    cargar();
  }
  iniciar();
})();
