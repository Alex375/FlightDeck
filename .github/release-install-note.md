### ⬇️ Which file should I download?

- 🍏 **Apple Silicon Mac** (M1, M2, M3, M4…) → the file ending in **`_aarch64.dmg`**
- 💻 **Intel Mac** → the file ending in **`_x64.dmg`**
- 🐧 **Linux** (x86_64, Ubuntu 22.04 or newer) → **`_amd64.deb`** for Debian/Ubuntu, or **`_amd64.AppImage`** for any other distribution

Not sure which one you have? Apple menu → **About This Mac**: "Chip: Apple M…" is Apple Silicon, "Processor: Intel…" is Intel.

Updates then arrive by themselves, built for your computer. On Intel Macs the wake word is not available; everything else is the same.

### 🐧 On Linux

- **.deb**: `sudo apt install ./Flight.Deck_<version>_amd64.deb`. Updates install themselves and ask for your password.
- **AppImage**: `chmod +x Flight.Deck_amd64.AppImage`, then run it. It needs FUSE's `fusermount3` (package `fuse3`, already installed on Ubuntu 22.04 and newer — `libfuse2` is not needed). Keep it in a folder you own: it updates by rewriting its own file.
- Staying signed in to TOSSE and saving an OpenAI key need a keyring (GNOME Keyring, KWallet…).
- Not available on Linux: the wake word, keeping the computer awake, and "Open in terminal".

### ⚠️ First launch on a Mac

The app is signed (self-signed certificate) but **not notarized**: the first time, **right-click → Open** (or run `xattr -cr "/Applications/Flight Deck.app"`) to get past Gatekeeper.
