import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const targets = [
  ["linux", "amd64", "soe-webrtc-x86_64-linux"],
  ["linux", "arm64", "soe-webrtc-aarch64-linux"],
  ["darwin", "amd64", "soe-webrtc-x86_64-macos"],
  ["darwin", "arm64", "soe-webrtc-aarch64-macos"],
  ["windows", "amd64", "soe-webrtc-x86_64-windows.exe"],
  ["windows", "arm64", "soe-webrtc-aarch64-windows.exe"]
];

const mode = process.argv[2] || "local";
const outDir = join(process.cwd(), "dist", "webrtc");
mkdirSync(outDir, { recursive: true });

if (mode === "all") {
  for (const [goos, goarch, asset] of targets) build(goos, goarch, join(outDir, asset));
} else {
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  const target = targets.find((item) => item[0] === goos && item[1] === goarch);
  if (!target) throw new Error(`Unsupported WebRTC target: ${goos}/${goarch}`);
  build(target[0], target[1], join(outDir, process.platform === "win32" ? "soe-webrtc.exe" : "soe-webrtc"));
}

function build(goos, goarch, output) {
  rmSync(output, { force: true });
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", output, "./native/webrtc"], {
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: goos,
      GOARCH: goarch
    },
    stdio: "inherit"
  });
}
