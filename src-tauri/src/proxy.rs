use crate::util::ipc_push;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn spawn(port_slot: Arc<AtomicU16>, ipc: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        let mut port = 4141u16;
        let listener = loop {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => break listener,
                Err(_) if port < 4155 => {
                    ipc_push(&ipc, &format!("proxy port {port} is busy, trying {}", port + 1));
                    port += 1;
                }
                Err(e) => {
                    ipc_push(&ipc, &format!("proxy failed to bind: {e}"));
                    return;
                }
            }
        };
        port_slot.store(port, Ordering::Relaxed);
        ipc_push(&ipc, &format!("proxy listening on 127.0.0.1:{port}/v1"));
        let _ = listener.set_nonblocking(false);
        for incoming in listener.incoming() {
            let Ok(mut stream) = incoming else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/");
            let body = if path.starts_with("/v1/models") || path.starts_with("/models") {
                r#"{"object":"list","data":[{"id":"omni-local","object":"model","owned_by":"omniworkspace"}]}"#.to_string()
            } else if path.starts_with("/v1/chat/completions") || path.starts_with("/chat/completions") {
                r#"{"id":"chatcmpl_local","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Ronic OS loopback is up. Send tasks from the workspace composer so the policy gate and memory apply."},"finish_reason":"stop"}]}"#.to_string()
            } else {
                format!(r#"{{"ok":true,"port":{port}}}"#)
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
}
