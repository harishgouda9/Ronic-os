use crate::error::{err, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn vault_dest(vault: &Path, relative: &str) -> Result<PathBuf> {
    let root = canonical_vault(vault)?;
    let parts = note_parts(relative)?;
    let dest = parts.iter().fold(root.clone(), |path, part| path.join(part));
    assert_safe_existing_ancestors(&root, &dest)?;
    Ok(dest)
}

pub fn write_note(vault: &Path, relative: &str, body: &str) -> Result<PathBuf> {
    let dest = vault_dest(vault, relative)?;
    if let Some(parent) = dest.parent() {
        ensure_safe_parent(&canonical_vault(vault)?, parent)?;
    }
    if dest.exists() && fs::symlink_metadata(&dest)?.file_type().is_symlink() {
        return Err(err("memory file path cannot be a symlink"));
    }
    atomic_write(&dest, body.as_bytes())?;
    Ok(dest)
}

pub fn remove_note(vault: &Path, relative: &str) -> Result<()> {
    if relative.trim().is_empty() {
        return Ok(());
    }
    let dest = vault_dest(vault, relative)?;
    if dest.exists() {
        if fs::symlink_metadata(&dest)?.file_type().is_symlink() {
            return Err(err("memory file path cannot be a symlink"));
        }
        if dest.is_file() {
            fs::remove_file(dest)?;
        }
    }
    Ok(())
}

fn canonical_vault(vault: &Path) -> Result<PathBuf> {
    let root = vault.canonicalize()?;
    if !root.is_dir() {
        return Err(err("configured Obsidian vault is not a folder"));
    }
    Ok(root)
}

fn note_parts(relative: &str) -> Result<Vec<String>> {
    let rel = relative.trim();
    if rel.is_empty() {
        return Err(err("memory file path is empty"));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(err("memory file path must stay inside the vault"));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            _ => return Err(err("memory file path must stay inside the vault")),
        }
    }
    if parts.is_empty() {
        return Err(err("memory file path must stay inside the vault"));
    }
    Ok(parts)
}

fn assert_safe_existing_ancestors(root: &Path, dest: &Path) -> Result<()> {
    let mut current = root.to_path_buf();
    let relative = dest.strip_prefix(root).map_err(|_| err("memory file path must stay inside the vault"))?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        let Component::Normal(part) = component else { return Err(err("memory file path must stay inside the vault")) };
        current.push(part);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(err("memory file path cannot traverse a symlink"));
            }
        }
    }
    Ok(())
}

fn ensure_safe_parent(root: &Path, parent: &Path) -> Result<()> {
    let relative = parent.strip_prefix(root).map_err(|_| err("memory file path must stay inside the vault"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else { return Err(err("memory file path must stay inside the vault")) };
        current.push(part);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(err("memory file path cannot traverse a symlink"));
            }
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(())
}

fn atomic_write(dest: &Path, body: &[u8]) -> Result<()> {
    let parent = dest.parent().ok_or_else(|| err("memory file path must stay inside the vault"))?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
    let temp = parent.join(format!(".ronic-{}-{nonce}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&temp, dest)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn companion_write_rejects_escape() {
        let root = std::env::temp_dir().join(format!("ronic-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let vault = root.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let outside = root.join("secret.md");
        let rejected = write_note(&vault, "../secret.md", "nope");
        assert!(rejected.is_err());
        assert!(!outside.exists());
        let rejected_win = write_note(&vault, r"..\secret.md", "nope");
        assert!(rejected_win.is_err());
        assert!(!outside.exists());
        let written = write_note(&vault, "notes/ok.md", "yes").unwrap();
        assert_eq!(std::fs::read_to_string(written).unwrap(), "yes");
        let _ = std::fs::remove_dir_all(&root);
    }
}
