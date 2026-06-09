import { execFileSync } from "node:child_process";

const arch = dockerArch() || processArch();
const targets = {
  amd64: "x86_64-linux-musl",
  x64: "x86_64-linux-musl",
  arm64: "aarch64-linux-musl",
  aarch64: "aarch64-linux-musl"
};
const target = process.env.SOE_NATIVE_LINUX_TARGET || targets[arch];

if (!target) {
  throw new Error(`Unsupported Linux native target architecture: ${arch}`);
}

execFileSync("zig", ["build", "--release=small", `-Dtarget=${target}`], { stdio: "inherit" });

function dockerArch() {
  try {
    return execFileSync("docker", ["version", "--format", "{{.Server.Arch}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function processArch() {
  return process.arch === "x64" ? "amd64" : process.arch;
}
