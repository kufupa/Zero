-- Run on EC2 via ssm-run-command.sh with psql; output one JSON per line to /tmp/s5-rates/messages.jsonl.
BEGIN READ ONLY;
SELECT json_build_object(
 'id',m.id,'mid',COALESCE(NULLIF(trim(m.message_id_header),''),'row:'||m.id),
 'transport',m.transport_id,'sent',COALESCE(m.sent_at,m.received_at,m.created_at)::text,
 'from',COALESCE(m.from_address,''),'to',COALESCE(m.to_addresses,'[]'::jsonb),
 'body',COALESCE(NULLIF(m.text_body,''),regexp_replace(COALESCE(m.html_body,''),'<[^>]+>',' ','g'),''),
 'inbound',(SELECT json_build_object('at',COALESCE(i.received_at,i.sent_at,i.created_at)::text,'from',COALESCE(i.from_address,''),'body',COALESCE(NULLIF(i.text_body,''),regexp_replace(COALESCE(i.html_body,''),'<[^>]+>',' ','g'),'')) FROM message i WHERE i.transport_id=m.transport_id AND i.thread_id=m.thread_id AND i.direction::text='inbound' AND COALESCE(i.received_at,i.sent_at,i.created_at)<=COALESCE(m.sent_at,m.received_at,m.created_at) ORDER BY COALESCE(i.received_at,i.sent_at,i.created_at) DESC LIMIT 1),
 'docs',(SELECT COALESCE(json_agg(json_build_object('id',a.id,'name',a.filename,'mime',a.mime_type,'size',a.size_bytes,'key',a.s3_key,'sha',a.sha256)),'[]'::json) FROM attachment a WHERE a.message_id=m.id AND (lower(a.mime_type) IN ('application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel') OR right(lower(a.filename),4) IN ('.pdf','.xls') OR right(lower(a.filename),5) IN ('.xlsx','.xlsm')))
)::text
FROM message m
WHERE m.transport_id IN ('transport-centurion','transport-davinci','transport-faith','transport-ayanda','transport-epick','transport-kmgidi') AND m.direction::text='outbound' AND COALESCE(m.sent_at,m.received_at,m.created_at)>=now()-interval '30 days'
ORDER BY COALESCE(m.sent_at,m.received_at,m.created_at),m.id;
ROLLBACK;
