//! What providers this Node's installed runtime actually supports.
//!
//! The Node is the source of truth here, and the reason is not politeness about
//! layering. A provider is usable when *this host's verified runtime* can reach
//! it: the launcher is installed, Asterism has code that drives its
//! authorization, and a run executed against it works. None of those facts are
//! knowable from a Control Plane, which sees a version string and a fingerprint.
//! A Control Plane that kept its own list would be guessing, and it would guess
//! wrongly in the direction that hurts — offering a provider a host cannot use,
//! so a person authorizes something and every run afterwards fails.
//!
//! So the catalogue lives here, beside the code that implements it, and the
//! Control Plane stores what it is told rather than deciding what is true.
//!
//! **Only what is implemented is reported.** Hermes will accept the name of a
//! provider Asterism has never driven; that acceptance is not support. A name
//! belongs in this file when Asterism has an authorization path for it and a run
//! has gone through it — not when it becomes plausible. Today that is exactly
//! one entry, and the honest snapshot has one entry in it.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The shape of this report.
///
/// Read by the Control Plane to decide whether it can understand a snapshot at
/// all. A Control Plane meeting a version it does not know must show the Node as
/// unreadable rather than guess — which is why this is a number and not a
/// feature flag: there is no partial reading of a shape you do not have.
pub const SCHEMA_VERSION: u32 = 2;

/// Bounds. The Control Plane enforces the same numbers against the wire.
///
/// This report is authenticated but not trusted: it arrives from a host whose
/// binary an operator installed, over a channel that proves *which* Node is
/// speaking and nothing about what it says. Generous enough for any real
/// catalogue, small enough that a compromised Node cannot turn a page into a
/// denial of service by reporting a megabyte of providers.
pub const MAX_PROVIDERS: usize = 8;
pub const MAX_AUTH_METHODS: usize = 4;
pub const MAX_MODELS: usize = 32;
pub const MAX_ID_LENGTH: usize = 64;
pub const MAX_DISPLAY_NAME_LENGTH: usize = 64;

/// How a person proves to a provider that they may use it.
///
/// One value, because Asterism implements one. An API-key path is a real thing
/// to build and not a string to add here: until there is code that accepts a
/// key, stores it where a run reads it, and a run that used one, advertising it
/// would put a control in front of somebody that cannot work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    /// The provider's own CLI prints a link and a code, and a person approves it
    /// in a browser. What `provider.authorize()` drives today.
    DeviceAuthorization,
}

impl AuthMethod {
    pub fn wire(self) -> &'static str {
        match self {
            Self::DeviceAuthorization => "device_authorization",
        }
    }
}

/// Whether this host could use the provider at all right now.
///
/// Deliberately not "is it authorized". Holding a credential is a separate
/// question with its own state machine in `provider.rs`, and conflating them
/// would make a host that simply has not logged in yet look like a host that
/// cannot log in ever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Unavailable,
}

/// Why a provider cannot be used here. Typed, so a console can explain it
/// without parsing a sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    /// The launcher this provider is reached through is not installed. A host
    /// mid-installation, or one whose runtime did not survive an update.
    RuntimeMissing,
}

/// One model a project on this Node may be set to.
///
/// **What this claims, and what it does not.** It claims that the runtime this
/// release pins can be asked for this model through the integration Asterism
/// drives -- the identifier reaches the provider's own launcher as it is
/// written here. It says nothing about whether a credential is authorized, and
/// nothing about whether the account behind that credential may use the model:
/// that is answered by the provider when a run actually asks, and by nothing
/// before it. A console that turned this list into "your account can use these"
/// would be making a claim this Node is not in a position to make.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapability {
    /// As the runtime expects it, character for character.
    pub id: String,
    /// For a person. Never parsed, never matched on.
    pub display_name: String,
}

/// One provider, as this Node reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapability {
    /// Stable across releases and never re-used for something else. This is what
    /// a future credential record will point at, so renaming one is a migration
    /// rather than an edit.
    pub id: String,
    /// For a person. Never parsed, never matched on.
    pub display_name: String,
    pub auth_methods: Vec<AuthMethod>,
    pub availability: Availability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<UnavailableReason>,
    /// What a project on this provider may be set to run.
    ///
    /// Empty is a statement: this provider offers no choice here, and a project
    /// on it runs whatever the runtime defaults to. It is not the same as a
    /// snapshot that could not be read, which is why an unreadable snapshot is
    /// a different state rather than an empty list.
    #[serde(default)]
    pub models: Vec<ModelCapability>,
}

