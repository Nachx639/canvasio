# build/

Resources used by electron-builder when packaging CANVASIO.

## entitlements.mac.plist
macOS entitlements (JIT, unsigned executable memory, library validation,
microphone/audio input, network client). Only enforced when the app is code
signed with a hardened runtime.

## Unsigned local/personal builds (current default)
`electron-builder.yml` sets `mac.identity: null` and `mac.hardenedRuntime: false`.

This produces an UNSIGNED build. It avoids the macOS Gatekeeper "App is damaged
and can't be opened" error that unsigned + hardened-runtime builds trigger on
other Macs. If macOS still quarantines a downloaded build, clear the flag with:

```sh
xattr -dr com.apple.quarantine "/Applications/CANVASIO.app"
```

## Public / notarized distribution
To distribute publicly, set a real Developer ID in `mac.identity`, re-enable
`mac.hardenedRuntime: true`, and configure notarization. The entitlements file
above is already compatible with a hardened runtime.
