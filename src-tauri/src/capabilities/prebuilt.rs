use include_dir::{include_dir, Dir};
use std::fs;
use std::path::Path;

use crate::error::Result;

pub const PLUGIN_ID: &str = "plug-prebuilt-skills";

const STAMP: &str = "2026-10-28.2";

static PREBUILT: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/resources/builtin-skills/prebuilt");

pub fn install(home: &Path) -> Result<()> {
    let dir = home.join("plugins").join("prebuilt-skills");
    let stamp = dir.join(".prebuilt-stamp");
    let current = fs::read_to_string(&stamp).unwrap_or_default();
    if dir.join("plugin.yaml").is_file() && current.trim() == STAMP {
        return Ok(());
    }
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    PREBUILT.extract(&dir)?;
    fs::write(stamp, STAMP)?;
    Ok(())
}
