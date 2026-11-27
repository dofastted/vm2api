use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub socket_path: Option<PathBuf>,
    pub listen_addr: Option<String>,
    pub token: String,
    pub cap_file: Option<PathBuf>,
    pub lease_ttl_ms: u64,
    pub reap_interval_ms: u64,
}

impl DaemonConfig {
    pub fn parse_from_args_and_env() -> Result<Self, String> {
        let args: Vec<String> = env::args().skip(1).collect();
        Self::parse_from(&args)
    }

    pub fn parse_from(args: &[String]) -> Result<Self, String> {
        let mut socket_path = env::var("KIN_SCHEDULER_SOCK")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let mut listen_addr = env::var("KIN_SCHEDULER_LISTEN")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let mut token = env::var("KIN_SCHEDULER_TOKEN")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let mut token_file = env::var("KIN_SCHEDULER_TOKEN_FILE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let mut cap_file = env::var("KIN_SCHEDULER_CAP_FILE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let mut lease_ttl_ms: u64 = env::var("KIN_SCHEDULER_LEASE_TTL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(120_000);
        let mut reap_interval_ms: u64 = env::var("KIN_SCHEDULER_REAP_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5_000);

        let mut i = 0usize;
        while i < args.len() {
            let raw = &args[i];
            let (flag, inline_val) = match raw.split_once('=') {
                Some((k, v)) => (k, Some(v)),
                None => (raw.as_str(), None),
            };
            let norm = flag.trim_start_matches('-');
            let mut next_val = || -> Result<String, String> {
                if let Some(v) = inline_val {
                    Ok(v.to_owned())
                } else {
                    i += 1;
                    args.get(i)
                        .cloned()
                        .ok_or_else(|| format!("missing value for argument '{flag}'"))
                }
            };

            match norm {
                "h" | "help" => {
                    return Err(
                        "Usage: kin-scheduler [--socket PATH | --listen HOST:PORT] [--token HEX | --token-file PATH] [--cap-file PATH] [--lease-ttl-ms MS] [--reap-interval-ms MS]".to_owned(),
                    );
                }
                "socket" => {
                    let v = next_val()?;
                    socket_path = if v.is_empty() {
                        None
                    } else {
                        Some(PathBuf::from(v))
                    };
                }
                "listen" => {
                    let v = next_val()?;
                    listen_addr = if v.is_empty() { None } else { Some(v) };
                }
                "token" => {
                    token = Some(next_val()?.trim().to_owned());
                }
                "token-file" | "token_file" => {
                    token_file = Some(PathBuf::from(next_val()?));
                }
                "cap-file" | "cap_file" => {
                    cap_file = Some(PathBuf::from(next_val()?));
                }
                "lease-ttl-ms" | "lease_ttl_ms" => {
                    let v = next_val()?;
                    lease_ttl_ms = v
                        .parse()
                        .map_err(|_| format!("invalid lease-ttl-ms '{v}'"))?;
                }
                "reap-interval-ms" | "reap_interval_ms" => {
                    let v = next_val()?;
                    reap_interval_ms = v
                        .parse()
                        .map_err(|_| format!("invalid reap-interval-ms '{v}'"))?;
                }
                other => {
                    return Err(format!("unknown argument '--{other}'"));
                }
            }
            i += 1;
        }

        let resolved_token = match token {
            Some(t) if !t.is_empty() => t,
            _ => match token_file {
                Some(path) => fs::read_to_string(&path)
                    .map_err(|e| format!("failed to read token file '{}': {e}", path.display()))?
                    .trim()
                    .to_owned(),
                None => String::new(),
            },
        };

        if resolved_token.is_empty() {
            return Err(
                "internal token is required (pass --token, --token-file, KIN_SCHEDULER_TOKEN, or KIN_SCHEDULER_TOKEN_FILE)".to_owned(),
            );
        }

        if socket_path.is_none() && listen_addr.is_none() {
            listen_addr = Some("127.0.0.1:0".to_owned());
        }

        Ok(Self {
            socket_path,
            listen_addr,
            token: resolved_token,
            cap_file,
            lease_ttl_ms: lease_ttl_ms.max(100),
            reap_interval_ms: reap_interval_ms.max(50),
        })
    }
}
