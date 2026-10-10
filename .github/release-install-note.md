⬇️ **Which file?** Apple Silicon Mac (M1, M2, M3…) → the `…_aarch64.dmg`. Intel Mac →
the `…_x64.dmg`. Not sure? Apple menu → About This Mac: "Chip: Apple M…" is Apple
Silicon, "Processor: Intel…" is Intel. Updates then arrive by themselves, built for your
Mac. On Intel Macs the wake word is not available; everything else is the same.

⚠️ App signed (self-signed certificate) but **not notarized**: on first launch,
**right-click → Open** (or `xattr -cr /Applications/Flight\ Deck.app`) to get past
Gatekeeper.

ℹ️ On this update, macOS may ask **one last time** for access to your folders
(Desktop/Documents/…) — this is the transition to the stable signature; after that,
the permissions persist from one version to the next.