/// Everything this Node says about providers, at one moment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub schema_version: u32,
    /// The release whose runtime this describes.
    ///
    /// The Node binary and the runtime bundle ship as one release and are
    /// installed together, so the release tag names both. A snapshot that
    /// outlived its runtime is then visibly about a different release.
    pub runtime_release: String,
    /// Unix seconds, so a stale snapshot can be shown as stale rather than as
    /// the present.
    pub reported_at: u64,
    pub providers: Vec<ProviderCapability>,
}

/// What this Node supports, given where its runtime lives.
///
/// The catalogue is a `match` over facts about this host rather than a list read
/// from anywhere: adding a provider means adding the code that drives it, and
/// this function is where the two are forced to agree.
/// The models Asterism can ask the pinned Codex runtime for.
///
/// Read from the runtime this release installs -- Codex publishes its own
/// preset table, and these are the entries of it. The list lives beside the
/// integration for the same reason the provider list does: the Node binary and
/// the runtime bundle ship as one release, so the code that drives a model and
/// the runtime that serves it are installed together or not at all.
const OPENAI_CODEX_MODELS: [(&str, &str); 5] = [
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-terra", "GPT-5.6 Terra"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
    ("gpt-5.5", "GPT-5.5"),
    ("gpt-5.4", "GPT-5.4"),
];

pub fn snapshot(hermes_binary: &Path, runtime_release: &str) -> Snapshot {
    // Existence only. Whether the launcher still works is a question a run
    // answers, and a run asks it anyway.
    let runtime_installed = hermes_binary.exists();

    let openai_codex = ProviderCapability {
        // The pool a run reaches through Hermes -- not the Codex CLI session
        // that lives beside it under `CODEX_HOME`. Two credentials, two
        // formats, and only this one is read by a run.
        id: "openai-codex".to_owned(),
        display_name: "OpenAI Codex".to_owned(),
        auth_methods: vec![AuthMethod::DeviceAuthorization],
        availability: if runtime_installed {
            Availability::Available
        } else {
            Availability::Unavailable
        },
        unavailable_reason: (!runtime_installed).then_some(UnavailableReason::RuntimeMissing),
        // A model list from a host whose runtime is missing would offer a
        // choice nothing can carry out.
        models: if runtime_installed {
            OPENAI_CODEX_MODELS
                .iter()
                .map(|(id, display_name)| ModelCapability {
                    id: (*id).to_owned(),
                    display_name: (*display_name).to_owned(),
                })
                .collect()
        } else {
            Vec::new()
        },
    };

    Snapshot {
        schema_version: SCHEMA_VERSION,
        runtime_release: runtime_release.to_owned(),
        reported_at: now(),
        providers: vec![openai_codex],
    }
}

