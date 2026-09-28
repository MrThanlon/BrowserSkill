#!/usr/bin/env node
/**
 * install-bsk.ts — install the bsk CLI from GitHub Releases.
 * 
 * Cross-platform installer for macOS, Linux, and Windows.
 * Can be used as a postinstall script or standalone.
 * 
 * Environment variables:
 *   BSK_REPO         GitHub owner/repo (default: Tencent/BrowserSkill)
 *   BSK_VERSION      Pin CLI version (default: latest from version.json)
 *   BSK_INSTALL_DIR  Install directory (default: $HOME/.local/bin on Unix, $HOME\.local\bin on Windows)
 */

import { execSync, execFileSync } from "node:child_process";
import { 
  existsSync, 
  readFileSync, 
  writeFileSync, 
  mkdirSync, 
  chmodSync,
  appendFileSync
} from "node:fs";
import { join, dirname } from "node:path";
import { createWriteStream, createReadStream } from "node:fs";
import { promisify } from "node:util";
import { pipeline } from "node:stream";
import https from "node:https";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const pipelineAsync = promisify(pipeline);

interface Platform {
  osId: "darwin" | "linux" | "windows";
  archId: "arm64" | "x64";
  triple: string;
  platformKey: string;
}

interface Manifest {
  version: string;
  assets: Record<string, { sha256: string }>;
}

class Installer {
  repo: string;
  installDir: string;
  platform: Platform;
  version?: string;
  manifest?: Manifest;

  constructor() {
    this.repo = process.env.BSK_REPO || "Tencent/BrowserSkill";
    this.platform = this.detectPlatform();
    this.installDir = this.resolveInstallDir();
  }

  log(message: string) {
    console.error(`==> ${message}`);
  }

  error(message: string): never {
    console.error(`error: ${message}`);
    process.exit(1);
  }

  detectPlatform(): Platform {
    const osType = os.type();
    const arch = os.arch();

    let osId: "darwin" | "linux" | "windows";
    if (osType === "Darwin") {
      osId = "darwin";
    } else if (osType === "Linux") {
      osId = "linux";
    } else if (osType === "Windows_NT") {
      osId = "windows";
    } else {
      this.error(`unsupported OS: ${osType} (macOS, Linux, and Windows only)`);
    }

    let archId: "arm64" | "x64";
    if (arch === "arm64" || arch === "aarch64") {
      archId = "arm64";
    } else if (arch === "x64" || arch === "x86_64") {
      archId = "x64";
    } else {
      this.error(`unsupported architecture: ${arch}`);
    }

    let triple: string;
    const platformKey = `${osId}-${archId}`;
    
    switch (platformKey) {
      case "darwin-arm64":
        triple = "aarch64-apple-darwin";
        break;
      case "darwin-x64":
        triple = "x86_64-apple-darwin";
        break;
      case "linux-arm64":
        triple = "aarch64-unknown-linux-musl";
        break;
      case "linux-x64":
        triple = "x86_64-unknown-linux-musl";
        break;
      case "windows-x64":
        triple = "x86_64-pc-windows-msvc";
        break;
      case "windows-arm64":
        triple = "aarch64-pc-windows-msvc";
        break;
      default:
        this.error(`unsupported platform: ${platformKey}`);
    }

    return { osId, archId, triple, platformKey };
  }

  resolveInstallDir(): string {
    if (process.env.BSK_INSTALL_DIR) {
      return process.env.BSK_INSTALL_DIR;
    }
    const home = os.homedir();
    return this.platform.osId === "windows"
      ? join(home, ".local", "bin")
      : join(home, ".local", "bin");
  }

