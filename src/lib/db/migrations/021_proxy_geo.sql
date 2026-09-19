-- 021_proxy_geo — exit-node geolocation for each proxy row.
--
-- Written by the geo detection pass (lookup through the proxy itself), read by
-- the panel and by the "slot follows its proxy timezone" default. `geo_error`
-- keeps the last failure so a stale-but-known location is distinguishable from
-- a never-resolved one.

ALTER TABLE proxies ADD COLUMN geo_ip TEXT;
ALTER TABLE proxies ADD COLUMN geo_country TEXT;
ALTER TABLE proxies ADD COLUMN geo_country_code TEXT;
ALTER TABLE proxies ADD COLUMN geo_region TEXT;
ALTER TABLE proxies ADD COLUMN geo_city TEXT;
ALTER TABLE proxies ADD COLUMN geo_isp TEXT;
ALTER TABLE proxies ADD COLUMN geo_timezone TEXT;
ALTER TABLE proxies ADD COLUMN geo_checked_at TEXT;
ALTER TABLE proxies ADD COLUMN geo_error TEXT;
