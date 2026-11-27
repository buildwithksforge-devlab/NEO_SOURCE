BEGIN;

DO $migration$
DECLARE

    d text;

    option_anchor text :=
        'AND o.active IS TRUE AND g.active IS TRUE';

    group_anchor text :=
        'AND g.active IS TRUE FOR SHARE OF g,m LOOP';

BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_selection_modifiers()'
        ::regprocedure
    );

    IF position(option_anchor IN d) = 0

       OR position(group_anchor IN d) = 0

    THEN

        RAISE EXCEPTION
            'Modifier validation baseline differs';

    END IF;

    d := replace(

        d,

        option_anchor,

$patch$

    AND o.active IS TRUE
    AND g.active IS TRUE

    AND public.neo_record_operationally_enabled(
        to_jsonb(o)
    ) IS TRUE

    AND public.neo_record_operationally_enabled(
        to_jsonb(g)
    ) IS TRUE

$patch$

    );

    d := replace(

        d,

        group_anchor,

$patch$

      AND g.active IS TRUE

      AND public.neo_record_operationally_enabled(
          to_jsonb(g)
      ) IS TRUE

      FOR SHARE OF g,m LOOP

$patch$

    );

    EXECUTE d;

END;
$migration$;

COMMIT;