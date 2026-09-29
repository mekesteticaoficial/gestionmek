-- =====================================================================
-- MEK Estética — 02: PANTALLA DE COBRO
--
-- Correr DESPUÉS de 01_mek_completo.sql, en el SQL Editor de Supabase.
-- Se puede correr más de una vez: no borra datos.
--
-- Qué agrega:
--   1. Seguridad: RLS en todas las tablas, vistas que respetan RLS,
--      tabla de usuarios con rol.
--   2. Idempotencia: ventas.client_id (un reintento no duplica).
--   3. Packs: catálogo de packs dentro de tratamientos.
--   4. Datos confirmados por Franco (29/09/2026):
--      - Silvia no cobra comisión tampoco en depilación.
--      - Depilación sin piso y sin redondeo.
--      - Pack cabina: 5 sesiones de 10 min por $60.000. Cabina sin comisión.
--   5. Funciones de escritura (la app NO escribe tablas directo):
--      registrar_venta, cobrar_venta, anular_venta, sincronizar_pacientes.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. COLUMNAS NUEVAS
-- ---------------------------------------------------------------------

-- Id generado en el navegador. Reintentar la misma venta no la duplica.
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS client_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_client ON ventas (client_id);

-- Un tratamiento con pack_sesiones es un pack que se vende entero y se
-- consume de a una sesión. pack_tratamiento_id = qué se hace en cada sesión.
ALTER TABLE tratamientos
  ADD COLUMN IF NOT EXISTS pack_sesiones int CHECK (pack_sesiones > 0),
  ADD COLUMN IF NOT EXISTS pack_tratamiento_id int REFERENCES tratamientos(id);

-- De qué pack del catálogo salió cada pack vendido.
ALTER TABLE packs ADD COLUMN IF NOT EXISTS tratamiento_id int REFERENCES tratamientos(id);

-- Pagos: una venta puede pagarse con más de un medio.
-- ventas.medio_pago queda como resumen ('efectivo', 'mixto', 'pack'...).
-- La caja por medio de pago sale de esta tabla.
CREATE TABLE IF NOT EXISTS venta_pagos (
  id        serial PRIMARY KEY,
  venta_id  int NOT NULL REFERENCES ventas(id),
  medio     text NOT NULL CHECK (medio IN ('efectivo', 'transferencia', 'debito',
                                           'credito', 'mercadopago')),
  monto     numeric(12,2) NOT NULL CHECK (monto > 0),
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pagos_venta ON venta_pagos (venta_id);

DROP TRIGGER IF EXISTS tg_aud_pagos ON venta_pagos;
CREATE TRIGGER tg_aud_pagos AFTER INSERT OR UPDATE OR DELETE ON venta_pagos
  FOR EACH ROW EXECUTE FUNCTION fn_auditar();

-- ---------------------------------------------------------------------
-- 2. USUARIOS
-- 'admin' = Franco: edita precios, cierra liquidaciones.
-- 'carga' = Silvia y Yael: cargan y consultan.
-- Los usuarios se dan de alta en 03_usuarios.sql.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id),
  nombre          text NOT NULL,
  rol             text NOT NULL CHECK (rol IN ('admin', 'carga')),
  profesional_id  int REFERENCES profesionales(id)   -- para precargar "quién lo hizo"
);

CREATE OR REPLACE FUNCTION app_rol() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rol FROM usuarios WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION app_nombre() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT nombre FROM usuarios WHERE user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------
-- 3. AUDITORÍA: registrar quién hizo cada cambio.
-- Antes leía solo app.usuario, que por la API siempre llega vacío.
-- SECURITY DEFINER para que pueda escribir auditoria aunque tenga RLS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_auditar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_antes   jsonb;
  v_despues jsonb;
  v_id      text;
  v_usuario text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_antes := to_jsonb(OLD); v_id := OLD.id::text;
  ELSIF TG_OP = 'INSERT' THEN
    v_despues := to_jsonb(NEW); v_id := NEW.id::text;
  ELSE
    v_antes := to_jsonb(OLD); v_despues := to_jsonb(NEW); v_id := NEW.id::text;
  END IF;

  v_usuario := coalesce(nullif(current_setting('app.usuario', true), ''),
                        (SELECT nombre FROM usuarios WHERE user_id = auth.uid()),
                        auth.uid()::text,
                        current_user);

  INSERT INTO auditoria (tabla, registro_id, accion, antes, despues, usuario)
  VALUES (TG_TABLE_NAME, v_id, lower(TG_OP), v_antes, v_despues, v_usuario);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 4. DATOS CONFIRMADOS
