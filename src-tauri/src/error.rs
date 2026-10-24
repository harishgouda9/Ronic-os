use serde::Serialize;

#[derive(Debug)]
pub struct OmniError(pub String);

impl std::fmt::Display for OmniError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for OmniError {}

impl Serialize for OmniError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<rusqlite::Error> for OmniError {
    fn from(value: rusqlite::Error) -> Self {
        OmniError(value.to_string())
    }
}

impl From<serde_json::Error> for OmniError {
    fn from(value: serde_json::Error) -> Self {
        OmniError(value.to_string())
    }
}

impl From<std::io::Error> for OmniError {
    fn from(value: std::io::Error) -> Self {
        OmniError(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, OmniError>;

pub fn err(msg: impl Into<String>) -> OmniError {
    OmniError(msg.into())
}