  async downloadFile(url: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(destination);
      https.get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.destroy();
          this.downloadFile(response.headers.location, destination).then(resolve).catch(reject);
          return;
        }
        pipelineAsync(response, file).then(resolve).catch(reject);
      }).on("error", reject);
    });
  }

  async computeSha256(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  async fetchVersion(): Promise<void> {
    if (process.env.BSK_VERSION) {
      this.version = process.env.BSK_VERSION.replace(/^v/, "");
      this.log(`using pinned version ${this.version}`);
      
      const tag = `cli-v${this.version}`;
      const manifestUrl = `https://raw.githubusercontent.com/${this.repo}/${tag}/version.json`;
      try {
        const manifestContent = await this.fetchUrl(manifestUrl);
        this.manifest = JSON.parse(manifestContent);
      } catch (e) {
        this.log("warning: could not fetch version.json for pinned version");
      }
    } else {
      const manifestUrl = `https://raw.githubusercontent.com/${this.repo}/main/version.json`;
      this.log(`fetching latest version from ${manifestUrl}`);
      
      try {
        const manifestContent = await this.fetchUrl(manifestUrl);
        this.manifest = JSON.parse(manifestContent);
        this.version = this.manifest.version;
        if (!this.version) {
          this.error("could not parse version from version.json");
        }
        this.log(`latest version is ${this.version}`);
      } catch (e) {
        this.error(`could not fetch version.json: ${e}`);
      }
    }
  }

  private async fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        let data = "";
        response.on("data", (chunk) => data += chunk);
        response.on("end", () => resolve(data));
        response.on("error", reject);
      }).on("error", reject);
    });
  }

  getArchiveName(): string {
    const ext = this.platform.osId === "windows" ? ".zip" : ".tar.gz";
    return `bsk-v${this.version}-${this.platform.triple}${ext}`;
  }

  getDownloadUrl(): string {
    const tag = `cli-v${this.version}`;
    return `https://github.com/${this.repo}/releases/download/${tag}/${this.getArchiveName()}`;
  }

  async extractArchive(archivePath: string, targetDir: string): Promise<string> {
    if (this.platform.osId === "windows") {
      // Extract ZIP
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(targetDir, true);
      return join(targetDir, "bsk.exe");
    } else {
      // Extract tar.gz
      execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: "inherit" });
      return join(targetDir, "bsk");
    }
  }

  async installBinary(source: string, target: string): Promise<void> {
    mkdirSync(dirname(target), { recursive: true });
    
    const sourceContent = readFileSync(source);
    writeFileSync(target, sourceContent);
    
    if (this.platform.osId !== "windows") {
      chmodSync(target, 0o755);
    }
    
    this.log(`installed bsk to ${target}`);
  }

  async ensurePath(): Promise<void> {
    if (this.platform.osId === "windows") {
      this.ensurePathWindows();
    } else {
      this.ensurePathUnix();
    }
  }

  private ensurePathUnix(): void {
    const profiles = [
      join(os.homedir(), ".zshrc"),
      join(os.homedir(), ".bashrc"),
      join(os.homedir(), ".profile"),
    ];

    let added = false;
    for (const profile of profiles) {
      if (!existsSync(profile)) continue;
      
      const content = readFileSync(profile, "utf-8");
      if (content.includes(this.installDir)) continue;

      const pathLine = `export PATH="${this.installDir}:$PATH"`;
      appendFileSync(profile, `\n# Added by bsk install\n${pathLine}\n`);
      this.log(`added ${this.installDir} to PATH in ${profile}`);
      added = true;
    }

    if (!added) {
      this.log(`add ${this.installDir} to your PATH, for example:`);
      console.log(`    export PATH="${this.installDir}:$PATH"`);
      this.log("restart your shell or run: source ~/.zshrc  (or ~/.bashrc)");
    }
  }

  private ensurePathWindows(): void {
    // Add to user PATH via registry or environment variable
    try {
      const currentPath = process.env.PATH || "";
      if (!currentPath.includes(this.installDir)) {
        process.env.PATH = `${this.installDir};${currentPath}`;
        this.log(`placed ${this.installDir} first in session PATH`);
      }
    } catch (e) {
      this.log(`warning: could not update PATH: ${e}`);
    }
  }

  async run(): Promise<void> {
    try {
      this.log(`detecting platform (${this.platform.osId}-${this.platform.archId})`);
      
      await this.fetchVersion();
      
      const archiveName = this.getArchiveName();
      const downloadUrl = this.getDownloadUrl();
      
      const tmpDir = join(os.tmpdir(), `bsk-install-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const archivePath = join(tmpDir, archiveName);
        
        this.log(`downloading ${downloadUrl}`);
        await this.downloadFile(downloadUrl, archivePath);

        // Verify checksum if available
        if (this.manifest?.assets?.[this.platform.platformKey]?.sha256) {
          const expectedSha = this.manifest.assets[this.platform.platformKey].sha256;
          this.log("verifying checksum");
          const actualSha = await this.computeSha256(archivePath);
          
          if (actualSha.toLowerCase() === expectedSha.toLowerCase()) {
            this.log("checksum OK");
          } else {
            this.error(`checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
          }
        } else if (this.manifest) {
          this.log(`warning: no checksum published for ${this.platform.platformKey}`);
        } else {
          this.log("warning: could not fetch version.json; skipping checksum verification");
        }

        this.log(`extracting ${archiveName}`);
        const binaryPath = await this.extractArchive(archivePath, tmpDir);

        const installPath = join(this.installDir, this.platform.osId === "windows" ? "bsk.exe" : "bsk");
        await this.installBinary(binaryPath, installPath);

        await this.ensurePath();

        // Verify installation
        try {
          const version = execSync(`"${installPath}" --version`, { encoding: "utf-8" }).trim();
          this.log(`verified: ${version}`);
        } catch (e) {
          this.log(`warning: could not verify installation: ${e}`);
        }

        this.log("done");
      } finally {
        // Cleanup temp directory
        try {
          execSync(`rm -rf "${tmpDir}"`, { stdio: "ignore" });
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (e) {
      if (typeof e === "object" && e !== null && "message" in e) {
        this.error(String((e as any).message));
      } else {
        this.error(String(e));
      }
    }
  }
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const installer = new Installer();
  installer.run().catch((e) => {
    console.error(`Fatal error: ${e}`);
    process.exit(1);
  });
}

export { Installer };
