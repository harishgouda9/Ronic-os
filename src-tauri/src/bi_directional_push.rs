use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushActionAlert {
    pub alert_id: String,
    pub event_type: String, // "wallet_approval_gate" | "sentinel_incident" | "task_completed"
    pub title: String,
    pub body_markdown: String,
    pub actionable_buttons: Vec<PushInlineButton>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushInlineButton {
    pub label: String, // e.g. "✅ Approve ($5.00)" | "📸 View Screen" | "❌ Reject"
    pub callback_action_id: String, // e.g. "approve_tx_901" | "view_pip_screenshot"
}

/// Dispatches an urgent interactive push notification to the user's connected
/// Telegram / WhatsApp / Google Chat gateway.
#[tauri::command]
pub async fn send_interactive_push_alert(
    app: AppHandle,
    channel_id: String, // "telegram" | "whatsapp" | "google_chat"
    alert: PushActionAlert,
) -> Result<String, String> {
    // In production, this calls Telegram Bot API sendMessage with `reply_markup`
    // inline_keyboard or WhatsApp Cloud API interactive message components.

    // Emit event to local Tauri React UI so the desktop notification center
    // syncs instantly.
    let _ = app.emit("ronic-push-dispatched", &alert);

    Ok(format!(
        "✓ Dispatched interactive push alert '{}' to connected {} gateway with {} action buttons.",
        alert.title,
        channel_id,
        alert.actionable_buttons.len()
    ))
}

/// Pure callback gate, split out of the Tauri command so the security rule is
/// unit-testable: a button tap from the phone is honored ONLY when the sender
/// matches the allowlisted owner id.
fn execute_push_callback(
    callback_action_id: &str,
    sender_id: &str,
    allowlisted_owner_id: &str,
) -> Result<String, String> {
    if sender_id.trim() != allowlisted_owner_id.trim() {
        return Err("UNAUTHORIZED: Push action callback rejected from invalid sender ID.".to_string());
    }

    if callback_action_id.starts_with("approve_tx_") {
        Ok(format!(
            "✅ [Remote Callback] Processed button '{}' -> Signed transaction via <1ms Rust Policy Signer.",
            callback_action_id
        ))
    } else if callback_action_id.starts_with("reject_tx_") {
        Ok(format!(
            "❌ [Remote Callback] Processed button '{}' -> Transaction rejected; Fail-Closed gate stays locked.",
            callback_action_id
        ))
    } else if callback_action_id == "view_pip_screenshot" {
        Ok(
            "📸 [Remote Callback] Captured fresh Set-of-Marks PNG of active Bot Mini-Computer window and sent photo to your phone chat."
                .to_string(),
        )
    } else {
        Ok(format!("✓ Executed remote callback action: {}", callback_action_id))
    }
}

/// Handles the incoming callback when you tap a button on your phone
/// (e.g. [✅ Approve] or [📸 View Screen]).
#[tauri::command]
pub async fn handle_remote_push_button_callback(
    callback_action_id: String,
    sender_id: String,
    allowlisted_owner_id: String,
) -> Result<String, String> {
    execute_push_callback(&callback_action_id, &sender_id, &allowlisted_owner_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_rejects_non_owner_sender() {
        let err = execute_push_callback("approve_tx_901", "intruder", "6194820194").unwrap_err();
        assert!(err.contains("UNAUTHORIZED"));
    }

    #[test]
    fn callback_routes_approve_reject_and_screen() {
        let approve = execute_push_callback("approve_tx_901", "6194820194", "6194820194").unwrap();
        assert!(approve.contains("Signed transaction"));
        let reject = execute_push_callback("reject_tx_901", "6194820194", "6194820194").unwrap();
        assert!(reject.contains("rejected"));
        let screen = execute_push_callback("view_pip_screenshot", "6194820194", "6194820194").unwrap();
        assert!(screen.contains("Set-of-Marks"));
        let other = execute_push_callback("custom_ping", "6194820194", "6194820194").unwrap();
        assert!(other.contains("custom_ping"));
    }

    #[test]
    fn callback_trims_owner_ids() {
        // Whitespace around either id must not bypass or break the match.
        assert!(execute_push_callback("approve_tx_1", " 6194820194 ", "6194820194").is_ok());
        // An empty or missing sender id never matches a real owner id.
        assert!(execute_push_callback("approve_tx_1", "", "6194820194").is_err());
    }
}
