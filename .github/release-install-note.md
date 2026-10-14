### ⬇️ Which file should I download?

- 🍏 **Apple Silicon Mac** (M1, M2, M3, M4…) → the file ending in **`_aarch64.dmg`**
- 💻 **Intel Mac** → the file ending in **`_x64.dmg`**

Not sure which one you have? Apple menu → **About This Mac**: "Chip: Apple M…" is Apple Silicon, "Processor: Intel…" is Intel.

Updates then arrive by themselves, built for your Mac. On Intel Macs the wake word is not available; everything else is the same.

### ⚠️ First launch

The app is signed (self-signed certificate) but **not notarized**: the first time, **right-click → Open** (or run `xattr -cr "/Applications/Flight Deck.app"`) to get past Gatekeeper.
