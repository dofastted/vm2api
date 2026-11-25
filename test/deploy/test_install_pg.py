"""Behavioral tests for PostgreSQL install.sh, install-pg.sh, and replace-db-to-pg.sh flows."""

import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALLER = REPO_ROOT / "deploy" / "install.sh"
INSTALL_PG = REPO_ROOT / "deploy" / "install-pg.sh"
REPLACE_PG = REPO_ROOT / "deploy" / "replace-db-to-pg.sh"

DEFINITIONS, DISPATCH, _ = INSTALLER.read_text(encoding="utf-8").partition('\nCOMMAND="install"\n')
if not DISPATCH:
    raise RuntimeError("Installer command dispatch marker not found")


def run_defs(body: str, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.update(extra_env or {})
    return subprocess.run(
        ["bash", "-c", DEFINITIONS + "\n" + body],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )


def make_exe(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class InstallPgEnvAndComposeTests(unittest.TestCase):
    def test_env_set_preserves_query_ampersands_and_special_chars(self):
        with tempfile.TemporaryDirectory() as tmp:
            envf = Path(tmp) / ".env"
            envf.write_text("DATABASE_URL=old\nKEEP=1\n", encoding="utf-8")
            dsn = "postgresql://vm2api:p@ss&w|rd@db.example.com:5432/vm2api?sslmode=require&connect_timeout=10"
            res = run_defs(
                f'INSTALL_DIR="{tmp}"\nenv_set DATABASE_URL "$TEST_DSN"\nenv_get DATABASE_URL\n',
                extra_env={"TEST_DSN": dsn},
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), dsn)
            self.assertIn("KEEP=1", envf.read_text(encoding="utf-8"))

    def test_sqlite_upgrade_starts_only_vm2api_with_no_deps(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".env.example").write_text("VM2API_DB_DRIVER=\nPORT=8787\n", encoding="utf-8")
            (Path(tmp) / "data").mkdir()
            (Path(tmp) / "data" / "kin.db").write_text("sqlite", encoding="utf-8")
            trace = Path(tmp) / "compose.log"
            body = f"""
INSTALL_DIR="{tmp}"
HOST_ARCH=amd64
prepare_crag_host() {{ :; }}
prepare_docker_crag_apparmor() {{ :; }}
resolve_local_db_ports() {{ :; }}
wait_health() {{ :; }}
verify_db_runtime() {{ :; }}
refresh_slot_services() {{ :; }}
compose() {{ echo "$*" >> "{trace}"; return 0; }}
ensure_env
start_stack
"""
            res = run_defs(body)
            self.assertEqual(res.returncode, 0, res.stderr)
            calls = trace.read_text(encoding="utf-8").splitlines()
            self.assertEqual(calls, ["pull vm2api", "up -d --no-deps vm2api"])
            self.assertIn("VM2API_DB_DRIVER=sqlite", (Path(tmp) / ".env").read_text(encoding="utf-8"))

    def test_external_database_url_and_no_redis_skip_local_containers(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".env.example").write_text("PORT=8787\n", encoding="utf-8")
            trace = Path(tmp) / "compose.log"
            body = f"""
INSTALL_DIR="{tmp}"
HOST_ARCH=amd64
DATABASE_URL_ARG="postgresql://u:p@cloud.example.com:5432/vm2api?sslmode=require&app=vm2api"
NO_REDIS=1
prepare_crag_host() {{ :; }}
prepare_docker_crag_apparmor() {{ :; }}
resolve_local_db_ports() {{ :; }}
wait_health() {{ :; }}
verify_db_runtime() {{ :; }}
refresh_slot_services() {{ :; }}
compose() {{ echo "$*" >> "{trace}"; return 0; }}
ensure_env
start_stack
"""
            res = run_defs(body)
            self.assertEqual(res.returncode, 0, res.stderr)
            calls = trace.read_text(encoding="utf-8").splitlines()
            self.assertEqual(calls, ["pull vm2api", "up -d --no-deps vm2api"])
            env_text = (Path(tmp) / ".env").read_text(encoding="utf-8")
            self.assertIn("VM2API_DB_DRIVER=postgres", env_text)
            self.assertIn("VM2API_REDIS_DISABLED=1", env_text)
            self.assertIn("sslmode=require&app=vm2api", env_text)

    def test_local_pg_with_no_redis_starts_only_postgres_and_vm2api_no_deps(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".env.example").write_text("PORT=8787\n", encoding="utf-8")
            trace = Path(tmp) / "compose.log"
            body = f"""
INSTALL_DIR="{tmp}"
HOST_ARCH=amd64
NO_REDIS=1
prepare_crag_host() {{ :; }}
prepare_docker_crag_apparmor() {{ :; }}
resolve_local_db_ports() {{ :; }}
wait_local_service_ready() {{ echo "wait:$1" >> "{trace}"; return 0; }}
wait_health() {{ :; }}
verify_db_runtime() {{ :; }}
refresh_slot_services() {{ :; }}
compose() {{ echo "$*" >> "{trace}"; return 0; }}
ensure_env
start_stack
"""
            res = run_defs(body)
            self.assertEqual(res.returncode, 0, res.stderr)
            calls = trace.read_text(encoding="utf-8").splitlines()
            self.assertEqual(
                calls,
                [
                    "pull postgres vm2api",
                    "up -d postgres",
                    "wait:postgres",
                    "up -d --no-deps vm2api",
                ],
            )

    def test_auto_migrate_defers_external_dsn_during_upgrade_to_protect_existing_sqlite(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".env.example").write_text("PORT=8787\n", encoding="utf-8")
            (Path(tmp) / "data").mkdir()
            (Path(tmp) / "data" / "kin.db").write_text("sqlite", encoding="utf-8")
            body = f"""
INSTALL_DIR="{tmp}"
AUTO_MIGRATE=1
DATABASE_URL_ARG="postgresql://u:p@cloud.example.com:5432/vm2api?sslmode=require"
ensure_env
"""
            res = run_defs(body)
            self.assertEqual(res.returncode, 0, res.stderr)
            env_text = (Path(tmp) / ".env").read_text(encoding="utf-8")
            self.assertIn("VM2API_DB_DRIVER=sqlite", env_text)
            self.assertNotIn("DATABASE_URL=postgresql://", env_text)

    def test_local_data_wires_docker_compose_local_yml(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".env.example").write_text("PORT=8787\n", encoding="utf-8")
            (Path(tmp) / "docker-compose.local.yml").write_text("services: {}\n", encoding="utf-8")
            body = f"""
INSTALL_DIR="{tmp}"
LOCAL_DATA=1
PG_DATA_DIR_ARG="/mnt/data/pg"
ensure_env
"""
            res = run_defs(body)
            self.assertEqual(res.returncode, 0, res.stderr)
            env_text = (Path(tmp) / ".env").read_text(encoding="utf-8")
            self.assertIn("COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml", env_text)
            self.assertIn("VM2API_PG_DATA_DIR=/mnt/data/pg", env_text)


class InstallPgWrapperRoutingTests(unittest.TestCase):
    def run_wrapper(self, setup_dir: Path, extra_args: list[str]) -> list[str]:
        with tempfile.TemporaryDirectory() as wrapper_dir:
            wdir = Path(wrapper_dir)
            shutil.copy2(INSTALL_PG, wdir / "install-pg.sh")
            out_file = wdir / "invoked.txt"
            make_exe(
                wdir / "install.sh",
                f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "{out_file}"\n',
            )
            res = subprocess.run(
                ["bash", str(wdir / "install-pg.sh"), "--dir", str(setup_dir), *extra_args],
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            return out_file.read_text(encoding="utf-8").splitlines()

    def test_routes_fresh_existing_sqlite_systemd_and_maintenance_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            # 1. Fresh host -> install --db postgres
            self.assertEqual(
                self.run_wrapper(d, ["--no-redis"]),
                ["install", "--db", "postgres", "--dir", str(d), "--no-redis"],
            )
            # 2. Existing SQLite systemd host (no docker-compose.yml) -> db-migrate
            (d / "data").mkdir()
            (d / "data" / "kin.db").write_text("sqlite", encoding="utf-8")
            self.assertEqual(
                self.run_wrapper(d, ["--yes"]),
                ["db-migrate", "--dir", str(d), "--yes"],
            )
            # 3. Existing SQLite Docker Compose host -> upgrade --auto-migrate
            (d / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
            self.assertEqual(
                self.run_wrapper(d, ["--yes"]),
                ["upgrade", "--auto-migrate", "--dir", str(d), "--yes"],
            )
            # 4. Already migrated PostgreSQL Docker host -> upgrade --db postgres
            (d / ".env").write_text("VM2API_DB_DRIVER=postgres\n", encoding="utf-8")
            self.assertEqual(
                self.run_wrapper(d, []),
                ["upgrade", "--db", "postgres", "--dir", str(d)],
            )
            # 5. Rollback & status
            self.assertEqual(self.run_wrapper(d, ["--rollback"]), ["db-rollback", "--dir", str(d)])
            self.assertEqual(self.run_wrapper(d, ["--status"]), ["db-status", "--dir", str(d)])
            self.assertEqual(
                self.run_wrapper(d, ["--check-deps"]),
                ["db-migrate", "--dir", str(d), "--check-deps"],
            )
            self.assertEqual(
                self.run_wrapper(d, ["--preflight"]),
                ["db-migrate", "--dir", str(d), "--preflight"],
            )

    def test_routes_systemd_host_with_leftover_docker_compose_to_db_migrate(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "app"
            fake_bin = Path(tmp) / "bin"
            wrapper_dir = Path(tmp) / "wrapper"
            (d / "data").mkdir(parents=True)
            (d / "data" / "kin.db").write_text("sqlite", encoding="utf-8")
            # Leftover docker-compose.yml co-existing on a live systemd/overlay host
            (d / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
            fake_bin.mkdir()
            wrapper_dir.mkdir()

            make_exe(
                fake_bin / "systemctl",
                "#!/usr/bin/env bash\nif [ \"$1\" = \"is-active\" ] || [ \"$1\" = \"is-enabled\" ]; then exit 0; fi\nexit 0\n",
            )
            make_exe(
                fake_bin / "docker",
                "#!/usr/bin/env bash\n# Only slot containers running, no vm2api control container\necho 'kin-01'\n",
            )
            shutil.copy2(INSTALL_PG, wrapper_dir / "install-pg.sh")
            out_file = wrapper_dir / "invoked.txt"
            make_exe(
                wrapper_dir / "install.sh",
                f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "{out_file}"\n',
            )
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env.get('PATH', '')}"
            env["VM2API_SYSTEMD_DROPIN_DIR"] = str(Path(tmp) / "dropin")

            # Unmigrated SQLite on systemd + leftover docker-compose.yml -> MUST route to db-migrate (not Docker upgrade!)
            res = subprocess.run(
                ["bash", str(wrapper_dir / "install-pg.sh"), "--dir", str(d), "--yes"],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(out_file.read_text(encoding="utf-8").splitlines(), ["db-migrate", "--dir", str(d), "--yes"])

            # Once migrated via .env.postgres -> routes to db-status (never Docker upgrade!)
            (d / ".env.postgres").write_text("VM2API_DB_DRIVER=postgres\n", encoding="utf-8")
            res2 = subprocess.run(
                ["bash", str(wrapper_dir / "install-pg.sh"), "--dir", str(d)],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(res2.returncode, 0, res2.stderr)
            self.assertEqual(out_file.read_text(encoding="utf-8").splitlines(), ["db-status", "--dir", str(d)])


class ReplaceDbToPgPreflightTests(unittest.TestCase):
    def test_systemd_missing_pg_npm_deps_aborts_before_stopping_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            fake_bin = Path(tmp) / "bin"
            (root / "src" / "lib" / "db" / "pg").mkdir(parents=True)
            (root / "src" / "lib" / "db" / "pg" / "config.mjs").write_text("export {}\n", encoding="utf-8")
            (root / "data").mkdir(parents=True)
            (root / "data" / "kin.db").write_text("sqlite", encoding="utf-8")
            (root / "package.json").write_text('{"name":"vm2api","type":"module"}\n', encoding="utf-8")
            fake_bin.mkdir()

            stop_log = Path(tmp) / "systemctl.log"
            make_exe(fake_bin / "systemctl", f'#!/usr/bin/env bash\necho "$*" >> "{stop_log}"\nexit 0\n')
            for tool in ("curl", "openssl", "python3", "psql", "pg_dump", "pg_isready"):
                make_exe(fake_bin / tool, "#!/usr/bin/env bash\nexit 0\n")

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env.get('PATH', '')}"
            res = subprocess.run(
                [
                    "bash",
                    str(REPLACE_PG),
                    "--dir",
                    str(root),
                    "--mode",
                    "systemd",
                    "--database-url",
                    "postgresql://u:p@127.0.0.1:5432/vm2api",
                    "--no-redis",
                    "--no-install-deps",
                    "--yes",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("pg / ioredis", res.stderr + res.stdout)
            calls = stop_log.read_text(encoding="utf-8").splitlines() if stop_log.exists() else []
            mutating = [c for c in calls if c.split()[:1] in (["stop"], ["start"], ["restart"], ["daemon-reload"])]
            self.assertEqual(mutating, [], f"must never mutate systemd service when preflight fails: {mutating}")

    def test_systemd_missing_migrator_script_aborts_before_stopping_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            fake_bin = Path(tmp) / "bin"
            isolated_script = Path(tmp) / "replace-db-to-pg.sh"
            shutil.copy2(REPLACE_PG, isolated_script)
            (root / "src" / "lib" / "db" / "pg").mkdir(parents=True)
            (root / "src" / "lib" / "db" / "pg" / "config.mjs").write_text("export {}\n", encoding="utf-8")
            (root / "data").mkdir(parents=True)
            (root / "data" / "kin.db").write_text("sqlite", encoding="utf-8")
            fake_bin.mkdir()

            stop_log = Path(tmp) / "systemctl.log"
            make_exe(fake_bin / "systemctl", f'#!/usr/bin/env bash\necho "$*" >> "{stop_log}"\nexit 0\n')
            for tool in ("curl", "openssl", "python3", "psql", "pg_dump", "pg_isready"):
                make_exe(fake_bin / tool, "#!/usr/bin/env bash\nexit 0\n")

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env.get('PATH', '')}"
            res = subprocess.run(
                [
                    "bash",
                    str(isolated_script),
                    "--dir",
                    str(root),
                    "--mode",
                    "systemd",
                    "--database-url",
                    "postgresql://u:p@127.0.0.1:5432/vm2api",
                    "--no-redis",
                    "--no-install-deps",
                    "--yes",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("migrate-sqlite-to-pg.mjs", res.stderr + res.stdout)
            calls = stop_log.read_text(encoding="utf-8").splitlines() if stop_log.exists() else []
            mutating = [c for c in calls if c.split()[:1] in (["stop"], ["start"], ["restart"], ["daemon-reload"])]
            self.assertEqual(mutating, [], f"must never mutate systemd service when migrator script is missing: {mutating}")

    def test_systemd_effective_env_reads_strangler_port_and_db_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            fake_bin = Path(tmp) / "bin"
            (root / "data").mkdir(parents=True)
            custom_db = root / "data" / "custom-kin.db"
            custom_db.write_text("sqlite", encoding="utf-8")
            # Stale .env has PORT=8787, while systemd strangler.conf overrides PORT=8788 & KIN_DB_PATH
            (root / ".env").write_text("PORT=8787\nVM2API_API_KEY=old-key\n", encoding="utf-8")
            fake_bin.mkdir()

            make_exe(
                fake_bin / "systemctl",
                f"""#!/usr/bin/env bash
if [ "$1" = "show" ]; then
  if [[ "$*" == *"--property=Environment "* ]] || [[ "$*" == *"--property=Environment"* && "$*" != *"EnvironmentFiles"* ]]; then
    echo "PORT=8788 HOST=127.0.0.1 KIN_API_KEY=real-systemd-key KIN_DB_PATH={custom_db}"
  fi
  exit 0
fi
exit 0
""",
            )
            curl_log = Path(tmp) / "curl.log"
            make_exe(fake_bin / "curl", f'#!/usr/bin/env bash\necho "$*" >> "{curl_log}"\nexit 0\n')
            make_exe(fake_bin / "docker", "#!/usr/bin/env bash\nexit 0\n")

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env.get('PATH', '')}"
            res = subprocess.run(
                ["bash", str(REPLACE_PG), "--dir", str(root), "--mode", "systemd", "--status"],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertIn(str(custom_db), res.stdout)
            self.assertIn("http://127.0.0.1:8788/health", res.stdout)
            self.assertIn("127.0.0.1:8788/health", curl_log.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
