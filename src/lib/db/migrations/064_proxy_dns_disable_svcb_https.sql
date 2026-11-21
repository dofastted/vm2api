-- 064_proxy_dns_disable_svcb_https — move the SVCB/HTTPS DNS override per proxy.
--
-- The switch used to live only in `settings.proxy_pool_config`, so one node's
-- exit policy applied to every outlet in the pool. kin-egress takes it per
-- helper (`dns_empty_types` in egress.json), and a per-VM helper serves exactly
-- one proxy, so the switch belongs on the proxy row.
--
-- Default 0 is the pool default, but an existing install may have the pool-level
-- switch on: the UPDATE carries that value onto every row so the upgrade changes
-- nothing an operator can observe. The pool-level key stays as the initial value
-- for newly added proxies; it is no longer read at helper start.

ALTER TABLE proxies ADD COLUMN dns_disable_svcb_https INTEGER NOT NULL DEFAULT 0;

UPDATE proxies
SET dns_disable_svcb_https = 1
WHERE EXISTS (
  SELECT 1
  FROM settings
  WHERE key = 'proxy_pool_config'
    AND json_extract(value, '$.dns_disable_svcb_https') = 1
);
