package telemetry

import (
	crand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
)

type Identity = config.TelemetryIdentity

type Event struct {
	EventType string         `json:"event_type"`
	EventData map[string]any `json:"event_data"`
}

type BatchRequest struct {
	Events []Event `json:"events"`
}

const (
	eventTenguInit     = "tengu_init"
	eventTenguSuccess  = "tengu_api_success"
	eventTypeInternal  = "ClaudeCodeInternalEvent"
	defaultUserType    = "external"
	defaultClientType  = "cli"
	defaultTerminal    = "unknown"
	defaultPlatform    = "linux"
	officialCLIVersion = "2.1.293"
)

func InitEvent(id Identity, now time.Time) Event {
	return namedEvent(id, eventTenguInit, now, 0, "")
}

func SuccessEvent(id Identity, now time.Time, uptimeSecs float64, model string) Event {
	return namedEvent(id, eventTenguSuccess, now, uptimeSecs, model)
}

func namedEvent(id Identity, name string, now time.Time, uptimeSecs float64, _ string) Event {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	entrypoint := strings.TrimSpace(id.Entrypoint)
	if entrypoint == "" {
		entrypoint = "cli"
	}
	data := map[string]any{
		"event_name":       name,
		"event_id":         newEventID(),
		"client_timestamp": now.UTC().Format("2006-01-02T15:04:05.000Z"),
		"entrypoint":       entrypoint,
		"is_interactive":   name != eventTenguInit,
		"client_type":      defaultClientType,
		"user_type":        defaultUserType,
	}
	put(data, "device_id", telemetryDevice(id))
	put(data, "session_id", id.SessionID)
	put(data, "email", id.Email)
	if auth := authBlock(id); len(auth) > 0 {
		data["auth"] = auth
	}
	data["env"] = envBlock(id)
	if name != eventTenguInit {
		data["process"] = encodeProcess(id.Process, uptimeSecs)
	}
	return Event{EventType: eventTypeInternal, EventData: data}
}

func GrowthbookEval(id Identity) map[string]any {
	device := telemetryDevice(id)
	if device == "" {
		device = strings.TrimSpace(id.UserID)
		if device == "" {
			device = strings.TrimSpace(id.DeviceID)
		}
	}
	session := strings.TrimSpace(id.SessionID)
	if session == "" {
		session = newEventID()
	}
	version := strings.TrimSpace(id.CLIVersion)
	if version == "" {
		version = officialCLIVersion
	}
	platform := strings.TrimSpace(id.Platform)
	if platform == "" {
		platform = defaultPlatform
	}
	entrypoint := strings.TrimSpace(id.Entrypoint)
	if entrypoint == "" {
		entrypoint = "cli"
	}
	attrs := map[string]any{
		"id":         device,
		"sessionId":  session,
		"deviceID":   device,
		"platform":   platform,
		"appVersion": version,
		"userType":   defaultUserType,
		"entrypoint": entrypoint,
	}
	put(attrs, "email", id.Email)
	put(attrs, "accountUUID", id.AccountUUID)
	put(attrs, "organizationUUID", id.OrgUUID)
	put(attrs, "subscriptionType", id.SubscriptionType)
	return map[string]any{
		"attributes":       attrs,
		"forcedVariations": map[string]any{},
		"forcedFeatures":   []any{},
		"url":              "",
	}
}

func authBlock(id Identity) map[string]any {
	out := map[string]any{}
	put(out, "account_uuid", id.AccountUUID)
	put(out, "organization_uuid", id.OrgUUID)
	return out
}

func envBlock(id Identity) map[string]any {
	if len(id.Env) > 0 {
		return sanitizeEnv(id.Env)
	}
	platform := strings.TrimSpace(id.Platform)
	if platform == "" {
		platform = defaultPlatform
	}
	raw := strings.TrimSpace(id.PlatformRaw)
	if raw == "" {
		raw = platform
	}
	version := strings.TrimSpace(id.CLIVersion)
	if version == "" {
		version = officialCLIVersion
	}
	terminal := strings.TrimSpace(id.Terminal)
	if terminal == "" {
		terminal = defaultTerminal
	}
	deploy := "unknown-linux"
	if platform != "linux" {
		deploy = "unknown-" + platform
	}
	vcs := strings.TrimSpace(id.VCS)
	if vcs == "" {
		vcs = "git"
	}
	runtimes := strings.TrimSpace(id.Runtimes)
	if runtimes == "" {
		runtimes = "node"
	}
	out := map[string]any{
		"platform":                          platform,
		"platform_raw":                      raw,
		"arch":                              strings.TrimSpace(id.Arch),
		"terminal":                          terminal,
		"shell":                             telemetryShell(id.Shell),
		"package_managers":                  strings.TrimSpace(id.PackageManagers),
		"runtimes":                          runtimes,
		"is_ci":                             false,
		"is_claubbit":                       false,
		"is_claude_code_remote":             false,
		"is_local_agent_mode":               false,
		"is_conductor":                      false,
		"is_github_action":                  false,
		"is_claude_code_action":             false,
		"is_claude_ai_auth":                 strings.TrimSpace(id.AccountUUID) != "",
		"version":                           version,
		"version_base":                      versionBase(version),
		"deployment_environment":            deploy,
		"vcs":                               vcs,
		"github_event_name":                 "",
		"github_actions_runner_environment": "",
		"github_actions_runner_os":          "",
		"github_action_ref":                 "",
		"wsl_version":                       "",
		"remote_environment_type":           "",
		"claude_code_container_id":          "",
		"claude_code_remote_session_id":     "",
		"tags":                              []any{},
		"coworker_type":                     "",
		"linux_distro_id":                   strings.TrimSpace(id.LinuxDistroID),
		"linux_distro_version":              strings.TrimSpace(id.LinuxDistroVersion),
		"linux_kernel":                      strings.TrimSpace(id.LinuxKernel),
	}
	if bt := strings.TrimSpace(id.BuildTime); bt != "" {
		out["build_time"] = bt
	}
	return out
}
func sanitizeEnv(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+3)
	for key, value := range in {
		if dropEnvKey(key) {
			continue
		}
		out[key] = value
	}
	if shell, _ := out["shell"].(string); strings.TrimSpace(shell) == "" {
		out["shell"] = "bash"
	} else {
		out["shell"] = telemetryShell(shell)
	}
	if vcs, _ := out["vcs"].(string); strings.TrimSpace(vcs) == "" {
		out["vcs"] = "git"
	}
	if runtimes, _ := out["runtimes"].(string); strings.TrimSpace(runtimes) == "" {
		out["runtimes"] = "node"
	}
	if bt, ok := out["build_time"].(string); !ok || strings.TrimSpace(bt) == "" {
		delete(out, "build_time")
	}
	return out
}

func dropEnvKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "node_version", "is_running_with_bun", "betas",
		"authorization", "cookie", "x-api-key", "proxy-authorization",
		"hostname", "machine_id", "machine-id", "kernel_release",
		"os_pretty", "os_id", "runtime_kind",
		// Guest hardware: not in the official CLI env (2.1.296), so older
		// worker.json files that still carry it must not upload it.
		"cpu_model", "cpu_cores", "memory_bytes", "root_disk", "mac",
		"dmi_manufacturer", "dmi_product", "dmi_version", "dmi_family",
		"dmi_serial", "dmi_uuid":
		return true
	default:
		return false
	}
}

func telemetryDevice(id Identity) string {
	if device := hex64(id.UserID); device != "" {
		return device
	}
	return hex64(id.DeviceID)
}

func hex64(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) != 64 {
		return ""
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return ""
		}
	}
	return value
}

func telemetryShell(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "bash"
	}
	value = strings.ReplaceAll(value, "\\", "/")
	if i := strings.LastIndex(value, "/"); i >= 0 {
		value = value[i+1:]
	}
	value = strings.TrimSuffix(strings.ToLower(value), ".exe")
	switch value {
	case "zsh", "bash", "fish", "sh", "dash", "ash", "ksh", "tcsh", "csh",
		"nu", "nushell", "pwsh", "powershell", "cmd", "elvish", "xonsh", "ion":
		return value
	default:
		return "other"
	}
}

func encodeProcess(proc config.TelemetryProcess, uptimeSecs float64) string {
	body, _ := json.Marshal(processJSON(proc, uptimeSecs))
	return base64.StdEncoding.EncodeToString(body)
}

func processJSON(proc config.TelemetryProcess, uptimeSecs float64) map[string]any {
	return map[string]any{
		"uptime":            uptimeSecs,
		"rss":               inRange(proc.RSSRange, 300_000_000, 500_000_000),
		"heapTotal":         inRange(proc.HeapTotalRange, 40_000_000, 80_000_000),
		"heapUsed":          inRange(proc.HeapUsedRange, 100_000_000, 200_000_000),
		"external":          inRange(proc.ExternalRange, 1_000_000, 3_000_000),
		"arrayBuffers":      inRange(proc.ArrayBuffersRange, 10_000, 50_000),
		"constrainedMemory": proc.ConstrainedMemory,
		"cpuUsage":          map[string]any{"user": 50_000 + rand.Int63n(450_000), "system": 15_000 + rand.Int63n(135_000)},
		"cpuPercent":        0.5 + rand.Float64()*4.5,
	}
}

func inRange(bounds []int64, fallbackMin, fallbackMax int64) int64 {
	min, max := fallbackMin, fallbackMax
	if len(bounds) >= 2 && bounds[1] > bounds[0] {
		min, max = bounds[0], bounds[1]
	}
	if max <= min {
		return min
	}
	return min + rand.Int63n(max-min)
}

func put(dst map[string]any, key, value string) {
	value = strings.TrimSpace(value)
	if value != "" {
		dst[key] = value
	}
}

func versionBase(version string) string {
	version = strings.TrimSpace(version)
	if version == "" {
		return ""
	}
	n := 0
	for i, c := range version {
		if c == '.' {
			n++
			if n == 3 {
				return version[:i]
			}
		}
	}
	return version
}

func newEventID() string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (e Event) MarshalJSON() ([]byte, error) {
	type alias Event
	return json.Marshal(alias(e))
}

func ContainsForbidden(raw []byte) bool {
	lower := strings.ToLower(string(raw))
	for _, needle := range forbiddenNeedles {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

var forbiddenNeedles = []string{
	"hostname",
	"machine-id",
	"machine_id",
	"kernel_release",
	"/.dockerenv",
	"runtime_kind",
	"\"docker\"",
	"kubernetes",
	"k8s",
	"git_remote",
	"\"cwd\"",
	"datadog",
	"\"cch\"",
	"os_pretty",
	"\"os_id\"",
	"codespaces",
}
