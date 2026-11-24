export const GEMINI_MAINTENANCE_SECTION_ID = 'gemini-maintenance'

const hostIssues: Record<string, true> = {
  gemini_host_socket_missing: true,
  gemini_host_socket_refused: true,
  gemini_host_socket_denied: true,
  gemini_host_timeout: true,
  gemini_host_unsupported_platform: true,
  gemini_host_invalid_socket: true,
  gemini_host_protocol_error: true,
  gemini_host_unavailable: true,
  gemini_payload_not_configured: true,
  gemini_public_key_missing: true,
  gemini_payload_source_missing: true,
  gemini_payload_incomplete: true,
  gemini_payload_invalid: true,
  gemini_payload_not_installed: true,
  gemini_release_not_configured: true,
  gemini_release_invalid: true,
  gemini_release_payload_mismatch: true,
  gemini_egress_unavailable: true,
  gemini_oauth_tools_missing: true,
  gemini_ipv4_forwarding_unavailable: true,
  gemini_authorization_unavailable: true,
  gemini_native_tty_unavailable: true,
  gemini_native_worker_unavailable: true,
  gemini_native_bridge_timeout: true,
  gemini_terminal_unavailable: true,
  gemini_inference_start_failed: true,
  gemini_test_oauth_unsupported: true,
  gemini_maintenance_lock_invalid: true,
}

// Account, eligibility, proxy, quota and redemption failures are not install failures.
export function isGeminiHostIssue(code: unknown): boolean {
  return typeof code === 'string' && hostIssues[code] === true
}
