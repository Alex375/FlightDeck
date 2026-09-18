//! The build scripts' workspace detection (scripts/lib-layout.sh), exercised
//! by its shell test suite on throwaway directory trees.

#[test]
fn lib_layout_detects_only_real_enclosing_workspaces() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/scripts/test-lib-layout.sh");
    let out = std::process::Command::new("bash").arg(script).output().expect("bash");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.contains("all cases pass"), "{stdout}");
}
