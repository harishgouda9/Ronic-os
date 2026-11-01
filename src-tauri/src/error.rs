use serde::Serialize;

#[derive(Debug)]
pub struct RonicError(pub String);

impl std::fmt::Display for RonicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for RonicError {}

impl Serialize for RonicError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<rusqlite::Error> for RonicError {
    fn from(value: rusqlite::Error) -> Self {
        RonicError(value.to_string())
    }
}

impl From<serde_json::Error> for RonicError {
    fn from(value: serde_json::Error) -> Self {
        RonicError(value.to_string())
    }
}

impl From<std::io::Error> for RonicError {
    fn from(value: std::io::Error) -> Self {
        RonicError(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, RonicError>;

pub fn err(msg: impl Into<String>) -> RonicError {
    RonicError(msg.into())
}
