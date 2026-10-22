package telemetry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestInitEventUsesOfficial1PEnvelope(t *testing.T) {
	ev := InitEvent(Identity{
		DeviceID:           strings.Repeat("ab", 32),
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
		`"device_id":"` + strings.Repeat("ab", 32) + `"`,
		`"account_uuid":"acc"`,
		`"organization_uuid":"org"`,
		`"email":"slot@example.com"`,
		`"session_id":"sess"`,
		`"client_timestamp":"2026-08-23T01:00:00.000Z"`,
		`"platform":"linux"`,
		`"platform_raw":"linux"`,
		`"arch":"x64"`,
		`"shell":"bash"`,
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
	for _, drop := range []string{`"node_version"`, `"is_running_with_bun"`, `"betas"`, `"additional_metadata"`, `"model"`} {
		if strings.Contains(string(raw), drop) {
			t.Fatalf("did not expect %s in %s", drop, raw)
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
	if strings.Contains(string(raw), `"model"`) || strings.Contains(string(raw), "claude-sonnet-5") {
		t.Fatalf("model must not be uploaded: %s", raw)
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
	if attrs["userType"] != "external" || attrs["entrypoint"] != "cli" {
		t.Fatalf("attrs=%v", attrs)
	}
	if _, ok := body["forcedFeatures"].([]any); !ok {
		t.Fatalf("forcedFeatures=%T", body["forcedFeatures"])
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

func TestEventUsesConfiguredEnvAndOmitsBetas(t *testing.T) {
	ev := InitEvent(Identity{
		DeviceID: "d",
		Betas:    "thinking-binding-controls-2026-08-01",
		Env:      map[string]any{"platform": "linux", "version": "2.1.278", "linux_kernel": "from-env", "node_version": "v1", "is_running_with_bun": true},
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, must := range []string{`"linux_kernel":"from-env"`, `"version":"2.1.278"`, `"shell":"bash"`, `"vcs":"git"`, `"runtimes":"node"`} {
		if !strings.Contains(body, must) {
			t.Fatalf("missing %s in %s", must, body)
		}
	}
	for _, drop := range []string{"thinking-binding-controls-2026-08-01", `"node_version"`, `"is_running_with_bun"`, "2.1.241"} {
		if strings.Contains(body, drop) {
			t.Fatalf("unexpected %s in %s", drop, body)
		}
	}
	fallback := InitEvent(Identity{}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))
	raw, _ = json.Marshal(fallback)
	body = string(raw)
	if strings.Contains(body, "thinking-binding-controls") || strings.Contains(body, "advanced-tool-use") {
		t.Fatalf("fallback uploaded betas: %s", body)
	}
	if !strings.Contains(body, `"version":"2.1.293"`) || !strings.Contains(body, `"shell":"bash"`) {
		t.Fatalf("fallback=%s", body)
	}
	attrs := GrowthbookEval(Identity{UserID: "u"})["attributes"].(map[string]any)
	if attrs["appVersion"] != "2.1.293" {
		t.Fatalf("appVersion=%v", attrs["appVersion"])
	}
}

func TestSanitizeEnvDropsGuestHardwareAndSecrets(t *testing.T) {
	ev := InitEvent(Identity{
		Env: map[string]any{
			"platform":         "linux",
			"shell":            "zsh",
			"cpu_model":        "Intel(R) Xeon(R) CPU",
			"cpu_cores":        float64(4),
			"memory_bytes":     float64(4294967296),
			"root_disk":        "/dev/vda2",
			"mac":              "52:54:00:11:22:33",
			"dmi_manufacturer": "Dell Inc.",
			"dmi_product":      "OptiPlex 7090",
			"dmi_version":      "1.0",
			"dmi_family":       "OptiPlex",
			"dmi_serial":       "ABC123",
			"dmi_uuid":         "11111111-2222-3333-4444-555555555555",
			"node_version":     "v1",
			"authorization":    "secret",
			"hostname":         "guest-01",
			"machine_id":       "should-drop",
		},
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))
	env, _ := ev.EventData["env"].(map[string]any)
	if env["platform"] != "linux" || env["shell"] != "zsh" {
		t.Fatalf("official keys lost: %v", env)
	}
	for _, drop := range append([]string{"node_version", "authorization", "hostname", "machine_id"}, guestHardwareKeys...) {
		if _, ok := env[drop]; ok {
			t.Fatalf("leaked %s in %v", drop, env)
		}
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	if ContainsForbidden(raw) {
		t.Fatalf("forbidden field leaked: %s", raw)
	}
}

func TestEnvBlockFallbackHasNoGuestHardware(t *testing.T) {
	ev := InitEvent(Identity{Platform: "linux"}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))
	env, _ := ev.EventData["env"].(map[string]any)
	for _, key := range guestHardwareKeys {
		if _, ok := env[key]; ok {
			t.Fatalf("fallback env has %s: %v", key, env)
		}
	}
}

var guestHardwareKeys = []string{
	"cpu_model", "cpu_cores", "memory_bytes", "root_disk", "mac",
	"dmi_manufacturer", "dmi_product", "dmi_version", "dmi_family",
	"dmi_serial", "dmi_uuid",
}
