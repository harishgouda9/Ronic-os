use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::AppState;

const FEED_LIMIT: usize = 65_536;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFeedSources {
    pub local_path: String,
    pub local_text: Option<String>,
    pub local_error: Option<String>,
    pub remote_text: Option<String>,
    pub remote_error: Option<String>,
}

#[tauri::command]
pub async fn read_update_feed(state: State<'_, AppState>, feed_url: String) -> Result<UpdateFeedSources, String> {
    let home = state.home.clone();
    let feed_url = feed_url.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || read_sources(&home, &feed_url))
        .await
        .map_err(|_| "Could not read the release file.".to_string())
}

fn read_sources(home: &Path, feed_url: &str) -> UpdateFeedSources {
    let path = home.join("update-feed.json");
    let (local_text, local_error) = read_local(&path);
    let (remote_text, remote_error) = fetch_remote(feed_url);
    UpdateFeedSources {
        local_path: path.display().to_string(),
        local_text,
        local_error,
        remote_text,
        remote_error,
    }
}

fn read_local(path: &Path) -> (Option<String>, Option<String>) {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() > FEED_LIMIT => (None, Some("The local release file is larger than 64 KB.".into())),
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => (Some(text), None),
            Err(_) => (None, Some("The local release file is not UTF-8 text.".into())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
        Err(error) => (None, Some(format!("Could not read the local release file: {error}"))),
    }
}

fn fetch_remote(feed_url: &str) -> (Option<String>, Option<String>) {
    if feed_url.is_empty() {
        return (None, None);
    }
    if !feed_url.starts_with("https://") {
        return (None, Some("The feed address has to start with https://.".into()));
    }
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
    {
        Ok(client) => client,
        Err(error) => return (None, Some(error.without_url().to_string())),
    };
    let response = match client.get(feed_url).send() {
        Ok(response) => response,
        Err(error) => return (None, Some(error.without_url().to_string())),
    };
    if response.url().scheme() != "https" {
        return (None, Some("The feed redirected away from https.".into()));
    }
    if !response.status().is_success() {
        return (None, Some(format!("The feed returned HTTP {}.", response.status())));
    }
    match response.text() {
        Ok(text) if text.len() > FEED_LIMIT => (None, Some("The feed response is larger than 64 KB.".into())),
        Ok(text) => (Some(text), None),
        Err(error) => (None, Some(error.without_url().to_string())),
    }
}