-- ---------------------------------------------------------------------

-- Silvia: todo lo que hace queda para MEK, depilación incluida.
INSERT INTO reglas_comision (profesional_id, categoria, tipo, valor, vigente_desde)
SELECT p.id, 'depilacion', 'porcentaje', 0, DATE '2026-10-01'
FROM profesionales p
WHERE p.nombre = 'Silvia Orsi'
  AND NOT EXISTS (SELECT 1 FROM reglas_comision r
                  WHERE r.profesional_id = p.id AND r.categoria = 'depilacion');

-- Depilación: no hay piso ni redondeo. Se sacan para que nadie los use.
DELETE FROM config WHERE clave IN ('depilacion_piso_promo', 'depilacion_redondeo');

-- Pack de cabina.
INSERT INTO tratamientos (nombre, categoria, pack_sesiones, pack_tratamiento_id)
SELECT 'Pack cabina 5 x 10 min', 'cabina', 5, t.id
FROM tratamientos t
WHERE t.nombre = 'Cabina solar 10 min'
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO precios_tratamiento (tratamiento_id, precio, vigente_desde)
SELECT id, 60000, DATE '2026-10-01' FROM tratamientos WHERE nombre = 'Pack cabina 5 x 10 min'
ON CONFLICT (tratamiento_id, vigente_desde) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. CÁLCULOS (mismas reglas que js/calculo.js)
-- ---------------------------------------------------------------------

-- Monto como se escribe acá: $18.000 / $18.000,5 (igual que la pantalla).
CREATE OR REPLACE FUNCTION fn_plata(n numeric) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '$' || translate(rtrim(rtrim(to_char(round(n, 2), 'FM999,999,999,990.00'), '0'), '.'), ',.', '.,')
$$;

-- Precio de lista vigente a una fecha. NULL = no hay precio cargado.
CREATE OR REPLACE FUNCTION fn_precio(p_trat int, p_fecha date) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT precio FROM precios_tratamiento
  WHERE tratamiento_id = p_trat AND vigente_desde <= p_fecha
  ORDER BY vigente_desde DESC LIMIT 1
$$;

-- Regla de comisión: primero la del tratamiento, después la de la
-- categoría; dentro de cada una, la más reciente vigente a la fecha.
CREATE OR REPLACE FUNCTION fn_regla(p_prof int, p_trat int, p_cat text, p_fecha date)
RETURNS reglas_comision
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT r.* FROM reglas_comision r
  WHERE r.profesional_id = p_prof
    AND r.vigente_desde <= p_fecha
    AND ((p_trat IS NOT NULL AND r.tratamiento_id = p_trat)
         OR (r.tratamiento_id IS NULL AND r.categoria = p_cat))
  ORDER BY (r.tratamiento_id IS NOT NULL) DESC, r.vigente_desde DESC, r.id DESC
  LIMIT 1
$$;

-- Precio de lista de una combinación de zonas.
-- Si la combinación es exactamente una promo activa con precio fijado,
-- vale la promo. Si no, escala: zonas de más cara a más barata,
-- 1ª 100%, 2ª 40%, 3ª 30%, 4ª y siguientes 25%. Sin piso, sin redondeo.
-- Recibe ids de zonas vigentes a la fecha (ver fn_zonas_vigentes).
CREATE OR REPLACE FUNCTION fn_cotizar_depilacion(p_zonas int[], p_sexo sexo_zona, p_fecha date,
                                                 OUT precio numeric, OUT promo_id int)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_claves text[];
  v_max_pos int;
BEGIN
  SELECT array_agg(z.nombre || '|' || z.sexo ORDER BY z.nombre, z.sexo)
    INTO v_claves FROM zonas_depilacion z WHERE z.id = ANY (p_zonas);

  -- ¿Es una promo? Se compara por nombre de zona, no por id, para que
  -- una zona con precio nuevo siga reconociendo la promo.
  SELECT pr.id, pr.precio_fijado INTO promo_id, precio
  FROM promos_depilacion pr
  WHERE pr.activo AND pr.sexo = p_sexo AND pr.precio_fijado IS NOT NULL
    AND (SELECT array_agg(z.nombre || '|' || z.sexo ORDER BY z.nombre, z.sexo)
         FROM promo_zonas pz JOIN zonas_depilacion z ON z.id = pz.zona_id
         WHERE pz.promo_id = pr.id) = v_claves
  ORDER BY pr.id LIMIT 1;

  IF promo_id IS NOT NULL THEN RETURN; END IF;

  SELECT max(posicion) INTO v_max_pos FROM escala_depilacion WHERE vigente_desde <= p_fecha;

  SELECT round(sum(o.precio * e.porcentaje / 100), 2) INTO precio
  FROM (SELECT z.precio, row_number() OVER (ORDER BY z.precio DESC, z.id) AS pos
        FROM zonas_depilacion z WHERE z.id = ANY (p_zonas)) o
  JOIN escala_depilacion e ON e.posicion = least(o.pos, v_max_pos);
