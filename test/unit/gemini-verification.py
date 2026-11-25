"""Synthetic OAuth observations; no credentials, providers or host services."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("verification_account", ROOT / "scripts/gemini_host_account.py")
account = importlib.util.module_from_spec(spec)
spec.loader.exec_module(account)
URL = "https://accounts.google.com/example-verification?fixture=synthetic"


class VerificationLinkTests(unittest.TestCase):
    def probe(self, tiers, entries):
        calls = []

        def response(proxy, url, header=None, body=None, **kwargs):
            calls.append(url)
            if url.endswith("/userinfo"):
                return 200, {"email": "synthetic@example.test"}
            if url.endswith("loadCodeAssist"):
                return 200, {**tiers, "ineligibleTiers": entries}
            if url.endswith("fetchAvailableModels"):
                return 200, {"models": {"gemini-fixture": {}}}
            raise AssertionError(f"Unexpected transport: {url}")

        with patch.object(account, "get_json", side_effect=response):
            result = account.probe_oauth_token("socks5h://192.0.2.1:1080", {
                "token": {"access_token": "synthetic-not-a-secret", "expiry": "2099-01-01T00:00:00Z"}
            })
        self.assertFalse(any(url.endswith("onboardUser") for url in calls))
        self.assertEqual(result["state"], "ok")
        return result

    def test_paid_and_current_tiers_keep_link_without_blocking_eligibility(self):
        for tiers in ({"paidTier": {"id": "paid"}}, {"currentTier": {"id": "current"}},
                      {"paidTier": {"id": "paid"}, "currentTier": {"id": "current"}}):
            with self.subTest(tiers=tiers):
                entries = [{"reasonCode": "VALIDATION_REQUIRED", "tierId": "alternative", "validationUrl": URL}]
                result = self.probe(tiers, entries)
                self.assertEqual(result.get("validation_url"), URL)
                self.assertNotIn("eligibility", result)
                self.assertEqual(account.parse_ineligibility({**tiers, "ineligibleTiers": entries}), (None, None))

    def test_no_tier_keeps_existing_blocking_semantics(self):
        result = self.probe({}, [{"reasonCode": "VALIDATION_REQUIRED", "validationUrl": URL}])
        self.assertEqual(result["eligibility"], "verification_required")
        self.assertEqual(result["validation_url"], URL)

    def test_rejects_untrusted_or_unrelated_links(self):
        invalid = [None, "", "http://accounts.google.com/check", "https://accounts.google.com.evil.test/check",
                   "https://evil.test/check", "https://user@accounts.google.com/check", "javascript:alert(1)"]
        for url in invalid:
            with self.subTest(url=url):
                result = self.probe({"paidTier": {"id": "paid"}}, [
                    {"reasonCode": "VALIDATION_REQUIRED", "validationUrl": url}])
                self.assertNotIn("validation_url", result)
                self.assertNotIn("eligibility", result)
        result = self.probe({"currentTier": {"id": "current"}}, [
            {"reasonCode": "UNSUPPORTED_REGION", "validationUrl": URL}])
        self.assertNotIn("validation_url", result)
        self.assertNotIn("eligibility", result)

    def test_skips_bad_entry_to_keep_later_safe_verification_link(self):
        result = self.probe({"paidTier": {"id": "paid"}}, [None,
            {"reasonCode": "VALIDATION_REQUIRED", "validationUrl": "https://evil.test"},
            {"reasonCode": "VALIDATION_REQUIRED", "validationUrl": URL}])
        self.assertEqual(result.get("validation_url"), URL)
        self.assertNotIn("eligibility", result)


if __name__ == "__main__":
    unittest.main()
