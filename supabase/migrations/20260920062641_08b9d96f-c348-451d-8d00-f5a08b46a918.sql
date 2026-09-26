UPDATE public.integration_providers
   SET purpose = coalesce(purpose, 'Collect mobile-money payments from Kenyan customers and confirm them automatically against the bill.'),
       documentation_url = coalesce(documentation_url, 'https://developer.safaricom.co.ke/'),
       supports_webhooks = true,
       supports_sandbox = true,
       capabilities = ARRAY[
         'Customer-initiated payment (STK push)',
         'Payment confirmation callback',
         'Transaction status query',
         'Reversal (subject to Safaricom approval)',
         'Sandbox testing'
       ]::text[],
       connection_requirements = jsonb_build_array(
         jsonb_build_object('key','DARAJA_CONSUMER_KEY','label','Consumer key','type','secret','required',true,'where','Safaricom developer portal — your app credentials'),
         jsonb_build_object('key','DARAJA_CONSUMER_SECRET','label','Consumer secret','type','secret','required',true,'where','Safaricom developer portal — your app credentials'),
         jsonb_build_object('key','DARAJA_SHORTCODE','label','Business short code (paybill or till)','type','text','required',true,'where','Your Safaricom business account'),
         jsonb_build_object('key','DARAJA_PASSKEY','label','Online passkey','type','secret','required',true,'where','Issued by Safaricom when the short code is enabled for online payments'),
         jsonb_build_object('key','environment','label','Environment','type','choice','required',true,'options',jsonb_build_array('sandbox','production')),
         jsonb_build_object('key','callback_url','label','Payment result address','type','url','required',true,'where','Provided by NEØ for this hotel; must be registered with Safaricom')),
       declaration_status = 'declared',
       declared_at = coalesce(declared_at, now()),
       updated_at = now()
 WHERE code = 'daraja';