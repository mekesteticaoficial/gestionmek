-- =====================================================================
-- MEK Estética — 03: ALTA DE USUARIOS
--
-- Los tres usuarios ya existen en Supabase Auth. Esto les da permiso
-- para usar la app. Sin una fila acá, un usuario puede iniciar sesión
-- pero no ve ni carga nada.
--
-- Cada persona entra SIEMPRE con su cuenta: la de Yael precarga
-- "lo hizo Yael" en cada cobro y así se calcula su comisión.
-- Para cambiar quién es quién, cambiar el mail acá y volver a correr.
-- Si algún mail no coincide con un usuario de Auth, se detiene.
-- =====================================================================

DO $alta$
DECLARE
  u record;
  v_id uuid;
BEGIN
  FOR u IN SELECT * FROM (VALUES
      ('franmattiuzzi82@gmail.com',  'Franco', 'admin', NULL),
      ('franmattiu@gmail.com',       'Silvia', 'carga', 'Silvia Orsi'),
      ('francomattiuzzi1@gmail.com', 'Yael',   'carga', 'Yael Juárez')
    ) AS t(email, nombre, rol, profesional)
  LOOP
    SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(u.email);
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'No hay ningún usuario de Auth con el mail "%"', u.email;
    END IF;

    INSERT INTO usuarios (user_id, nombre, rol, profesional_id)
    VALUES (v_id, u.nombre, u.rol,
            (SELECT id FROM profesionales WHERE nombre = u.profesional))
    ON CONFLICT (user_id) DO UPDATE
      SET nombre = EXCLUDED.nombre, rol = EXCLUDED.rol,
          profesional_id = EXCLUDED.profesional_id;
  END LOOP;
END $alta$;

SELECT u.nombre, u.rol, a.email, p.nombre AS profesional
FROM usuarios u JOIN auth.users a ON a.id = u.user_id
LEFT JOIN profesionales p ON p.id = u.profesional_id;
