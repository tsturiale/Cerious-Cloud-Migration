#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn env_port(name: &str, fallback: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(fallback)
}

fn port_is_listening(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    std::net::TcpStream::connect_timeout(
        &address.parse().expect("static localhost socket address"),
        Duration::from_millis(350),
    )
    .is_ok()
}

fn has_service_launcher(path: &Path) -> bool {
    path.join("Start-CeriousApp.ps1").exists()
}

fn root_from_env() -> Option<PathBuf> {
    std::env::var_os("CERIOUS_APP_ROOT")
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok())
        .filter(|path| has_service_launcher(path))
}

fn root_near_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut cursor = exe.parent()?.to_path_buf();
    for _ in 0..8 {
        if has_service_launcher(&cursor) {
            return cursor.canonicalize().ok();
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

fn root_from_build_tree() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    path.canonicalize()
        .ok()
        .filter(|root| has_service_launcher(root))
}

fn repo_root() -> Option<PathBuf> {
    root_from_env()
        .or_else(root_near_exe)
        .or_else(root_from_build_tree)
}

fn gateway_is_listening() -> bool {
    port_is_listening(env_port("CERIOUS_BACKEND_PORT", 8000))
}

fn simulex_is_required() -> bool {
    std::env::var("CERIOUS_EXECUTION_DESTINATION")
        .map(|destination| destination.eq_ignore_ascii_case("simulex"))
        .unwrap_or(true)
}

fn simulex_is_listening() -> bool {
    !simulex_is_required() || port_is_listening(env_port("SIMULEX_HTTP_PORT", 8011))
}

fn services_are_listening() -> bool {
    gateway_is_listening() && simulex_is_listening()
}

fn start_local_services(root: &Path) {
    if services_are_listening() {
        return;
    }

    let script = root.join("Start-CeriousApp.ps1");
    if !script.exists() {
        eprintln!("Cerious service launcher not found: {}", script.display());
        return;
    }

    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script)
        .arg("-HostOnly")
        .current_dir(root);

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    match command.spawn() {
        Ok(mut child) => {
            let deadline = Instant::now() + Duration::from_secs(90);
            while Instant::now() < deadline {
                if services_are_listening() {
                    return;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    if !status.success() {
                        eprintln!("Cerious service launcher exited with {status}");
                    }
                    return;
                }
                thread::sleep(Duration::from_millis(500));
            }
        }
        Err(err) => eprintln!("Failed to launch Cerious local services: {err}"),
    }
}

fn run_startup_service() {
    loop {
        if !services_are_listening() {
            if let Some(root) = repo_root() {
                start_local_services(&root);
            } else {
                eprintln!("Cerious startup service could not locate the local service root");
            }
            thread::sleep(Duration::from_secs(20));
        } else {
            thread::sleep(Duration::from_secs(15));
        }
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--startup-service") {
        run_startup_service();
        return;
    }

    tauri::Builder::default()
        .setup(|_| {
            if let Some(root) = repo_root() {
                start_local_services(&root);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cerious Systems desktop client");
}
