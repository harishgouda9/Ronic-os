use crate::textutil::hash_token;

pub const DIM: usize = 256;

pub fn embed(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; DIM];
    for token in text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| t.len() > 2)
    {
        let h = hash_token(&token);
        let idx = (h as usize) % DIM;
        let sign = if h & 1 == 0 { 1.0 } else { -1.0 };
        v[idx] += sign;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_notes_rank_above_unrelated() {
        let auth = embed("jwt session token rotation auth refactor");
        let near = embed("rotate the jwt session token");
        let far = embed("sourdough starter hydration bake");
        assert!(cosine(&auth, &near) > cosine(&auth, &far));
    }
}
