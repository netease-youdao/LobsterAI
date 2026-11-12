-- PPT entry research, 2026-11-11. Read-only statements only.
-- Execute through the bhumi-data dispatcher with the authorized production reader configuration.
-- Connection details and credentials are intentionally absent.
-- Session timezone verified as +08:00. Results contain summaries capped at 200 characters.

-- db-context
SELECT VERSION() AS version, @@session.time_zone AS session_timezone, @@global.time_zone AS global_timezone, NOW() AS database_now, UTC_TIMESTAMP() AS utc_now;

-- schema
SELECT table_name, column_name, column_type, column_key FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('api_call_logs','tob_enterprise_usage_records','users','usage_session_metadata') ORDER BY table_name, ordinal_position;

-- indexes
SELECT table_name,index_name,seq_in_index,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('api_call_logs','tob_enterprise_usage_records','users') ORDER BY table_name,index_name,seq_in_index;

-- table-volumes
SELECT table_name,table_rows FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('api_call_logs','tob_enterprise_usage_records','users','usage_session_metadata');

-- user-types
SELECT user_type,status,COUNT(*) AS accounts FROM users GROUP BY user_type,status;

-- personal-plan
EXPLAIN SELECT a.user_id, a.session_id, a.turn_id, a.user_message, a.created_at FROM api_call_logs a FORCE INDEX(idx_created_at) WHERE a.created_at >= '2026-10-12' AND a.created_at < '2026-11-11' AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?';

-- enterprise-plan
EXPLAIN SELECT a.user_id, a.session_id, a.user_message, a.created_at FROM tob_enterprise_usage_records a WHERE a.created_at >= '2026-10-12' AND a.created_at < '2026-11-11' AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?';

-- personal-2026-11-10
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-10' AND a.created_at < '2026-11-11'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- personal-2026-11-09
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-09' AND a.created_at < '2026-11-10'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- personal-2026-11-08
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-08' AND a.created_at < '2026-11-09'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- personal-2026-11-07
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-07' AND a.created_at < '2026-11-08'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- personal-2026-11-06
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-06' AND a.created_at < '2026-11-07'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- personal-2026-11-05
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-05' AND a.created_at < '2026-11-06'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- personal-2026-11-04
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls,
COUNT(DISTINCT NULLIF(a.turn_id,'')) AS known_turns
FROM api_call_logs a FORCE INDEX(idx_created_at) JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-04' AND a.created_at < '2026-11-05'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;

-- enterprise-candidates
SELECT /*+ MAX_EXECUTION_TIME(60000) */
SHA2(CONCAT('ppt-home-20261111:',a.user_id),256) AS account_key,
CASE WHEN COALESCE(a.session_id,'')='' THEN NULL ELSE SHA2(CONCAT('ppt-home-20261111:',a.user_id,':',a.session_id),256) END AS session_key,
a.user_message AS message, MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at,
COUNT(*) AS calls, SUM(a.status='success') AS successful_calls
FROM tob_enterprise_usage_records a JOIN users u ON u.id=a.user_id
WHERE a.created_at >= '2026-11-04' AND a.created_at < '2026-11-11'
AND u.status=1 AND u.user_type='consumer'
AND (a.usage_type IS NULL OR a.usage_type='chat')
AND LOWER(a.user_message) REGEXP 'ppt|powerpoint|幻灯片|演示文稿|课件|slides?'
GROUP BY a.user_id,a.session_id,a.user_message ORDER BY MIN(a.created_at),a.user_id LIMIT 5000;
