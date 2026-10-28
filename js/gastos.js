// Gastos. Se cargan por la cola (igual que los cobros): sin internet se
// guardan en el navegador y suben solos.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const TIPOS = { costo_operativo: 'Costo del negocio', retiro_socio: 'Retiro de socio', sueldo: 'Sueldo',
                  pago_tercero: 'Pago a tercero', compra_producto: 'Compra de mercadería', pago_deuda: 'Pago de deuda' };
  const CATEGORIAS = ['alquiler', 'luz', 'gas', 'agua', 'internet', 'teléfono', 'limpieza', 'insumos de tratamientos', 'insumos varios',
                      'publicidad', 'mantenimiento', 'impuestos', 'contador', 'banco y comisiones', 'otros'];
  let usuario = null, medio = null, gastos = [];

  // ------------------------------------------------ factura adjunta
  // adj: {blob, tipo, nombre, base64, preview, datos (lo que leyó la IA)}.
  // El archivo va a Storage (bucket privado "comprobantes", sql/16) y la
  // lectura la hace la Edge Function "leer-factura" (la clave de la IA
  // vive en Supabase, nunca acá).
  let adj = null, leyendo = false;

  const aBase64 = (blob) => new Promise((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => mal(r.error);
    r.readAsDataURL(blob);
  });

  // Las fotos del celular pesan mucho: se achican a 2000 px (alcanza para leer).
  async function achicar(file) {
    const img = await new Promise((ok, mal) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => mal(new Error('No se pudo abrir la imagen'));
      i.src = URL.createObjectURL(file);
    });
    const esc = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * esc);
    c.height = Math.round(img.naturalHeight * esc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
  }

  async function elegirArchivo(file) {
    if (!file) return;
    const esPdf = file.type === 'application/pdf';
    if (!esPdf && !file.type.startsWith('image/')) { M.toast('Tiene que ser una foto o un PDF', 'error'); return; }
    if (file.size > 10 * 1024 * 1024 && esPdf) { M.toast('El PDF pesa más de 10 MB', 'error'); return; }
    try {
      const blob = esPdf ? file : await achicar(file);
      adj = { blob, tipo: esPdf ? 'application/pdf' : 'image/jpeg', nombre: file.name, base64: await aBase64(blob),
              preview: esPdf ? null : URL.createObjectURL(blob), datos: null };
    } catch (e) { M.toast(M.mensaje(e), 'error'); return; }
    renderAdjunto();
  }

  function renderAdjunto() {
    const el = $('#adjunto');
    if (!adj) { el.innerHTML = ''; return; }
    const d = adj.datos;
    el.innerHTML = '<div class="adjunto">' +
      (adj.preview ? '<img src="' + adj.preview + '" alt="Factura">' : '<div class="adjunto-pdf">📄 ' + M.esc(adj.nombre) + '</div>') +
      '<div class="adjunto-acciones">' +
        (d ? '<b>✓ Leída</b> <span class="tenue">· revisá los datos de abajo antes de guardar</span>'
           : window.MEK_CONFIG.iaFacturas
             ? '<button type="button" class="primario" id="leerIA"' + (leyendo ? ' disabled' : '') + '>' + (leyendo ? 'Leyendo…' : '✨ Leer los datos con IA') + '</button>'
             : '<span class="tenue">Se guarda junto con el gasto. Completá los datos abajo.</span>') +
        ' <button type="button" class="link" id="quitarAdjunto">quitar</button>' +
      '</div></div>' +
      (d ? htmlLectura(d) : '');
  }

  function htmlLectura(d) {
    const P = M.plata;
    const suma = M.r2((d.items || []).reduce((a, i) => a + (Number(i.importe) || 0), 0));
    const avisos = [];
    if (!d.es_comprobante) avisos.push('No parece un comprobante de compra.');
    if (d.tipo_documento === 'presupuesto') avisos.push('Es un presupuesto, no una factura: cargalo si efectivamente se pagó.');
    if (d.incluye_iva === false) avisos.push('Los precios no incluyen IVA: si se pagó con IVA, corregí el monto.');
    if (d.total != null && d.items && d.items.length && Math.abs(suma - Number(d.total)) > 1) avisos.push('La suma de los ítems (' + P(suma) + ') no da el total (' + P(d.total) + ').');
    if (d.tipo_gasto === 'compra_producto') avisos.push('Parece mercadería para vender: cargala en <a href="compras.html">Compras</a> para que sume al stock.');
    if (d.pagado === false) avisos.push('El comprobante dice que se debe: si no se pagó, cargalo cuando lo pagues.');
    return '<div class="lectura">' +
      (avisos.length ? avisos.map((a) => '<div class="aviso">' + a + '</div>').join('') : '') +
      (d.observaciones ? '<div class="tenue">' + M.esc(d.observaciones) + '</div>' : '') +
      '<div class="tenue">' + M.esc([d.tipo_documento, d.numero ? 'n.º ' + d.numero : '', d.proveedor || 'sin proveedor', d.fecha ? M.fechaCorta(d.fecha) : ''].filter(Boolean).join(' · ')) + '</div>' +
      (d.items && d.items.length ? '<details><summary>' + d.items.length + ' ítem(s) leídos</summary><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Qué</th><th class="num">Cant.</th><th class="num">Importe</th></tr></thead><tbody>' +
        d.items.map((i) => '<tr><td>' + M.esc(i.descripcion) + '</td><td class="num">' + (i.cantidad ?? '—') + '</td><td class="num">' + P(i.importe) + '</td></tr>').join('') +
        '</tbody></table></div></details>' : '') +
      '</div>';
  }

  async function leerIA() {
    if (!adj || leyendo) return;
    if (!navigator.onLine) { M.toast('Para leer la factura hace falta conexión', 'error'); return; }
    leyendo = true; renderAdjunto();
    try {
      const { data, error } = await sb.functions.invoke('leer-factura', { body: { archivo: adj.base64, tipo: adj.tipo } });
      if (error) {
        let msg = error.message || '';
        try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) { /* sin cuerpo */ }
        if (/not found|404|Failed to send/i.test(msg)) msg = 'La lectura con IA todavía no está activada en Supabase. Podés cargar los datos a mano: la factura se guarda igual.';
        throw new Error(msg);
      }
      const d = data.datos;
      adj.datos = d;
      // Completa el formulario; todo se puede corregir antes de guardar.
      if (d.fecha) $('#fecha').value = d.fecha;
      if (d.total != null) $('#monto').value = d.total;
      if (d.categoria_sugerida) $('#categoria').value = d.categoria_sugerida;
      if (d.proveedor) $('#proveedor').value = d.proveedor;
      if (d.detalle_corto) $('#descripcion').value = d.detalle_corto;
      $('#tipo').value = 'costo_operativo';
      M.toast('Leída: revisá los datos y elegí cómo se pagó', 'ok');
    } catch (e) {
      M.toast(M.mensaje(e), 'error', 9000);
    } finally {
      leyendo = false;
      renderAdjunto();
    }
  }

  async function subirArchivo(fecha) {
    const ext = adj.tipo === 'application/pdf' ? 'pdf' : 'jpg';
    const ruta = fecha.slice(0, 7) + '/' + window.Cola.uuid() + '.' + ext;
    const { error } = await sb.storage.from('comprobantes').upload(ruta, adj.blob, { contentType: adj.tipo, upsert: false });
    if (error) throw new Error('No se pudo subir la factura: ' + error.message);
    return ruta;
  }

  async function verComprobante(ruta) {
    const { data, error } = await sb.storage.from('comprobantes').createSignedUrl(ruta, 300);
    if (error) { M.toast('No se pudo abrir: ' + error.message, 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  const primerDia = (mes) => mes + '-01';
  function ultimoDia(mes) {
    const [y, m] = mes.split('-').map(Number);
    return new Date(y, m, 0).toLocaleDateString('en-CA');
  }

  async function cargar() {
    const mes = $('#mes').value;
    try {
      gastos = await M.leerTodo('gastos', '*', (q) => q.gte('fecha', primerDia(mes)).lte('fecha', ultimoDia(mes)), 'fecha');
      M.LS.set('gastos.' + mes, gastos);
    } catch (e) {
      gastos = M.LS.get('gastos.' + mes, []);
      if (navigator.onLine) M.toast('No se pudo leer: ' + M.mensaje(e), 'error');
    }
    render();
  }

  function enCola() {
    return window.Cola.leer().filter((o) => o.tipo === 'gasto').map((o) => Object.assign({}, o.payload, {
      id: null, creado_por: usuario.nombre, enCola: true, error: o.error,
    }));
  }
  const anulando = (g) => window.Cola.leer().some((o) => o.tipo === 'anular_gasto' &&
    ((g.id && o.payload.gasto_id === g.id) || (g.client_id && o.payload.client_id === g.client_id)));

  function render() {
    const mes = $('#mes').value;
    const [y, m] = mes.split('-');
    $('#tituloLista').textContent = 'Gastos de ' + new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    const cola = enCola().filter((g) => g.fecha >= primerDia(mes) && g.fecha <= ultimoDia(mes));
    const lista = cola.concat(gastos.filter((g) => !cola.some((c) => c.client_id && c.client_id === g.client_id)))
      .sort((a, b) => (b.fecha > a.fecha ? 1 : b.fecha < a.fecha ? -1 : (b.id || 1e9) - (a.id || 1e9)));
    const vivos = lista.filter((g) => !g.anulado_en && !anulando(g));
    const suma = (f) => M.r2(vivos.filter(f).reduce((a, g) => a + Number(g.monto), 0));

    $('#resumen').innerHTML =
      '<div class="kpi"><small>Costos del negocio</small><b>' + M.plata(suma((g) => g.tipo === 'costo_operativo')) + '</b></div>' +
      '<div class="kpi"><small>Sueldos y pagos a terceros</small><b>' + M.plata(suma((g) => g.tipo === 'sueldo' || g.tipo === 'pago_tercero')) + '</b>' +
        '<div class="det">de las liquidaciones</div></div>' +
      '<div class="kpi"><small>Compras de mercadería</small><b>' + M.plata(suma((g) => g.tipo === 'compra_producto')) + '</b></div>' +
      '<div class="kpi aparte"><small>Retiros de socio (aparte)</small><b>' + M.plata(suma((g) => g.tipo === 'retiro_socio')) + '</b>' +
        '<div class="det">no son costo del negocio</div></div>';

    $('#lista').innerHTML = '<thead><tr><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Medio</th><th class="num">Monto</th><th></th></tr></thead><tbody>' +
      (lista.length ? lista.map((g) => {
        const anul = g.anulado_en || anulando(g);
        const puede = !anul && !g.liquidacion_id && (!g.compra_id || usuario.rol === 'admin');
        const key = g.id ? 'id:' + g.id : 'c:' + g.client_id;
        return '<tr class="' + (anul ? 'anulado' : '') + '"><td>' + M.fechaCorta(g.fecha) + '</td><td>' + M.esc(TIPOS[g.tipo] || g.tipo) +
          '</td><td>' + M.esc(g.categoria) + '</td><td>' + M.esc([g.proveedor, g.descripcion].filter(Boolean).join(' · ')) +
          (g.comprobante && !g.enCola ? ' <button type="button" class="link" data-ver="' + M.esc(g.comprobante) + '" title="Ver la factura">📎 factura</button>' : '') +
          (g.anulado_motivo ? '<div class="tenue">Anulado: ' + M.esc(g.anulado_motivo) + '</div>' : '') +
          (g.enCola ? ' <span class="pill ' + (g.error ? 'mal' : 'espera') + '">' + (g.error ? 'error: ' + M.esc(g.error) : 'sin sincronizar') + '</span>' : '') +
          '</td><td>' + M.esc(g.medio ? M.nombreMedio(g.medio) : '—') + '</td><td class="num">' + M.plata(g.monto) + '</td><td>' +
          (puede ? '<button type="button" class="link" data-anular="' + key + '">anular</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="tenue">No hay gastos cargados en este mes.</td></tr>') + '</tbody>';

    const cats = new Set(CATEGORIAS.concat(gastos.map((g) => g.categoria)));
    $('#categorias').innerHTML = [...cats].sort().map((c) => '<option value="' + M.esc(c) + '">').join('');
    renderSync();
  }

  function renderSync() {
    const ops = window.Cola.leer();
    const err = ops.filter((o) => o.error).length;
    const b = $('#sync');
    b.className = 'sync' + (err ? ' mal' : ops.length ? ' espera' : ' ok');
    b.textContent = (navigator.onLine ? '' : 'Sin conexión · ') + (err ? err + ' con error' :
      ops.length ? ops.length + ' sin sincronizar' : '✓ Todo sincronizado');
  }

  function renderMedios() {
    $('#medios').innerHTML = M.MEDIOS.map(([k, n]) =>
      '<button type="button" class="chip' + (medio === k ? ' activo' : '') + '" data-medio="' + k + '">' + n + '</button>').join('');
  }

  async function subir() {
    await window.Cola.procesar(sb);
    await cargar();
  }

  async function guardar(ev) {
    ev.preventDefault();
    const monto = M.numero($('#monto').value);
    if (!(monto > 0)) { M.toast('El monto tiene que ser mayor a cero', 'error'); return; }
    if (!$('#categoria').value.trim()) { M.toast('Falta la categoría', 'error'); return; }
    const g = {
      fecha: $('#fecha').value, tipo: $('#tipo').value, categoria: $('#categoria').value.trim(),
      descripcion: $('#descripcion').value.trim() || null, monto, medio,
    };
    const proveedor = $('#proveedor').value.trim();
    if (g.tipo === 'retiro_socio' && !confirm('¿Es un retiro de socio (plata que se lleva una socia), no un gasto del negocio?')) return;
    // Con factura: primero se sube el archivo (hace falta conexión) y la
    // cola lo vincula al gasto apenas el gasto entra en la base.
    if (adj) {
      if (!navigator.onLine) { M.toast('Para guardar la factura hace falta conexión (o quitala y cargá el gasto solo)', 'error'); return; }
      try { g.comprobante = await subirArchivo(g.fecha); } catch (e) { M.toast(M.mensaje(e), 'error'); return; }
      g.comprobante_datos = adj.datos;
    }
    if (proveedor) g.proveedor = proveedor;
    window.Cola.agregar('gasto', g);
    $('#monto').value = '';
    $('#descripcion').value = '';
    $('#proveedor').value = '';
    adj = null;
    $('#archivo').value = '';
    renderAdjunto();
    medio = null;
    renderMedios();
    M.toast('Gasto guardado: ' + g.categoria + ' ' + M.plata(monto) + (navigator.onLine ? '' : ' (sin conexión: se sube solo)'), 'ok');
    render();
    subir();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.medio) { medio = medio === t.dataset.medio ? null : t.dataset.medio; renderMedios(); }
    if (t.dataset.anular) {
      const motivo = prompt('¿Por qué se anula? (queda registrado; el gasto no se borra)');
      if (!motivo || !motivo.trim()) return;
      const [k, v] = t.dataset.anular.split(/:(.+)/);
      window.Cola.agregar('anular_gasto', k === 'id' ? { gasto_id: Number(v), motivo: motivo.trim() } : { client_id: v, motivo: motivo.trim() });
      render();
      subir();
    }
    if (t.id === 'sync') subir();
    if (t.id === 'leerIA') leerIA();
    if (t.id === 'quitarAdjunto') { adj = null; $('#archivo').value = ''; renderAdjunto(); }
    if (t.dataset.ver) verComprobante(t.dataset.ver);
  });
  document.addEventListener('change', (ev) => { if (ev.target.id === 'archivo') elegirArchivo(ev.target.files[0]); });

  async function iniciar() {
    usuario = await M.requerirSesion('gastos');
    if (!usuario) return;
    M.salirBoton();
    $('#fecha').value = M.hoy();
    $('#mes').value = M.hoy().slice(0, 7);
    if (usuario.rol !== 'admin') document.querySelectorAll('[data-admin]').forEach((o) => o.remove());
    renderMedios();
    $('#form').addEventListener('submit', guardar);
    $('#mes').addEventListener('change', cargar);
    window.Cola.alCambiar(renderSync);
    window.addEventListener('online', subir);
    window.addEventListener('offline', renderSync);
    setInterval(() => { if (window.Cola.leer().length) subir(); }, 20000);
    await cargar();
    subir();
  }
  iniciar();
})();
