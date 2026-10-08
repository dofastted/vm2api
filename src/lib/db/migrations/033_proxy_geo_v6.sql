-- 033_proxy_geo_v6 — IPv6 egress geolocation for each proxy row.
--
-- Written by the IPv6 geo detection pass (lookup through the proxy itself).
-- `geo_v6_error` keeps the last failure so a stale-but-known location is
-- distinguishable from a never-resolved one.

ALTER TABLE proxies ADD COLUMN geo_v6_ip TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_country TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_country_code TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_region TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_city TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_isp TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_timezone TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_checked_at TEXT;
ALTER TABLE proxies ADD COLUMN geo_v6_error TEXT;