END $$;

-- ---------------------------------------------------------------------
-- 6. ESCRITURA
-- Todas las escrituras de cobro pasan por estas funciones: una venta
-- entra entera o no entra, y la comisión la calcula la base.
-- ---------------------------------------------------------------------

-- Espejo de pacientes desde Firebase. Solo agrega o actualiza: nunca borra.
CREATE OR REPLACE FUNCTION sincronizar_pacientes(p jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF app_rol() IS NULL THEN RAISE EXCEPTION 'Usuario no habilitado'; END IF;

  INSERT INTO pacientes (ref, nombre, telefono, email, sincronizado_en)
  SELECT x->>'ref', x->>'nombre', nullif(x->>'telefono', ''), nullif(x->>'email', ''), now()
  FROM jsonb_array_elements(p) x
  WHERE coalesce(x->>'ref', '') <> '' AND coalesce(trim(x->>'nombre'), '') <> ''
  ON CONFLICT (ref) DO UPDATE
    SET nombre = EXCLUDED.nombre, telefono = EXCLUDED.telefono,
        email = EXCLUDED.email, sincronizado_en = now()
    WHERE (pacientes.nombre, pacientes.telefono, pacientes.email)
          IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.telefono, EXCLUDED.email);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Pagos de una venta: [{medio, monto}, ...]. Tienen que sumar exactamente
