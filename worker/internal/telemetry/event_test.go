package telemetry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestInitEventUsesOfficial1PEnvelope(t *testing.T) {
	ev := InitEvent(Identity{
		DeviceID:           "dev-hash",
		AccountUUID:        "acc",
		OrgUUID:            "org",
		Email:              "slot@example.com",
		SessionID:          "sess",
		Platform:           "linux",
		PlatformRaw:        "linux",
		Arch:               "x64",
		NodeVersion:        "v24.3.0",
		Locale:             "en_US.UTF-8",
		Timezone:           "America/Los_Angeles",
		CLIVersion:         "2.1.233",
		Entrypoint:         "cli",
		LinuxDistroID:      "ubuntu",
		LinuxDistroVersion: "24.04",
		LinuxKernel:        "6.8.0-generic",
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))

	if ev.EventType != eventTypeInternal {
		t.Fatalf("event_type=%q", ev.EventType)
	}
	if ev.EventData["event_name"] != eventTenguInit {
		t.Fatalf("event_name=%v", ev.EventData["event_name"])
	}
	raw, err := json.Marshal(BatchRequest{Events: []Event{ev}})
	if err != nil {
		t.Fatal(err)
	}
	if ContainsForbidden(raw) {
		t.Fatalf("forbidden field leaked: %s", raw)
	}
	for _, must := range []string{
		`"event_type":"ClaudeCodeInternalEvent"`,
		`"event_name":"tengu_init"`,
		`"device_id":"dev-hash"`,
		`"account_uuid":"acc"`,
		`"organization_uuid":"org"`,
		`"email":"slot@example.com"`,
		`"session_id":"sess"`,
		`"client_timestamp":"2026-08-23T01:00:00.000Z"`,
		`"platform":"linux"`,
		`"platform_raw":"linux"`,
		`"arch":"x64"`,
		`"node_version":"v24.3.0"`,
		`"linux_distro_id":"ubuntu"`,
		`"linux_distro_version":"24.04"`,
		`"linux_kernel":"6.8.0-generic"`,
		`"entrypoint":"cli"`,
		`"user_type":"external"`,
		`"client_type":"cli"`,
	} {
		if !strings.Contains(string(raw), must) {
			t.Fatalf("missing %s in %s", must, raw)
		}
	}
	if strings.Contains(string(raw), `"properties"`) {
		t.Fatalf("legacy properties envelope leaked: %s", raw)
	}
	for _, drop := range []string{"hostname", "kernel_release", "os_pretty", "\"os_id\"", "runtime_kind"} {
		if strings.Contains(string(raw), drop) {
			t.Fatalf("did not expect %q in %s", drop, raw)
		}
	}
}

func TestSuccessEventMatchesBridgeEnvelope(t *testing.T) {
	ev := SuccessEvent(Identity{
		DeviceID:    "dev-hash",
		AccountUUID: "acc",
		CLIVersion:  "2.1.241",
		Platform:    "linux",
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC), 12, "claude-sonnet-5")
	if ev.EventData["event_name"] != eventTenguSuccess {
		t.Fatalf("event_name=%v", ev.EventData["event_name"])
	}
	if ev.EventData["process"] == nil {
		t.Fatal("process missing")
	}
	raw, _ := json.Marshal(ev)
	if ContainsForbidden(raw) {
		t.Fatalf("forbidden: %s", raw)
	}
	if !strings.Contains(string(raw), `"linux_kernel"`) {
		t.Fatalf("full env missing linux_kernel: %s", raw)
	}
}

func TestGrowthbookPrefersOfficialUserID(t *testing.T) {
	body := GrowthbookEval(Identity{
		DeviceID:         "machine",
		UserID:           "userid",
		AccountUUID:      "acc",
		SubscriptionType: "apple_subscription",
		CLIVersion:       "2.1.241",
	})
	attrs := body["attributes"].(map[string]any)
	if attrs["id"] != "userid" || attrs["deviceID"] != "userid" {
		t.Fatalf("attrs=%v", attrs)
	}
	if attrs["subscriptionType"] != "apple_subscription" {
		t.Fatalf("subscription=%v", attrs["subscriptionType"])
	}
}

func TestInitEventOmitsEmptyOptionalFields(t *testing.T) {
	ev := InitEvent(Identity{Platform: "linux"}, time.Unix(0, 0).UTC())
	if _, ok := ev.EventData["email"]; ok {
		t.Fatal("empty email must be omitted")
	}
	if _, ok := ev.EventData["auth"]; ok {
		t.Fatal("empty auth must be omitted")
	}
	env, _ := ev.EventData["env"].(map[string]any)
	if env["is_ci"] != false {
		t.Fatalf("is_ci=%v", env["is_ci"])
	}
}

func TestEventUsesConfiguredEnvAnd278Betas(t *testing.T) {
	ev := InitEvent(Identity{
		DeviceID: "d",
		Betas:    "thinking-binding-controls-2026-08-01",
		Env:      map[string]any{"platform": "linux", "version": "2.1.278", "linux_kernel": "from-env"},
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, must := range []string{`"linux_kernel":"from-env"`, `"version":"2.1.278"`, "thinking-binding-controls-2026-08-01"} {
		if !strings.Contains(body, must) {
			t.Fatalf("missing %s in %s", must, body)
		}
	}
	if strings.Contains(body, "2.1.241") || strings.Contains(body, "advanced-tool-use-2025-11-20") {
		t.Fatalf("stale protocol marker in %s", body)
	}
	fallback := InitEvent(Identity{}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))
	raw, _ = json.Marshal(fallback)
	body = string(raw)
	if !strings.Contains(body, "thinking-binding-controls-2026-08-01") || !strings.Contains(body, `"version":"2.1.284"`) {
		t.Fatalf("fallback=%s", body)
	}
	if !strings.Contains(body, "advanced-tool-use-2025-11-20") || !strings.Contains(body, "mid-conversation-system-clear-at-2026-08-21") {
		t.Fatalf("fallback betas=%s", body)
	}
	attrs := GrowthbookEval(Identity{UserID: "u"})["attributes"].(map[string]any)
	if attrs["appVersion"] != "2.1.284" {
		t.Fatalf("appVersion=%v", attrs["appVersion"])
	}
}
