pub fn wikilinks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("]]") {
            let name = rest[..end].trim();
            if !name.is_empty() && !name.contains('\n') {
                out.push(name.to_string());
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    out
}

pub fn hash_token(token: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in token.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
