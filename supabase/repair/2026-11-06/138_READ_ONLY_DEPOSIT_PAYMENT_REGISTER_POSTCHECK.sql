BEGIN READ ONLY;
SELECT jsonb_build_object('diagnostic_version','deposit-payment-register-install-v1','read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_payment_register(uuid,date,date,text,integer)')))='e256478061449b9e1247073a8a46c444',false),
 'deposit_recorder_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)')))='26c7a1f6b03036933bc4bab3d585c5e2',false),
 'folio_payment_recorder_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)')))='5d84717f3b671041607d9105f0988744',false),
 'checkin_unchanged',coalesce(md5(pg_get_functiondef(to_regprocedure('public.pms_check_in(uuid,integer,text)')))='e1b9f2a87464b3389ac5a146bdd7b459',false),
 'scope','Read-only register projection code only. Deposits appear without creating or backfilling payment rows; linked collections are deduplicated. Does not certify deposit verification, journal backing or the separate reservation-balance rules. No money, status or historical financial records are changed.') AS diagnostic;
COMMIT;
