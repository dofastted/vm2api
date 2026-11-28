use compact_str::CompactString;
use serde::{Deserialize, Serialize};
use std::fmt;

pub type PoolId = CompactString;
pub type NodeKey = CompactString;
pub type RequestId = CompactString;
pub type LeaseId = CompactString;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    #[default]
    Leader,
    Standby,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    ClaudeVm,
    CodexVm,
    GeminiEnv,
    ApiEndpoint,
}

impl NodeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeVm => "claude_vm",
            Self::CodexVm => "codex_vm",
            Self::GeminiEnv => "gemini_env",
            Self::ApiEndpoint => "api_endpoint",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Anthropic,
    Openai,
    #[serde(alias = "gemini")]
    Google,
    ApiCustom,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderScope {
    Anthropic,
    Openai,
    #[serde(alias = "gemini")]
    Google,
    Api,
    #[default]
    Mixed,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFamily {
    Claude,
    Openai,
    Gemini,
    #[default]
    Other,
}

impl ModelFamily {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Openai => "openai",
            Self::Gemini => "gemini",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolRole {
    Primary,
    #[default]
    Standard,
    Overflow,
    Downgrade,
    Dedicated,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberRole {
    #[default]
    Active,
    Standby,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntraTierStrategy {
    #[default]
    LeastInflightSwrr,
    Balanced,
    Fill,
    Ordered,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOverflowPolicy {
    /// Locked D2 default: spill immediately with zero wait and zero cooldown.
    #[default]
    SpillImmediately,
    WaitThenSpill,
    Strict,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemPromptMode {
    Official,
    ZeroInject,
    Override,
    Append,
    #[default]
    Passthrough,
    InheritGlobal,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientSystemPolicy {
    #[default]
    PrependPool,
    AppendPool,
    ReplaceClient,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptPolicySource {
    Pool,
    Global,
    #[default]
    ProviderExempt,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JevProfile {
    #[default]
    InheritGlobal,
    Enforce,
    DowngradeOnly,
    BypassTrusted,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolBindingMode {
    #[default]
    StrictPool,
    LegacyScope,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeightTierMode {
    #[default]
    Manual,
    Auto7dReset,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseOutcome {
    #[default]
    Ok,
    Error,
    Aborted,
    Timeout,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StickyScopeKind {
    Machine,
    Session,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    RateLimit429,
    Overloaded529,
    QuotaExhausted,
    AuthError,
    Server5xx,
    Client4xx,
    ContextTooLong,
    JevBlocked,
    Refusal,
    PermanentBan,
    Transport,
    Timeout,
    #[default]
    Unknown,
}

/// Pool + model_family isolated session key used by both SessionGate and L1 session_sticks.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct ScopedSessionKey {
    pub pool_id: PoolId,
    pub model_family: ModelFamily,
    pub session_id: CompactString,
}

impl ScopedSessionKey {
    pub fn new(
        pool_id: impl AsRef<str>,
        model_family: ModelFamily,
        session_id: impl AsRef<str>,
    ) -> Self {
        Self {
            pool_id: CompactString::from(pool_id.as_ref()),
            model_family,
            session_id: CompactString::from(session_id.as_ref()),
        }
    }
}

impl fmt::Display for ScopedSessionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}",
            self.pool_id,
            self.model_family.as_str(),
            self.session_id
        )
    }
}

/// Pool + model_family isolated machine key used by L2 machine_sticks.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct ScopedMachineKey {
    pub pool_id: PoolId,
    pub model_family: ModelFamily,
    pub machine_id: CompactString,
}

impl ScopedMachineKey {
    pub fn new(
        pool_id: impl AsRef<str>,
        model_family: ModelFamily,
        machine_id: impl AsRef<str>,
    ) -> Self {
        Self {
            pool_id: CompactString::from(pool_id.as_ref()),
            model_family,
            machine_id: CompactString::from(machine_id.as_ref()),
        }
    }
}

impl fmt::Display for ScopedMachineKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}",
            self.pool_id,
            self.model_family.as_str(),
            self.machine_id
        )
    }
}
