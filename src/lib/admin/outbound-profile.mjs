/**
 * Read-only outbound reference for Settings → Protocol: what the saved global
 * preset sends. Values only; no secrets, no request data.
 */
import { resolveSlotPersonaPreset } from '../vm/slot-engine.mjs'
import { profileForPreset } from '../identity/official-profiles.mjs'
import { officialClaudeCliUa } from '../identity/vm-identity.mjs'
import { defaultOfficialBetaHeader } from '../protocol/claude-code-betas.mjs'
import { ccEntrypointFromRouting } from '../identity/crs-persona.mjs'

const SAMPLE_MODEL = 'claude-opus-5-5'

export function buildOutboundProfile(routing = {}) {
  const preset = resolveSlotPersonaPreset({}, routing)
  const { cliVersion } = profileForPreset(preset)
  const entrypoint = ccEntrypointFromRouting(routing)
  return {
    preset,
    cli_version: cliVersion,
    cc_entrypoint: entrypoint,
    user_agent: officialClaudeCliUa(cliVersion, entrypoint),
    anthropic_beta: defaultOfficialBetaHeader(SAMPLE_MODEL),
    beta_sample_model: SAMPLE_MODEL,
  }
}
