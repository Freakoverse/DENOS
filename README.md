# DENOS

<p align="center">
  <img src="DENOS logo.png" width="128" height="128" alt="DENOS Logo">
</p>

<p align="center">
  <strong>Nostr Signer, Payment System, and ID Manager</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#download">Download</a> •
  <a href="#building-from-source">Build</a> •
  <a href="#license">License</a>
</p>

---

DENOS is a tool for managing your Nostr identities, signing events, and pay or receive network currencies and (soon) traditional state currencies.

## Features

- **Nostr Signer** — Manage keys, sign events, and connect to relays
- **Bitcoin Wallet** — secp256k1 wallet with Silent Payments and multi-sig support
- **eCash** — Cashu-based eCash wallet with a focus on nut zaps
- **Identity Manager** — DNN-based decentralized identity management
- **QR Scanner** — Built-in QR code scanner and generator
- **Cross-Platform** — Windows, macOS, and Linux

## Download

Pre-built binaries are available on the Releases page:

| Platform | Format |
|----------|--------|
| Windows | `.msi` installer |
| Linux (Ubuntu/Debian/Zorin) | `.deb` package |
| Linux (Fedora/RHEL) | `.rpm` package |
| Linux (Universal) | `.AppImage` portable |

## Building from Source

### Prerequisites (All Platforms)

- [Node.js](https://nodejs.org/) v18+ and npm
- [Rust](https://rustup.rs/) (latest stable)

### Windows

**Additional prerequisites:**
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11)

```bash
# Clone and install dependencies
git clone <repository>
cd denos
npm install

# Development mode
npx tauri dev

# Build installer (Windows example: .msi)
npx tauri build
```

Output: `src-tauri/target/release/bundle/msi/DENOS_0.1.0_x64_en-US.msi`

---

### Linux

**Additional prerequisites (Debian/Ubuntu/Zorin):**

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libfuse2 \
  libjavascriptcoregtk-4.1-dev \
  libsoup-3.0-dev
```

**Additional prerequisites (Arch/CachyOS):**

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  base-devel \
  curl \
  wget \
  file \
  openssl \
  libayatana-appindicator \
  librsvg \
  fuse2
```

**Additional prerequisites (Fedora):**

```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl \
  wget \
  file \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  fuse-libs
```

**Build:**

```bash
# Clone and install dependencies
git clone https://github.com/user/denos.git
cd denos
npm install

# Generate proper icons (required once)
npx tauri icon "DENOS logo.png"

# Development mode
npx tauri dev

# Build all Linux formats
npx tauri build
```

Output:
- `src-tauri/target/release/bundle/deb/DENOS_0.1.0_amd64.deb`
- `src-tauri/target/release/bundle/rpm/DENOS-0.1.0-1.x86_64.rpm`
- `src-tauri/target/release/bundle/appimage/DENOS_0.1.0_amd64.AppImage`

> **Note:** If the AppImage build fails with `failed to run linuxdeploy`, ensure the desktop template has Unix line endings: `sed -i 's/\r$//' src-tauri/denos.desktop.template`

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS 4, Framer Motion
- **Backend:** Rust, Tauri v2
- **Nostr:** nostr-tools, nostr-sdk
- **Bitcoin:** bitcoinjs-lib, secp256k1
- **eCash:** cashu-ts (Cashu protocol)
- **State:** Zustand

## Project Structure

```
DENOS/
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── hooks/              # Custom React hooks
│   ├── lib/                # Utilities
│   └── services/           # Nostr, Bitcoin, eCash services
├── src-tauri/              # Rust backend (Tauri)
│   ├── src/                # Rust source code
│   ├── icons/              # App icons (all platforms)
│   ├── capabilities/       # Tauri permissions
│   └── tauri.conf.json     # Tauri configuration
├── public/                 # Static assets
└── package.json
```

## Supported NIPs

- [x] **NIP-01** — Basic protocol (event signing, relay communication)
- [x] **NIP-02** — Follow list (kind:3 contact list)
- [x] **NIP-04** — Encrypted direct messages (legacy, fallback)
- [x] **NIP-05** — DNS-based identity verification
- [x] **NIP-06** — Key derivation from mnemonic seed phrase (BIP-39)
- [x] **NIP-19** — bech32-encoded entities (npub, nsec, naddr)
- [x] **NIP-44** — Versioned encryption (primary encryption method)
- [x] **NIP-46** — Nostr Connect (remote signer protocol)
- [x] **NIP-60** — Cashu wallet state backup (encrypted to self)
- [x] **NIP-61** — Nut zaps (Cashu ecash zaps via Nostr, with P2PK locking)
- [x] **NIP-87** — Cashu mint discovery via Nostr events
- [x] **NIP-PC55** — Local signer protocol (alternative to NIP-46)
- [x] **NIP-UPV2** — Username & Password version 2 (alternative to NIP-46)
- [x] **NIP-DN** — Decentralized short human readable and memorable IDs
- [ ] **NIP-NSP** — Nostr Silent Payments to conveniently receive payments privately from various networks
- [ ] **NIP-POS** — Point of Sale system for merchants to sign off on sales and receive network or traditional state currency payments

### Other Protocols

- [x] **DNN** — Decentralized Nostr Naming (custom identity system)

## License

[MIT](src-tauri/LICENSE)
