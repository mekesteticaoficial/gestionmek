// Cálculo de precios y comisiones para MOSTRAR antes de confirmar.
// Es la misma lógica que registrar_venta() en sql/02_cobro.sql; la que
// se guarda es la de la base. Si se cambia una, cambiar la otra.
//
// Funciona sin conexión: trabaja sobre el catálogo guardado en el navegador.
(function (global) {
  'use strict';

  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  function precioVigente(cat, tratId, fecha) {
    let best = null;
    for (const p of cat.precios) {
      if (p.tratamiento_id === tratId && p.vigente_desde <= fecha &&
          (!best || p.vigente_desde > best.vigente_desde)) best = p;
    }
    return best ? Number(best.precio) : null;
  }

  // Primero la regla del tratamiento, después la de la categoría.
  function regla(cat, profId, trat, categoria, fecha) {
    let best = null, bestRank = null;
    for (const r of cat.reglas) {
      if (r.profesional_id !== profId || r.vigente_desde > fecha) continue;
      const esTrat = !!trat && r.tratamiento_id === trat.id;
      const esCat = r.tratamiento_id == null && r.categoria === categoria;
      if (!esTrat && !esCat) continue;
      const rank = [esTrat ? 1 : 0, r.vigente_desde, r.id];
      if (!best || cmp(rank, bestRank) > 0) { best = r; bestRank = rank; }
    }
    return best;
  }

  function zonasVigentes(cat, sexo, fecha) {
    return cat.zonas.filter((z) => z.activo && z.vigente_desde <= fecha &&
                                   (z.sexo === sexo || z.sexo === 'ambos'));
  }

  const clave = (z) => z.nombre + '|' + z.sexo;
  const mismoConjunto = (a, b) => a.length === b.length &&
    a.slice().sort().every((x, i) => x === b.slice().sort()[i]);

  // Promo exacta con precio fijado, o escala: de más cara a más barata,
  // 1ª 100%, 2ª 40%, 3ª 30%, 4ª y siguientes 25%. Sin piso ni redondeo.
  function cotizarDepilacion(cat, zonaIds, sexo, fecha) {
    const zonas = zonaIds.map((id) => cat.zonas.find((z) => z.id === id)).filter(Boolean);
    if (!zonas.length) return { precio: null, promo: null, zonas: [] };
    const claves = zonas.map(clave);

    const promo = cat.promos
      .filter((p) => p.activo && p.sexo === sexo && p.precio_fijado != null)
      .sort((a, b) => a.id - b.id)
      .find((p) => mismoConjunto(
        cat.promoZonas.filter((pz) => pz.promo_id === p.id)
          .map((pz) => cat.zonas.find((z) => z.id === pz.zona_id))
          .filter(Boolean).map(clave),
        claves));

    const ordenadas = zonas.slice().sort((a, b) => b.precio - a.precio || a.id - b.id);
    if (promo) return { precio: Number(promo.precio_fijado), promo, zonas: ordenadas };

    const escala = cat.escala.filter((e) => e.vigente_desde <= fecha);
    const maxPos = Math.max(...escala.map((e) => e.posicion));
    let total = 0;
    ordenadas.forEach((z, i) => {
      const e = escala.find((x) => x.posicion === Math.min(i + 1, maxPos));
      total += Number(z.precio) * Number(e.porcentaje) / 100;
    });
    return { precio: r2(total), promo: null, zonas: ordenadas };
  }

  // Calcula un ítem del ticket tal como lo va a guardar la base.
  // it: {tipo, tratamiento_id, sexo, zona_ids, producto_id, pack_id,
  //      cantidad, profesional_id, precio_cobrado, costo_insumo}
  // Devuelve lo que se muestra: descripción, lista, cobrado (lo que entra
  // a MEK), comisión, parte del tercero, avisos y errores.
  function calcularItem(cat, it, fecha) {
    const out = {
      descripcion: '', lista: null, cobrado: num(it.precio_cobrado), pagoPaciente: num(it.precio_cobrado),
      comision: null, tercero: null, parteMek: null, sinRegla: false,
      costo: num(it.costo_insumo), categoria: null, conComision: false,
      errores: [], avisos: [],
    };
    const cant = num(it.cantidad) || 1;
    const prof = it.profesional_id ? cat.profesionales.find((p) => p.id === it.profesional_id) : null;
    let trat = null, base = out.cobrado;

    if (['tratamiento', 'cabina', 'pack_venta'].includes(it.tipo)) {
      trat = cat.tratamientos.find((t) => t.id === it.tratamiento_id);
      if (!trat) { out.errores.push('Tratamiento inexistente'); return out; }
      out.categoria = trat.categoria;
      out.descripcion = trat.nombre;
      if (trat.precio_variable) {
        out.lista = out.cobrado;
        if (out.cobrado == null) out.errores.push('Escribí el monto');
        else if (trat.precio_min != null && trat.precio_max != null &&
                 (out.cobrado < Number(trat.precio_min) || out.cobrado > Number(trat.precio_max))) {
          out.avisos.push('Fuera del rango de referencia (' + plata(trat.precio_min) + '–' + plata(trat.precio_max) + ')');
        }
      } else {
        const p = precioVigente(cat, trat.id, fecha);
        if (p == null) out.errores.push(trat.nombre + ' no tiene precio vigente al ' + fechaCorta(fecha));
        else out.lista = p * cant;
      }
      if (it.tipo === 'tratamiento' && trat.categoria !== 'cabina' && !prof) out.errores.push('Falta quién lo hizo');

    } else if (it.tipo === 'depilacion') {
      const c = cotizarDepilacion(cat, it.zona_ids || [], it.sexo, fecha);
      out.categoria = 'depilacion';
      out.lista = c.precio;
      out.descripcion = 'Depilación ' + it.sexo + ': ' +
        (c.promo ? c.promo.nombre + ' (' : '') + c.zonas.map((z) => z.nombre).join(' + ') + (c.promo ? ')' : '');
      if (c.promo && c.promo.revisar) out.avisos.push(c.promo.nombre + ': precio marcado para revisar');
      if (!c.zonas.length) out.errores.push('Elegí al menos una zona');
      if (!prof) out.errores.push('Falta quién lo hizo');

    } else if (it.tipo === 'pack_sesion') {
      const pk = cat.packs.find((p) => p.id === it.pack_id);
      if (!pk) { out.errores.push('Pack inexistente'); return out; }
      const tp = cat.tratamientos.find((t) => t.id === pk.tratamiento_id);
      trat = tp && tp.pack_tratamiento_id ? cat.tratamientos.find((t) => t.id === tp.pack_tratamiento_id) : tp;
      out.categoria = trat ? trat.categoria : null;
      out.cobrado = 0;
      out.lista = r2(Number(pk.precio_pagado) / pk.sesiones_totales);
      base = out.lista;
      out.descripcion = pk.nombre + ' — sesión ' + (pk.sesiones_totales - pk.disponibles + 1) + '/' + pk.sesiones_totales;
      if (pk.disponibles <= 0) out.errores.push('No le quedan sesiones');
      if (out.categoria !== 'cabina' && !prof) out.errores.push('Falta quién lo hizo');

    } else if (it.tipo === 'producto') {
      const pr = cat.productos.find((p) => p.id === it.producto_id);
      if (!pr) { out.errores.push('Producto inexistente'); return out; }
      out.descripcion = pr.nombre + (cant !== 1 ? ' x' + cant : '');
      if (pr.precio_venta == null) {
        out.lista = out.cobrado;
        out.avisos.push('Sin precio de lista: escribí el monto');
      } else out.lista = Number(pr.precio_venta) * cant;
      if (out.costo == null && pr.costo_promedio != null) out.costo = Number(pr.costo_promedio) * cant;
    }

    if (out.cobrado == null || out.cobrado < 0) {
      if (!out.errores.length) out.errores.push('Falta el precio');
      return out;
    }

    // Comisión. Cabina, venta de pack y productos no generan.
    if (prof && ['tratamiento', 'depilacion', 'pack_sesion'].includes(it.tipo) && out.categoria !== 'cabina') {
      out.conComision = true;
      const r = regla(cat, prof.id, trat, out.categoria, fecha);
      if (!r) {
        if (prof.modelo === 'invitado_cobra_el') {
          out.errores.push('No hay regla para ' + prof.nombre + ': no se sabe qué parte queda para MEK');
        } else {
          out.sinRegla = true;
          out.avisos.push('No hay regla de comisión para ' + prof.nombre + ' en esto. Se guarda sin comisión y Franco lo resuelve.');
        }
      } else {
        let monto = r.tipo === 'porcentaje' ? r2(base * Number(r.valor) / 100) : r2(Number(r.valor) * cant);
        out.comision = { tipo: r.tipo, valor: Number(r.valor), monto, prof };
        if (prof.modelo === 'invitado_cobra_mek') {
          out.tercero = monto;
          out.comision.monto = 0;
        } else if (prof.modelo === 'invitado_cobra_el') {
          const partLista = r.tipo === 'porcentaje' ? r2(out.lista * Number(r.valor) / 100) : r2(Number(r.valor) * cant);
          out.lista = Math.max(r2(out.lista - partLista), 0);
          out.cobrado = Math.max(r2(out.cobrado - monto), 0);
          out.parteMek = out.cobrado;
          out.comision.monto = 0;
          out.descripcion += ' (parte MEK de ' + plata(out.pagoPaciente) + ')';
        }
      }
    }
    return out;
  }

  // Margen: si falta el costo, no hay número.
  function margen(res) {
    if (res.cobrado == null || res.costo == null) return null;
    return r2(res.cobrado - (res.tercero || 0) - (res.comision ? res.comision.monto : 0) - res.costo);
  }

  function plata(n) {
    if (n === null || n === undefined || n === '') return '—';
    return '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  }
  function fechaCorta(f) { const [y, m, d] = f.split('-'); return d + '/' + m + '/' + y; }

  global.Calculo = { precioVigente, regla, zonasVigentes, cotizarDepilacion, calcularItem, margen, plata, fechaCorta, r2 };
})(typeof window !== 'undefined' ? window : globalThis);