/// Whether a snapshot is within the bounds both sides enforce.
///
/// Checked on the way out as well as on the way in. A Node that reported
/// something the Control Plane will refuse has produced a host that silently
/// shows no providers, and finding that here rather than there is the difference
/// between a failing test and a confused operator.
pub fn within_bounds(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.providers.len() > MAX_PROVIDERS {
        return Err(format!(
            "{} providers, more than the {MAX_PROVIDERS} allowed",
            snapshot.providers.len()
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for provider in &snapshot.providers {
        if provider.id.is_empty() || provider.id.len() > MAX_ID_LENGTH {
            return Err(format!(
                "provider id {:?} is not a usable length",
                provider.id
            ));
        }
        if !provider
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!(
                "provider id {:?} holds something other than lowercase, digits and dashes",
                provider.id
            ));
        }
        if !seen.insert(provider.id.clone()) {
            // Two rows for one id would make "which one is current" depend on
            // which was read first.
            return Err(format!("provider id {:?} appears twice", provider.id));
        }
        if provider.display_name.is_empty() || provider.display_name.len() > MAX_DISPLAY_NAME_LENGTH
        {
            return Err(format!(
                "display name for {:?} is not a usable length",
                provider.id
            ));
        }
        if provider.auth_methods.is_empty() || provider.auth_methods.len() > MAX_AUTH_METHODS {
            return Err(format!(
                "{:?} offers {} authentication methods",
                provider.id,
                provider.auth_methods.len()
            ));
        }
        if provider.models.len() > MAX_MODELS {
            return Err(format!(
                "{:?} offers {} models, more than the {MAX_MODELS} allowed",
                provider.id,
                provider.models.len()
            ));
        }
        let mut model_ids = std::collections::BTreeSet::new();
        for model in &provider.models {
            validate_model_id(&model.id)?;
            if model.display_name.is_empty() || model.display_name.len() > MAX_DISPLAY_NAME_LENGTH {
                return Err(format!(
                    "display name for model {:?} is not a usable length",
                    model.id
                ));
            }
            if !model_ids.insert(model.id.clone()) {
                return Err(format!(
                    "model id {:?} appears twice for {:?}",
                    model.id, provider.id
                ));
            }
        }
    }
    Ok(())
}

/// Whether this snapshot says the model can be run on that provider.
///
/// The one place the question is answered, so the list a Node advertises and
/// the list it honours cannot drift apart. A model on another provider is not
/// an answer to this question: a project runs on one credential, and that
/// credential belongs to one provider.
pub fn supports(snapshot: &Snapshot, provider_id: &str, model: &str) -> bool {
    snapshot
        .providers
        .iter()
        .filter(|provider| provider.id == provider_id)
        .any(|provider| provider.models.iter().any(|known| known.id == model))
}

/// Whether a string is shaped like a model identifier.
///
/// Deliberately a shape and not a list. Which models exist is the runtime's
/// business and changes with it; what this refuses is anything that could mean
/// something else where the identifier is written -- a path, a shell fragment,
/// a newline into a configuration file.
pub fn validate_model_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LENGTH {
        return Err(format!("model id {id:?} is not a usable length"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
    {
        return Err(format!(
            "model id {id:?} holds something other than letters, digits, '.', '-', '_' and ':'"
        ));
    }
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The claim this whole phase rests on: what is reported is what is
    /// implemented. An entry appearing here without an authorization path behind
    /// it puts a control in front of somebody that cannot work.
    #[test]
    fn only_the_provider_asterism_actually_drives_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let hermes = dir.path().join("hermes");
        std::fs::write(&hermes, "x").unwrap();

        let snapshot = snapshot(&hermes, "v0.1.0-alpha.23");
        assert_eq!(snapshot.providers.len(), 1);
        let provider = &snapshot.providers[0];
        assert_eq!(provider.id, "openai-codex");
        assert_eq!(provider.display_name, "OpenAI Codex");
        assert_eq!(provider.auth_methods, vec![AuthMethod::DeviceAuthorization]);
        assert_eq!(provider.availability, Availability::Available);
        assert_eq!(provider.unavailable_reason, None);
    }

    /// No API-key provider is advertised, because none is implemented. This test
    /// is what a future change has to argue with.
    #[test]
    fn no_provider_offers_an_authentication_method_asterism_cannot_perform() {
        let dir = tempfile::tempdir().unwrap();
        let hermes = dir.path().join("hermes");
        std::fs::write(&hermes, "x").unwrap();

        for provider in snapshot(&hermes, "v1").providers {
            for method in provider.auth_methods {
                assert_eq!(
                    method,
                    AuthMethod::DeviceAuthorization,
                    "{} offers {method:?}, which nothing here performs",
                    provider.id
                );
            }
        }
    }

    /// A host without the launcher still names the provider, and says why it is
    /// out of reach. Reporting nothing would be indistinguishable from a Node
    /// that never spoke.
    #[test]
    fn a_host_without_the_runtime_reports_the_provider_as_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = snapshot(&dir.path().join("absent"), "v0.1.0-alpha.23");
        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(
            snapshot.providers[0].availability,
            Availability::Unavailable
        );
        assert_eq!(
            snapshot.providers[0].unavailable_reason,
            Some(UnavailableReason::RuntimeMissing)
        );
    }

    #[test]
    fn a_snapshot_names_the_release_it_describes_and_when_it_was_taken() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = snapshot(&dir.path().join("absent"), "v0.1.0-alpha.23");
        assert_eq!(snapshot.schema_version, SCHEMA_VERSION);
        assert_eq!(snapshot.runtime_release, "v0.1.0-alpha.23");
        assert!(snapshot.reported_at > 1_700_000_000);
    }

    #[test]
    fn what_this_node_reports_is_within_the_bounds_the_control_plane_enforces() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            within_bounds(&snapshot(&dir.path().join("a"), "v1")),
            Ok(())
        );
    }

    fn one(id: &str) -> ProviderCapability {
        ProviderCapability {
            id: id.to_owned(),
            display_name: "X".to_owned(),
            auth_methods: vec![AuthMethod::DeviceAuthorization],
            availability: Availability::Available,
            unavailable_reason: None,
            models: Vec::new(),
        }
    }

    fn holding(providers: Vec<ProviderCapability>) -> Snapshot {
        Snapshot {
            schema_version: SCHEMA_VERSION,
            runtime_release: "v1".to_owned(),
            reported_at: 1,
            providers,
        }
    }

    #[test]
    fn the_bounds_refuse_what_they_are_meant_to() {
        let too_many = holding(
            (0..MAX_PROVIDERS + 1)
                .map(|n| one(&format!("p{n}")))
                .collect(),
        );
        assert!(within_bounds(&too_many).is_err());

        assert!(within_bounds(&holding(vec![one("")])).is_err());
        assert!(within_bounds(&holding(vec![one(&"x".repeat(MAX_ID_LENGTH + 1))])).is_err());
        // A path, a space and an upper-case letter are all things an id must not
        // be able to carry: this value reaches a URL and a database key.
        for bad in ["../etc", "openai codex", "OpenAI", "a/b", "a_b"] {
            assert!(within_bounds(&holding(vec![one(bad)])).is_err(), "{bad}");
        }
        assert!(within_bounds(&holding(vec![one("a"), one("a")])).is_err());

        let mut nameless = one("a");
        nameless.display_name = String::new();
        assert!(within_bounds(&holding(vec![nameless])).is_err());

        let mut unauthenticated = one("a");
        unauthenticated.auth_methods = Vec::new();
        assert!(within_bounds(&holding(vec![unauthenticated])).is_err());
    }

    /// The wire spelling is the contract. A rename here is a protocol change,
    /// and this is the test that says so.
    #[test]
    fn the_wire_spelling_is_what_the_control_plane_reads() {
        let dir = tempfile::tempdir().unwrap();
        let value = serde_json::to_value(snapshot(&dir.path().join("a"), "v1")).unwrap();
        assert_eq!(value["schema_version"], 2);
        assert_eq!(value["providers"][0]["id"], "openai-codex");
        assert_eq!(value["providers"][0]["availability"], "unavailable");
        assert_eq!(
            value["providers"][0]["unavailable_reason"],
            "runtime_missing"
        );
        assert_eq!(
            value["providers"][0]["auth_methods"][0],
            AuthMethod::DeviceAuthorization.wire()
        );
    }

    /// The models are what the pinned runtime can be asked for, and they are
    /// reported beside the provider rather than as a separate report: a project
    /// chooses a model *on* the provider its credential belongs to.
    #[test]
    fn the_provider_reports_the_models_its_runtime_can_be_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let hermes = dir.path().join("hermes");
        std::fs::write(&hermes, "x").unwrap();

        let snapshot = snapshot(&hermes, "v0.1.0-alpha.32");
        let provider = &snapshot.providers[0];
        assert!(
            provider.models.len() >= 2,
            "the pinned runtime offers a choice"
        );
        assert!(
            provider
                .models
                .iter()
                .any(|model| model.id == "gpt-5.6-sol")
        );
        for model in &provider.models {
            assert_eq!(validate_model_id(&model.id), Ok(()), "{}", model.id);
            assert!(!model.display_name.is_empty());
        }
        assert_eq!(within_bounds(&snapshot), Ok(()));

        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            value["providers"][0]["models"][0]["id"],
            provider.models[0].id
        );
        assert_eq!(
            value["providers"][0]["models"][0]["display_name"],
            provider.models[0].display_name
        );
    }

    /// A host that cannot reach the runtime offers no models. Advertising a
    /// choice nothing can carry out is worse than offering none.
    #[test]
    fn a_host_without_the_runtime_offers_no_models() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = snapshot(&dir.path().join("absent"), "v1");
        assert!(snapshot.providers[0].models.is_empty());
    }

    /// The identifier is checked for what it could mean elsewhere -- it is
    /// written into a configuration file the worker reads -- and not against a
    /// list of models, which is the runtime's business and not this file's.
    #[test]
    fn a_model_id_is_refused_for_its_shape_and_never_for_being_unfamiliar() {
        for good in ["gpt-5.6-sol", "claude-opus-5", "some.vendor:model_7", "X9"] {
            assert_eq!(validate_model_id(good), Ok(()), "{good} must be accepted");
        }
        for bad in [
            "",
            "../etc/passwd",
            "a b",
            "a/b",
            "model\nmodel",
            &"m".repeat(MAX_ID_LENGTH + 1),
        ] {
            assert!(validate_model_id(bad).is_err(), "{bad:?} must be refused");
        }
    }

    /// A model belongs to the provider that reported it, and to no other.
    /// Answered from the snapshot rather than from a list kept anywhere else.
    #[test]
    fn a_model_is_supported_only_on_the_provider_that_reported_it() {
        let mut first = one("alpha");
        first.models = vec![ModelCapability {
            id: "m-one".to_owned(),
            display_name: "One".to_owned(),
        }];
        let mut second = one("beta");
        second.models = vec![ModelCapability {
            id: "m-two".to_owned(),
            display_name: "Two".to_owned(),
        }];
        let snapshot = holding(vec![first, second]);

        assert!(supports(&snapshot, "alpha", "m-one"));
        assert!(supports(&snapshot, "beta", "m-two"));
        assert!(!supports(&snapshot, "alpha", "m-two"));
        assert!(!supports(&snapshot, "beta", "m-one"));
        assert!(!supports(&snapshot, "gamma", "m-one"));
        assert!(!supports(&snapshot, "alpha", "m-three"));
        assert!(!supports(&holding(vec![one("alpha")]), "alpha", "m-one"));
    }

    #[test]
    fn the_bounds_refuse_an_unusable_model_list() {
        let mut too_many = one("a");
        too_many.models = (0..MAX_MODELS + 1)
            .map(|n| ModelCapability {
                id: format!("m{n}"),
                display_name: "M".to_owned(),
            })
            .collect();
        assert!(within_bounds(&holding(vec![too_many])).is_err());

        let mut duplicated = one("a");
        duplicated.models = vec![
            ModelCapability {
                id: "m".to_owned(),
                display_name: "M".to_owned(),
            },
            ModelCapability {
                id: "m".to_owned(),
                display_name: "M".to_owned(),
            },
        ];
        assert!(within_bounds(&holding(vec![duplicated])).is_err());

        let mut nameless = one("a");
        nameless.models = vec![ModelCapability {
            id: "m".to_owned(),
            display_name: String::new(),
        }];
        assert!(within_bounds(&holding(vec![nameless])).is_err());

        let mut hostile = one("a");
        hostile.models = vec![ModelCapability {
            id: "../m".to_owned(),
            display_name: "M".to_owned(),
        }];
        assert!(within_bounds(&holding(vec![hostile])).is_err());
    }

    /// Reads the Control Plane's own numbers rather than a copy of them. Two
    /// sides enforcing different bounds is a Node whose honest report is refused
    /// on arrival, and nothing else would notice.
    #[test]
    fn the_bounds_match_the_ones_the_control_plane_enforces() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/control-plane/src/provider-capabilities.ts"
        ))
        .expect("the Control Plane contract must be readable");
        for (name, value) in [
            ("SUPPORTED_SCHEMA_VERSION", SCHEMA_VERSION as usize),
            ("MAX_PROVIDERS", MAX_PROVIDERS),
            ("MAX_AUTH_METHODS", MAX_AUTH_METHODS),
            ("MAX_MODELS", MAX_MODELS),
            ("MAX_ID_LENGTH", MAX_ID_LENGTH),
            ("MAX_DISPLAY_NAME_LENGTH", MAX_DISPLAY_NAME_LENGTH),
        ] {
            assert!(
                source.contains(&format!("export const {name} = {value};")),
                "the Control Plane does not agree that {name} is {value}"
            );
        }
    }
}
