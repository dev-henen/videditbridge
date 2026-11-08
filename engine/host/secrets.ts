/**
 * The Anthropic API key in the system's own keychain: Windows Credential Manager, the macOS Keychain,
 * or the Secret Service on Linux (GNOME Keyring, KWallet), through @napi-rs/keyring. Where there is
 * none (a Linux machine without a Secret Service, say), the settings file keeps the key instead and
 * the Settings tab says so.
 */

/** $AVE_KEYCHAIN_SERVICE (tests), or the app's entry in the keychain. */
const service = () => process.env.AVE_KEYCHAIN_SERVICE || "ai-video-editor";
const ACCOUNT = "anthropic-api-key";

type Entry = { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean };

let entry: Promise<Entry | undefined> | undefined;

/** The keychain entry, or undefined when this system has no keychain to use. */
function keychain(): Promise<Entry | undefined> {
  entry ??= (async () => {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      const e = new Entry(service(), ACCOUNT) as Entry;
      // Reading proves the store answers (a Linux desktop without a Secret Service throws here).
      e.getPassword();
      return e;
    } catch {
      return undefined;
    }
  })();
  return entry;
}

/** Whether keys go to the system keychain on this machine. */
export const hasKeychain = async () => !!(await keychain());

/** The key stored in the keychain, if any. */
export async function readKeychainKey(): Promise<string | undefined> {
  try {
    return (await keychain())?.getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Store the key in the keychain (or remove it with undefined). False when there is no keychain. */
export async function writeKeychainKey(key: string | undefined): Promise<boolean> {
  const e = await keychain();
  if (!e) return false;
  try {
    if (key) e.setPassword(key);
    else e.deletePassword();
    return true;
  } catch {
    return false;
  }
}
