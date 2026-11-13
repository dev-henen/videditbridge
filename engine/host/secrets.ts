import type { ProviderId } from "./models.js";

/**
 * The AI providers' API keys in the system's own keychain: Windows Credential Manager, the macOS
 * Keychain, or the Secret Service on Linux (GNOME Keyring, KWallet), through @napi-rs/keyring. One
 * entry per provider. Where there is no keychain (a Linux machine without a Secret Service, say), the
 * settings file keeps the keys instead and the Settings tab says so.
 */

/** $AVE_KEYCHAIN_SERVICE (tests), or the app's entry in the keychain. */
const service = () => process.env.AVE_KEYCHAIN_SERVICE || "ai-video-editor";
/** The keychain account of each provider's key (Anthropic's keeps the name it always had). */
const account = (provider: ProviderId) => `${provider}-api-key`;

type Entry = { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean };
type EntryClass = new (service: string, account: string) => Entry;

let store: Promise<EntryClass | undefined> | undefined;
const entries = new Map<ProviderId, Entry>();

/** The keychain, or undefined when this system has none to use. */
function keychain(): Promise<EntryClass | undefined> {
  store ??= (async () => {
    try {
      const { Entry } = (await import("@napi-rs/keyring")) as unknown as { Entry: EntryClass };
      // Reading proves the store answers (a Linux desktop without a Secret Service throws here).
      new Entry(service(), account("anthropic")).getPassword();
      return Entry;
    } catch {
      return undefined;
    }
  })();
  return store;
}

async function entryOf(provider: ProviderId): Promise<Entry | undefined> {
  const Entry = await keychain();
  if (!Entry) return undefined;
  let e = entries.get(provider);
  if (!e) entries.set(provider, (e = new Entry(service(), account(provider))));
  return e;
}

/** Whether keys go to the system keychain on this machine. */
export const hasKeychain = async () => !!(await keychain());

/** A provider's key stored in the keychain, if any. */
export async function readKeychainKey(provider: ProviderId = "anthropic"): Promise<string | undefined> {
  try {
    return (await entryOf(provider))?.getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Store a provider's key in the keychain (or remove it with undefined). False when there is no keychain. */
export async function writeKeychainKey(key: string | undefined, provider: ProviderId = "anthropic"): Promise<boolean> {
  const e = await entryOf(provider);
  if (!e) return false;
  try {
    if (key) e.setPassword(key);
    else {
      try {
        e.deletePassword();
      } catch {
        // nothing stored
      }
    }
    return true;
  } catch {
    return false;
  }
}