-- lo cobrado en los ítems. Devuelve el resumen para ventas.medio_pago:
-- el medio si es uno solo, 'mixto' si son varios, 'pack' si no hay plata.
CREATE OR REPLACE FUNCTION fn_registrar_pagos(p_venta int, p_pagos jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_total  numeric;
  v_pagado numeric;
  v_n      int;
  v_medio  text;
BEGIN
  SELECT coalesce(sum(precio_cobrado), 0) INTO v_total FROM venta_items WHERE venta_id = p_venta;
  IF EXISTS (SELECT 1 FROM venta_pagos WHERE venta_id = p_venta) THEN
    RAISE EXCEPTION 'La venta % ya tiene pagos', p_venta;
  END IF;

  SELECT coalesce(sum((x->>'monto')::numeric), 0), count(*), min(x->>'medio')
    INTO v_pagado, v_n, v_medio
  FROM jsonb_array_elements(coalesce(p_pagos, '[]')) x
  WHERE (x->>'monto')::numeric > 0;

  IF v_total = 0 THEN
    IF v_n > 0 THEN RAISE EXCEPTION 'La venta % no tiene nada para cobrar', p_venta; END IF;
    RETURN CASE WHEN EXISTS (SELECT 1 FROM venta_items WHERE venta_id = p_venta AND tipo = 'pack_sesion')
                THEN 'pack' ELSE 'sin_cargo' END;
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'Falta el medio de pago'; END IF;
  IF v_pagado <> v_total THEN
    RAISE EXCEPTION 'Los pagos suman $% y la venta es de $%', v_pagado, v_total;
  END IF;

  INSERT INTO venta_pagos (venta_id, medio, monto)
  SELECT p_venta, x->>'medio', (x->>'monto')::numeric
  FROM jsonb_array_elements(p_pagos) x
  WHERE (x->>'monto')::numeric > 0;

  RETURN CASE WHEN (SELECT count(DISTINCT medio) FROM venta_pagos WHERE venta_id = p_venta) > 1
              THEN 'mixto' ELSE v_medio END;
END $$;

-- Registra una venta completa. Formato de p:
-- {
--   client_id, fecha, paciente_ref, paciente:{ref,nombre,telefono,email}?,
--   estado: 'cobrada'|'pendiente', pagos:[{medio, monto}], nota, turno_ref,
--   items: [
--     {tipo:'tratamiento', tratamiento_id, profesional_id, precio_cobrado, costo_insumo?},
--     {tipo:'depilacion',  sexo, zona_ids:[..], profesional_id, precio_cobrado},
--     {tipo:'cabina',      tratamiento_id, precio_cobrado},
--     {tipo:'pack_venta',  tratamiento_id, precio_cobrado},
--     {tipo:'pack_sesion', pack_id, profesional_id?},
--     {tipo:'producto',    producto_id, cantidad, precio_cobrado}
--   ]
-- }
-- precio_cobrado es el total de la línea (lo que pagó el paciente por ella).
-- Devuelve {venta_id, ya_existia}.
CREATE OR REPLACE FUNCTION registrar_venta(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario   text := app_nombre();
  v_client    uuid := (p->>'client_id')::uuid;
  v_fecha     date := (p->>'fecha')::date;
  v_estado    estado_venta := coalesce(p->>'estado', 'cobrada')::estado_venta;
  v_venta     int;
  it          jsonb;
  v_tipo      tipo_item;
  v_trat      tratamientos%ROWTYPE;
  v_prof      profesionales%ROWTYPE;
  v_prod      productos%ROWTYPE;
  v_pack      packs%ROWTYPE;
  v_regla     reglas_comision%ROWTYPE;
  v_cat       text;
  v_desc      text;
  v_lista     numeric;
  v_cobrado   numeric;
  v_base      numeric;       -- sobre qué se calcula la comisión
  v_cant      numeric;
  v_com_tipo  tipo_comision;
  v_com_valor numeric;
  v_com_monto numeric;
  v_tercero   numeric;
  v_costo     numeric;
  v_promo     int;
  v_sexo      sexo_zona;
  v_zonas     int[];
  v_n_zonas   int;
  v_item      int;
  v_sesion    int;
  v_num       int;
  v_medio     text;
BEGIN
  IF v_usuario IS NULL THEN RAISE EXCEPTION 'Usuario no habilitado'; END IF;
  IF v_client IS NULL THEN RAISE EXCEPTION 'Falta client_id'; END IF;
  IF v_fecha IS NULL THEN RAISE EXCEPTION 'Falta la fecha'; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'Una venta nueva no puede estar anulada'; END IF;
  IF jsonb_array_length(coalesce(p->'items', '[]')) = 0 THEN
    RAISE EXCEPTION 'La venta no tiene ítems';
  END IF;

  -- Reintento: ya estaba guardada. No se toca nada.
  SELECT id INTO v_venta FROM ventas WHERE client_id = v_client;
  IF FOUND THEN
    RETURN jsonb_build_object('venta_id', v_venta, 'ya_existia', true);
  END IF;

  PERFORM set_config('app.usuario', v_usuario, true);

  -- Paciente: si vino con datos (venta hecha sin conexión con un
  -- paciente todavía no espejado), se asegura el espejo.
  IF p ? 'paciente' THEN
    PERFORM sincronizar_pacientes(jsonb_build_array(p->'paciente'));
  END IF;

  INSERT INTO ventas (fecha, paciente_ref, medio_pago, estado, origen, turno_ref,
                      nota, creado_por, cobrado_en, client_id)
  -- Entra pendiente; si se cobró, pasa a cobrada al final, cuando ya se
  -- sabe el total real y se validaron los pagos contra ese total.
  VALUES (v_fecha, p->>'paciente_ref', NULL, 'pendiente', 'manual', nullif(p->>'turno_ref', ''),
          nullif(p->>'nota', ''), v_usuario, NULL, v_client)
  RETURNING id INTO v_venta;

  FOR it IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
    v_tipo := (it->>'tipo')::tipo_item;
    v_cant := coalesce((it->>'cantidad')::numeric, 1);
    v_cobrado := (it->>'precio_cobrado')::numeric;
    v_costo := (it->>'costo_insumo')::numeric;          -- NULL = sin dato
    v_trat := NULL; v_prof := NULL; v_prod := NULL; v_pack := NULL; v_regla := NULL;
    v_promo := NULL; v_cat := NULL; v_lista := NULL; v_desc := NULL;
    v_com_tipo := NULL; v_com_valor := NULL; v_com_monto := 0; v_tercero := NULL;
    v_zonas := NULL;

    IF v_cant <= 0 THEN RAISE EXCEPTION 'Cantidad inválida'; END IF;

    IF it ? 'profesional_id' AND it->>'profesional_id' IS NOT NULL THEN
      SELECT * INTO v_prof FROM profesionales WHERE id = (it->>'profesional_id')::int;
      IF NOT FOUND THEN RAISE EXCEPTION 'Profesional inexistente'; END IF;
    END IF;

    -- ---- qué es y cuánto vale de lista
    IF v_tipo IN ('tratamiento', 'cabina', 'pack_venta') THEN
      SELECT * INTO v_trat FROM tratamientos WHERE id = (it->>'tratamiento_id')::int;
      IF NOT FOUND THEN RAISE EXCEPTION 'Tratamiento inexistente'; END IF;
      IF (v_tipo = 'pack_venta') <> (v_trat.pack_sesiones IS NOT NULL) THEN
        RAISE EXCEPTION '%: los packs se venden como pack_venta y solo los packs', v_trat.nombre;
      END IF;
      IF v_tipo = 'tratamiento' AND v_trat.categoria <> 'cabina' AND v_prof.id IS NULL THEN
        RAISE EXCEPTION 'Falta quién hizo %', v_trat.nombre;
      END IF;
      v_cat := v_trat.categoria;
      v_desc := v_trat.nombre;
      IF v_trat.precio_variable THEN
        -- Sin precio de catálogo: el precio acordado es el de lista.
        v_lista := v_cobrado;
      ELSE
        v_lista := fn_precio(v_trat.id, v_fecha);
        IF v_lista IS NULL THEN
          RAISE EXCEPTION '% no tiene precio vigente al %', v_trat.nombre, v_fecha;
        END IF;
        v_lista := v_lista * v_cant;
      END IF;
      v_base := v_cobrado;

    ELSIF v_tipo = 'depilacion' THEN
      v_sexo := (it->>'sexo')::sexo_zona;
      IF v_sexo NOT IN ('mujer', 'hombre') THEN RAISE EXCEPTION 'Depilación: elegir mujer u hombre'; END IF;
      IF v_prof.id IS NULL THEN RAISE EXCEPTION 'Falta quién hizo la depilación'; END IF;
      SELECT array_agg(DISTINCT x::int) INTO v_zonas FROM jsonb_array_elements_text(it->'zona_ids') x;
      IF v_zonas IS NULL THEN RAISE EXCEPTION 'Depilación sin zonas'; END IF;
      SELECT count(*) INTO v_n_zonas FROM zonas_depilacion
      WHERE id = ANY (v_zonas) AND activo AND sexo IN (v_sexo, 'ambos') AND vigente_desde <= v_fecha;
      IF v_n_zonas <> array_length(v_zonas, 1) THEN
        RAISE EXCEPTION 'Depilación: hay zonas que no corresponden a % o no están vigentes', v_sexo;
      END IF;
      SELECT c.precio, c.promo_id INTO v_lista, v_promo FROM fn_cotizar_depilacion(v_zonas, v_sexo, v_fecha) c;
      v_cat := 'depilacion';
      SELECT 'Depilación ' || v_sexo || ': '
             || coalesce((SELECT nombre || ' (' FROM promos_depilacion WHERE id = v_promo), '')
             || string_agg(z.nombre, ' + ' ORDER BY z.precio DESC, z.id)
             || CASE WHEN v_promo IS NOT NULL THEN ')' ELSE '' END
        INTO v_desc FROM zonas_depilacion z WHERE z.id = ANY (v_zonas);
      v_base := v_cobrado;

    ELSIF v_tipo = 'pack_sesion' THEN
      SELECT * INTO v_pack FROM packs WHERE id = (it->>'pack_id')::int FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Pack inexistente'; END IF;
      IF v_pack.paciente_ref <> p->>'paciente_ref' THEN
        RAISE EXCEPTION 'El pack % es de otra paciente', v_pack.id;
      END IF;
      IF v_pack.estado <> 'activo' THEN RAISE EXCEPTION 'El pack % no está activo', v_pack.id; END IF;
      SELECT * INTO v_trat FROM tratamientos
      WHERE id = (SELECT coalesce(pack_tratamiento_id, id) FROM tratamientos WHERE id = v_pack.tratamiento_id);
      IF NOT FOUND THEN RAISE EXCEPTION 'El pack % no está asociado a un tratamiento', v_pack.id; END IF;
      v_cat := v_trat.categoria;
      IF v_cat <> 'cabina' AND v_prof.id IS NULL THEN
        RAISE EXCEPTION 'Falta quién hizo la sesión de %', v_pack.nombre;
      END IF;
      -- No entra plata: se pagó al vender el pack. La comisión se
      -- calcula sobre el valor de una sesión.
      v_cobrado := 0;
      v_lista := round(v_pack.precio_pagado / v_pack.sesiones_totales, 2);
      v_base := v_lista;
      SELECT id, numero INTO v_sesion, v_num FROM pack_sesiones
      WHERE pack_id = v_pack.id AND consumida_en IS NULL ORDER BY numero LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'El pack % no tiene sesiones disponibles', v_pack.id; END IF;
      v_desc := v_pack.nombre || ' — sesión ' || v_num || '/' || v_pack.sesiones_totales;

    ELSIF v_tipo = 'producto' THEN
      SELECT * INTO v_prod FROM productos WHERE id = (it->>'producto_id')::int;
      IF NOT FOUND THEN RAISE EXCEPTION 'Producto inexistente'; END IF;
      v_desc := v_prod.nombre || CASE WHEN v_cant <> 1 THEN ' x' || v_cant ELSE '' END;
      IF v_prod.precio_venta IS NULL THEN
        v_lista := v_cobrado;
        v_desc := v_desc || ' (sin precio de lista)';
      ELSE
        v_lista := v_prod.precio_venta * v_cant;
      END IF;
      IF v_costo IS NULL AND v_prod.costo_promedio IS NOT NULL THEN
        v_costo := v_prod.costo_promedio * v_cant;
      END IF;
      v_base := v_cobrado;

    ELSE
      RAISE EXCEPTION 'Tipo de ítem no soportado todavía: %', v_tipo;
    END IF;

    IF v_cobrado IS NULL OR v_cobrado < 0 THEN
      RAISE EXCEPTION 'Falta el precio cobrado de %', v_desc;
    END IF;

    -- ---- comisión (REGLA 3: se congela acá y no se recalcula nunca)
    -- Cabina, pack_venta y productos no generan comisión.
    IF v_prof.id IS NOT NULL AND v_tipo IN ('tratamiento', 'depilacion', 'pack_sesion')
       AND v_cat <> 'cabina' THEN
      v_regla := fn_regla(v_prof.id, v_trat.id, v_cat, v_fecha);
      IF v_regla.id IS NULL THEN
        IF v_prof.modelo = 'invitado_cobra_el' THEN
          RAISE EXCEPTION 'No hay regla para % con %: no se puede saber qué parte queda para MEK',
                          v_desc, v_prof.nombre;
        END IF;
        -- Sin regla: comision_tipo queda NULL (no es un cero) y el ítem
        -- aparece en v_items_sin_regla hasta que Franco cargue la regla.
      ELSE
        v_com_tipo := v_regla.tipo;
        v_com_valor := v_regla.valor;
        v_com_monto := CASE v_regla.tipo
                         WHEN 'porcentaje' THEN round(v_base * v_regla.valor / 100, 2)
                         ELSE round(v_regla.valor * v_cant, 2) END;

        IF v_prof.modelo = 'invitado_cobra_mek' THEN
          -- REGLA 4: lo del tercero va aparte; MEK no le paga comisión.
          v_tercero := v_com_monto;
          v_com_monto := 0;
        ELSIF v_prof.modelo = 'invitado_cobra_el' THEN
          -- Cobra el profesional. Se registra solo lo que entra a MEK.
          v_desc := v_desc || ' (parte MEK de ' || fn_plata(v_cobrado) || ')';
          v_lista := greatest(v_lista - CASE v_regla.tipo
                       WHEN 'porcentaje' THEN round(v_lista * v_regla.valor / 100, 2)
                       ELSE round(v_regla.valor * v_cant, 2) END, 0);
          v_cobrado := greatest(v_cobrado - v_com_monto, 0);
          v_com_monto := 0;
        END IF;
      END IF;
    END IF;

    INSERT INTO venta_items (venta_id, tipo, descripcion, tratamiento_id, promo_id,
                             producto_id, pack_id, cantidad, precio_lista, precio_cobrado,
                             profesional_id, comision_tipo, comision_valor, comision_monto,
                             tercero_monto, costo_insumo)
    VALUES (v_venta, v_tipo, v_desc, v_trat.id, v_promo, v_prod.id, v_pack.id, v_cant,
            v_lista, v_cobrado, v_prof.id, v_com_tipo, v_com_valor, v_com_monto,
            v_tercero, v_costo)
    RETURNING id INTO v_item;

    -- ---- efectos del ítem
    IF v_tipo = 'depilacion' THEN
      INSERT INTO item_zonas (venta_item_id, zona_id, precio_zona)
      SELECT v_item, z.id, z.precio FROM zonas_depilacion z WHERE z.id = ANY (v_zonas);

    ELSIF v_tipo = 'pack_venta' THEN
      INSERT INTO packs (paciente_ref, nombre, sesiones_totales, precio_pagado, venta_id,
                         fecha_venta, tratamiento_id)
      VALUES (p->>'paciente_ref', v_trat.nombre, v_trat.pack_sesiones, v_cobrado, v_venta,
              v_fecha, v_trat.id)
      RETURNING id INTO v_num;
      INSERT INTO pack_sesiones (pack_id, numero)
      SELECT v_num, g FROM generate_series(1, v_trat.pack_sesiones) g;
      UPDATE venta_items SET pack_id = v_num WHERE id = v_item;

    ELSIF v_tipo = 'pack_sesion' THEN
      UPDATE pack_sesiones SET consumida_en = v_fecha, profesional_id = v_prof.id,
                               venta_item_id = v_item
      WHERE id = v_sesion;
      IF NOT EXISTS (SELECT 1 FROM pack_sesiones WHERE pack_id = v_pack.id AND consumida_en IS NULL) THEN
        UPDATE packs SET estado = 'agotado' WHERE id = v_pack.id;
      END IF;
    END IF;
  END LOOP;

  IF v_estado = 'cobrada' THEN
    v_medio := fn_registrar_pagos(v_venta, p->'pagos');
    UPDATE ventas SET estado = 'cobrada', medio_pago = v_medio, cobrado_en = now() WHERE id = v_venta;
  END IF;

  RETURN jsonb_build_object('venta_id', v_venta, 'ya_existia', false);
END $$;

-- Pendiente -> cobrada. Repetirlo no hace nada.
DROP FUNCTION IF EXISTS cobrar_venta(int, text);
CREATE OR REPLACE FUNCTION cobrar_venta(p_venta int, p_pagos jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_usuario text := app_nombre(); v_estado estado_venta; v_medio text;
BEGIN
  IF v_usuario IS NULL THEN RAISE EXCEPTION 'Usuario no habilitado'; END IF;
  PERFORM set_config('app.usuario', v_usuario, true);
  SELECT estado INTO v_estado FROM ventas WHERE id = p_venta FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % inexistente', p_venta; END IF;
  IF v_estado = 'cobrada' THEN RETURN; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'La venta % está anulada', p_venta; END IF;
  v_medio := fn_registrar_pagos(p_venta, p_pagos);
  UPDATE ventas SET estado = 'cobrada', medio_pago = v_medio, cobrado_en = now() WHERE id = p_venta;
END $$;

-- Anular es un estado, no un DELETE. Cualquier usuario puede.
-- Devuelve las sesiones de pack que la venta había consumido.
CREATE OR REPLACE FUNCTION anular_venta(p_venta int, p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_usuario text := app_nombre(); v_estado estado_venta;
BEGIN
  IF v_usuario IS NULL THEN RAISE EXCEPTION 'Usuario no habilitado'; END IF;
  IF coalesce(trim(p_motivo), '') = '' THEN RAISE EXCEPTION 'Falta el motivo de la anulación'; END IF;
  PERFORM set_config('app.usuario', v_usuario, true);
  SELECT estado INTO v_estado FROM ventas WHERE id = p_venta FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % inexistente', p_venta; END IF;
  IF v_estado = 'anulada' THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM venta_items i JOIN liquidacion_items li ON li.venta_item_id = i.id
             WHERE i.venta_id = p_venta) THEN
    RAISE EXCEPTION 'La venta % ya entró en una liquidación: se corrige con un ajuste', p_venta;
  END IF;
  IF EXISTS (SELECT 1 FROM packs pk JOIN pack_sesiones s ON s.pack_id = pk.id
             WHERE pk.venta_id = p_venta AND s.consumida_en IS NOT NULL) THEN
    RAISE EXCEPTION 'El pack de la venta % ya tiene sesiones usadas: anular esas sesiones primero', p_venta;
  END IF;

  UPDATE packs SET estado = 'anulado' WHERE venta_id = p_venta;
  UPDATE pack_sesiones s SET consumida_en = NULL, profesional_id = NULL, venta_item_id = NULL
  FROM venta_items i WHERE i.venta_id = p_venta AND s.venta_item_id = i.id;
  UPDATE packs SET estado = 'activo'
  WHERE estado = 'agotado'
    AND id IN (SELECT pack_id FROM venta_items WHERE venta_id = p_venta AND tipo = 'pack_sesion');

  UPDATE ventas
     SET estado = 'anulada',
         nota = concat_ws(' | ', nota, 'ANULADA por ' || v_usuario || ': ' || trim(p_motivo))
   WHERE id = p_venta;
END $$;

-- Ítems cobrados a un profesional sin regla de comisión. Franco los
-- resuelve cargando la regla; hasta entonces no hay número inventado.
CREATE OR REPLACE VIEW v_items_sin_regla AS
SELECT v.id AS venta_id, v.fecha, i.id AS item_id, i.descripcion, p.nombre AS profesional
FROM venta_items i
JOIN ventas v ON v.id = i.venta_id
JOIN profesionales p ON p.id = i.profesional_id
LEFT JOIN tratamientos t ON t.id = i.tratamiento_id
WHERE v.estado <> 'anulada'
  AND i.tipo IN ('tratamiento', 'depilacion', 'pack_sesion')
  AND coalesce(t.categoria, '') <> 'cabina'
  AND i.comision_tipo IS NULL;

-- ---------------------------------------------------------------------
-- 7. RLS
-- Lectura: cualquier usuario dado de alta en `usuarios`.
-- Catálogo, precios y liquidaciones: solo admin.
-- Ventas, ítems, packs y pacientes: solo por las funciones de arriba.
-- Ningún DELETE para nadie.
-- ---------------------------------------------------------------------
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pacientes','profesionales','tratamientos','precios_tratamiento','reglas_comision',
    'zonas_depilacion','promos_depilacion','promo_zonas','escala_depilacion','config',
    'productos','compras','compra_items','packs','pack_sesiones','ventas','venta_items',
    'item_zonas','venta_pagos','gastos','liquidaciones','liquidacion_items','auditoria','usuarios']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('DROP POLICY IF EXISTS leer ON %I', t);
    EXECUTE format('CREATE POLICY leer ON %I FOR SELECT TO authenticated USING (app_rol() IS NOT NULL)', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'profesionales','tratamientos','precios_tratamiento','reglas_comision',
    'zonas_depilacion','promos_depilacion','promo_zonas','escala_depilacion','config',
    'productos','compras','compra_items','liquidaciones','liquidacion_items']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_alta ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS admin_cambio ON %I', t);
    EXECUTE format($f$CREATE POLICY admin_alta ON %I FOR INSERT TO authenticated
                     WITH CHECK (app_rol() = 'admin')$f$, t);
    EXECUTE format($f$CREATE POLICY admin_cambio ON %I FOR UPDATE TO authenticated
                     USING (app_rol() = 'admin') WITH CHECK (app_rol() = 'admin')$f$, t);
  END LOOP;
END $rls$;

-- Gastos: cualquiera los carga, solo Franco los corrige.
DROP POLICY IF EXISTS alta ON gastos;
CREATE POLICY alta ON gastos FOR INSERT TO authenticated WITH CHECK (app_rol() IS NOT NULL);
DROP POLICY IF EXISTS admin_cambio ON gastos;
CREATE POLICY admin_cambio ON gastos FOR UPDATE TO authenticated
  USING (app_rol() = 'admin') WITH CHECK (app_rol() = 'admin');

-- Las vistas corrían con los permisos del dueño y se saltaban RLS:
-- v_sin_comision se leía con la clave pública. Ahora respetan RLS.
ALTER VIEW v_sin_comision          SET (security_invoker = true);
ALTER VIEW v_a_pagar_terceros      SET (security_invoker = true);
ALTER VIEW v_ingreso_neto          SET (security_invoker = true);
ALTER VIEW v_comisiones_pendientes SET (security_invoker = true);
ALTER VIEW v_packs_activos         SET (security_invoker = true);
ALTER VIEW v_items_sin_regla       SET (security_invoker = true);
REVOKE ALL ON v_sin_comision, v_a_pagar_terceros, v_ingreso_neto,
              v_comisiones_pendientes, v_packs_activos, v_items_sin_regla FROM anon;

-- Funciones: solo usuarios con sesión.
REVOKE EXECUTE ON FUNCTION registrar_venta(jsonb), cobrar_venta(int, jsonb),
                           anular_venta(int, text), sincronizar_pacientes(jsonb),
                           app_rol(), app_nombre()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_venta(jsonb), cobrar_venta(int, jsonb),
                          anular_venta(int, text), sincronizar_pacientes(jsonb),
                          app_rol(), app_nombre()
  TO authenticated;

-- Solo se usa desde adentro de registrar_venta y cobrar_venta.
REVOKE EXECUTE ON FUNCTION fn_registrar_pagos(int, jsonb) FROM PUBLIC, anon, authenticated;

COMMIT;
